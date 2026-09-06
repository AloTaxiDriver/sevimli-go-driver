import { randomBytes } from "crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";
import { onDocumentCreated, onDocumentUpdated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";

initializeApp();

const db = getFirestore();
const messaging = getMessaging();
const auth = getAuth();

const eskizEmail = defineSecret("ESKIZ_EMAIL");
const eskizPassword = defineSecret("ESKIZ_PASSWORD");
const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");

function getDistanceMeters(
  lat1: number, lng1: number, lat2: number, lng2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Buyurtma taklif qilish uchun haydovchining balansi yetarlimi.
// Haydovchi ilovasi `(balance || 0) <= 0` bo'lganda qabul qilishni
// to'sadi (MapScreen.tsx) — shu sabab bu yerdagi chegara AYNAN o'sha,
// aks holda haydovchi ola olmaydigan taklifni olib, navbat behuda
// kutar edi.
function hasEnoughBalanceForOrder(data: FirebaseFirestore.DocumentData): boolean {
  const balance = typeof data.balance === "number" ? data.balance : 0;
  return balance > 0;
}

async function getDispatchSettings(): Promise<{
  radiusMeters: number;
  timeoutSeconds: number;
  maxTotalSeconds: number;
  respectDriverArea: boolean;
}> {
  // Standartlar ATAYLAB shu qiymatlarda: 2000 m qishloq/tuman uchun
  // ham yetarli doira, 10 soniya haydovchi telefonni olishga
  // ulguradigan eng qisqa vaqt, 60 soniya esa mijoz kutishga
  // rozi bo'ladigan chegara (ya'ni ko'pi bilan 6 ta haydovchi).
  // `respectDriverArea` ATAYLAB `false`: haydovchi "Domoy / Ish /
  // Mening hududim" tugmasini bir marta bosgach, buyurtmalar o'sha
  // qotib qolgan nuqta atrofi bilan cheklanardi va u buni ko'pincha
  // bilmasdi ham — 310 metrdagi haydovchi buyurtmasiz qolgan holat
  // shundan chiqqan. Kerak bo'lsa paneldan qayta yoqiladi.
  const FALLBACK = {
    radiusMeters: 2000,
    timeoutSeconds: 10,
    maxTotalSeconds: 60,
    respectDriverArea: false,
  };
  try {
    const doc = await db.collection("settings").doc("dispatch").get();
    const data = doc.data();
    return {
      radiusMeters:
        typeof data?.radiusMeters === "number" ? data.radiusMeters : FALLBACK.radiusMeters,
      timeoutSeconds:
        typeof data?.timeoutSeconds === "number" ? data.timeoutSeconds : FALLBACK.timeoutSeconds,
      maxTotalSeconds:
        typeof data?.maxTotalSeconds === "number" ? data.maxTotalSeconds : FALLBACK.maxTotalSeconds,
      respectDriverArea:
        typeof data?.respectDriverArea === "boolean"
          ? data.respectDriverArea
          : FALLBACK.respectDriverArea,
    };
  } catch {
    return FALLBACK;
  }
}

async function getRadiusConfig(): Promise<{
  homeRadiusKm: number;
  workRadiusKm: number;
  nearbyRadiusKm: number;
}> {
  try {
    const doc = await db.collection("settings").doc("radiusConfig").get();
    const data = doc.data();
    return {
      homeRadiusKm: typeof data?.homeRadiusKm === "number" ? data.homeRadiusKm : 3,
      workRadiusKm: typeof data?.workRadiusKm === "number" ? data.workRadiusKm : 3,
      nearbyRadiusKm: typeof data?.nearbyRadiusKm === "number" ? data.nearbyRadiusKm : 10,
    };
  } catch {
    return { homeRadiusKm: 3, workRadiusKm: 3, nearbyRadiusKm: 10 };
  }
}

// "Domoy" / "Ish" / "Mening hududim" filtri — faol bo'lsa, faqat mos
// radius ichidagi buyurtma ko'rinadi. Rejim yo'q yoki nuqta hali
// saqlanmagan bo'lsa — cheklovsiz (fail open).
// Haydovchi hujjatidagi joylashuv vaqti (millisekundda). Avval AYNAN
// joylashuv vaqti (`locationUpdatedAt` — uni faqat haydovchi ilovasidagi
// joylashuv vazifasi yozadi), topilmasa umumiy `updatedAt`.
function tsMillis(ts: any): number {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function driverLocationMillis(data: FirebaseFirestore.DocumentData): number {
  return tsMillis(data.locationUpdatedAt) || tsMillis(data.updatedAt);
}

/** Haydovchidan OXIRGI MARTA qachon xabar kelgani — ikkala vaqtning
 * YANGIROG'I.
 *
 * MUHIM: bu yuqoridagi `driverLocationMillis` dan ATAYLAB farq qiladi,
 * va ularni almashtirib yuborish jiddiy zarar keltiradi.
 *
 *   * `driverLocationMillis` — "KOORDINATASI yangimi?" degan savolga
 *     javob beradi, shuning uchun `locationUpdatedAt` USTUN turadi:
 *     push tokeni yoki "band" bayrog'i yozilishi koordinatani
 *     yangilamaydi, lekin `updatedAt`ni yangilaydi. Buyurtma
 *     taqsimlashda aynan shu kerak.
 *
 *   * bu funksiya esa BOSHQA savolga javob beradi: "SEANS tirikmi?".
 *     Bu yerda `locationUpdatedAt`ni ustun qo'yish XATO bo'lardi.
 *     Kechagi GPS yozuvi bor haydovchi bugun ishga chiqib "onlayn"
 *     tugmasini bossa, `updatedAt` YANGI, `locationUpdatedAt` esa hamon
 *     KECHAGI bo'ladi — birinchi GPS nuqtasi kelguncha (yerto'lada,
 *     sovuq startda, yoki joylashuvga ruxsat berilmagan telefonda u
 *     umuman kelmaydi). Eskirgan qiymatga qarab uni oflayn qilib
 *     qo'yish haydovchini BUTUN SMENA davomida buyurtmasiz qoldirardi:
 *     ilovada `isOnline` faqat mahalliy holat, va uni hech kim qayta
 *     yozmaydi — haydovchi qo'lda oflayn/onlayn qilmaguncha.
 */
function driverLastSeenMillis(data: FirebaseFirestore.DocumentData): number {
  return Math.max(tsMillis(data.locationUpdatedAt), tsMillis(data.updatedAt));
}

// `isOnline: true` — bu SHUNCHAKI hujjatdagi bayroq, va u ilova
// o'ldirilganda (Android xotira uchun yopdi, haydovchi ro'yxatdan surib
// tashladi, telefon o'chdi) tozalanmay qolib ketadi. Jonli bazada
// 2026-08-17 holatiga ko'ra 33 ta "onlayn" haydovchining 30 tasi bir
// soatdan ko'p vaqt jim edi (ba'zilari 4-5 kun).
//
// Bu dispatch uchun jiddiy: taklif KETMA-KET yuboriladi va har bir
// haydovchi uchun `timeoutSeconds` kutiladi. O'nta "arvoh" haydovchi
// navbatning boshida tursa, mijoz bir necha DAQIQA hech qanday javob
// olmay kutadi — telefonlari umuman jiringlamaydigan haydovchilar
// uchun. Shuning uchun joylashuvi ancha vaqtdan beri yangilanmaganlar
// navbatga umuman qo'shilmaydi.
//
// Chegara ilovadagidan (90 soniya) ataylab KENGROQ: bu yerda xatoning
// narxi kattaroq (haqiqiy haydovchi buyurtmadan mahrum bo'ladi), va
// tunnel/lift kabi qisqa uzilishlar hisobga olinishi kerak.
//
// MUHIM: bu chegara endi CHIQARIB TASHLASH uchun EMAS, faqat NAVBAT
// TARTIBI uchun ishlatiladi. Alo Taxi'da (06.09.2026) jonli jurnal
// ko'rsatdi: bir joyda turgan 3 ta onlayn haydovchidan 2 tasi
// "arvoh" deb chiqarib tashlangan, buyurtma faqat bittasiga taklif
// qilinib, darhol "Ochiq buyurtmalar"ga tushgan.
//
// Harakatsiz turgan telefonda Android joylashuvni TO'PLAB yetkazadi
// (Doze; ba'zi ishlab chiqaruvchilarda foreground service ham
// bo'g'iladi) — ya'ni AYNAN buyurtma kutib turgan haydovchining
// koordinatasi eskiradi. Push esa unga baribir yetib boradi: yuqori
// ustuvorlikdagi FCM xabari uxlab yotgan ilovani ham uyg'otadi.
// Shuning uchun eskirgan koordinata "telefoni jiringlamaydi" degani
// EMAS.
const DRIVER_FRESH_LOCATION_MS = 5 * 60 * 1000;

/** Haydovchiga taklif yuborishning umuman ma'nosi bormi.
 *
 * MUHIM: bu yerda AYNAN `cleanupGhostOnlineDrivers` bilan BIR XIL
 * qoida ishlatiladi. Avval taqsimlash o'zining qat'iyroq (5 daqiqa)
 * chegarasini yuritardi, tozalash vazifasi esa ancha uzoq jimlikni
 * normal deb bilardi — natijada oradagi oraliqda "o'lik hudud"
 * paydo bo'lardi: haydovchi panelda ham, mijoz ilovasida ham onlayn
 * ko'rinadi, lekin unga hech qachon buyurtma taklif qilinmaydi. Va
 * bu holat O'ZI TUZALMAYDI: `isOnline` faqat haydovchi qo'lda qayta
 * yoqqanda yangilanadi.
 *
 * Endi qoida bitta: haydovchi tozalash vazifasi uni oflayn
 * qilmaguncha "yetib boriladigan" hisoblanadi. */
function isDriverStillReachable(
  data: FirebaseFirestore.DocumentData,
  now: number
): boolean {
  const lastSeen = driverLastSeenMillis(data);
  if (lastSeen === 0) return false;
  return now - lastSeen <= GHOST_ONLINE_STALE_MS;
}

// Ketma-ket taklif sikli uchun umumiy vaqt byudjeti. Funksiyaning
// o'z chegarasi 540 soniya — undan xavfsiz masofada to'xtaymiz,
// shunda yakuniy xulosa jurnalga albatta yoziladi.
const DISPATCH_LOOP_BUDGET_MS = 7 * 60 * 1000;

// Haydovchi hali safarda deb hisoblanadigan buyurtma holatlari.
const ACTIVE_ORDER_STATUSES = ["accepted", "arrived", "in_progress"] as const;

function isDriverEligibleForOrder(
  data: FirebaseFirestore.DocumentData,
  pickupLat: number | undefined,
  pickupLng: number | undefined,
  radiusCfg: { homeRadiusKm: number; workRadiusKm: number; nearbyRadiusKm: number }
): boolean {
  const mode = data.activeMode;
  if (!mode) return true;
  if (pickupLat == null || pickupLng == null) return true;

  let refLat: number | undefined;
  let refLng: number | undefined;
  let radiusKm: number;

  if (mode === "home") {
    refLat = data.savedLocations?.home?.lat;
    refLng = data.savedLocations?.home?.lng;
    radiusKm = radiusCfg.homeRadiusKm;
  } else if (mode === "work") {
    refLat = data.savedLocations?.work?.lat;
    refLng = data.savedLocations?.work?.lng;
    radiusKm = radiusCfg.workRadiusKm;
  } else if (mode === "nearby") {
    // MUHIM: "Mening hududim" jonli, harakatlanadigan GPS emas — tugma
    // bosilgan ANIQ paytda saqlangan qat'iy nuqta ("qoziq"). Haydovchi
    // keyin qayerga borsa ham, markaz o'zgarmaydi.
    refLat = data.nearbyAnchor?.lat;
    refLng = data.nearbyAnchor?.lng;
    radiusKm = radiusCfg.nearbyRadiusKm;
  } else {
    return true;
  }

  if (refLat == null || refLng == null) return true;

  const distMeters = getDistanceMeters(pickupLat, pickupLng, refLat, refLng);
  return distMeters <= radiusKm * 1000;
}

// Admin dashboard'ning "Mijozlar uchun bonus" bo'limida sozlanadi
// (settings/bonus hujjati). MUHIM: `maxRedeemPercent` (yo'l narxining
// X%i) o'rniga endi ADMIN QAT'IY BELGILAGAN chegara ishlatiladi —
// yoki so'mda (masalan "bitta buyurtmaga 2000 so'mdan ko'p emas"),
// yoki foizda (`perOrderCapType` shuni tanlaydi).
// `branchId` berilsa, umumiy standart (settings/bonus) USTIGA filialning
// o'z hujjati (settings/bonus_branch_{id}) MAYDONMA-MAYDON qo'yiladi —
// ya'ni filial faqat o'zgartirgan maydonlarini yozadi, qolganlari
// standartdan keladi. (Avval bu yerda "topilmasa standart" deb yozilgan
// edi — u ALMASHTIRISH mantiqini tasvirlardi va endi to'g'ri emas:
// birlashtirishga o'tilgan, izohi esa yangilanmay qolgandi.)
// Shu bilan har bir filial o'z cashback foizini mustaqil belgilay oladi.
// Filial-asosli sozlamani o'qiydi: ADMIN belgilagan umumiy standart
// ustiga filialning o'z qiymatlari qo'yiladi.
//
// MUHIM: filial hujjati globalni BUTUNLAY almashtirmaydi — faqat o'zida
// ANIQ mavjud maydonlarni ustiga yozadi. Avval mantiq boshqacha edi:
// filial hujjati topilsa global umuman o'qilmasdi, va hujjatda yo'q
// maydonlar kod ichidagi zaxira (fallback) qiymatlarga tushardi.
// Natijada dashboard'da filialga BITTA karta saqlangan zahoti (masalan
// faqat haftalik bonus) o'sha filial uchun qolgan hamma sozlama admin
// belgilagan standartdan uzilib, hech kim ko'rsatmagan zaxira raqamlarga
// o'tib ketardi — minimal masofa 5 km dan 2 km ga tushib, soxta
// safarlarga qarshi himoya jimgina zaiflashardi.
async function readBranchScopedSettings(
  baseDocId: string,
  branchId?: string | null
): Promise<FirebaseFirestore.DocumentData | null> {
  const globalDoc = await db.collection("settings").doc(baseDocId).get();
  const globalData = globalDoc.data();
  let branchData: FirebaseFirestore.DocumentData | undefined;
  if (branchId) {
    const branchDoc = await db
      .collection("settings")
      .doc(`${baseDocId}_branch_${branchId}`)
      .get();
    branchData = branchDoc.data();
  }
  if (!globalData && !branchData) return null;
  return { ...(globalData || {}), ...(branchData || {}) };
}

async function getBonusSettings(branchId?: string | null): Promise<{
  earnPercent: number;
  minBalanceToUse: number;
  perOrderCapType: "amount" | "percent";
  perOrderCapValue: number;
}> {
  const fallback = {
    earnPercent: 4,
    minBalanceToUse: 0,
    perOrderCapType: "percent" as const,
    perOrderCapValue: 50,
  };
  try {
    const data = await readBranchScopedSettings("bonus", branchId);
    if (!data) return fallback;
    return {
      earnPercent: typeof data.earnPercent === "number" ? data.earnPercent : fallback.earnPercent,
      minBalanceToUse:
        typeof data.minBalanceToUse === "number" ? data.minBalanceToUse : fallback.minBalanceToUse,
      perOrderCapType: data.perOrderCapType === "amount" ? "amount" : "percent",
      perOrderCapValue:
        typeof data.perOrderCapValue === "number" ? data.perOrderCapValue : fallback.perOrderCapValue,
    };
  } catch {
    return fallback;
  }
}

// MUHIM: "bitta buyurtma uchun bonus chegarasi" (perOrderCap) shu
// yerda ATAYLAB YO'Q.
//
// U buyurtma BERILAYOTGANDA, mijoz ilovasida qo'llanadi
// (E:\sevimli-go-customer\src\utils\firebase.ts,
// computePerOrderBonusCap) — o'sha paytda `bonusUsed` qat'iy
// belgilanadi va mijozga "shuncha kam to'laysiz" deb aytiladi.
//
// Bir muddat u shu yerda ham, safar OXIRIDA qayta qo'llanardi. Bu
// pulni haydovchidan olardi: metr bo'yicha narx taxmindan past chiqsa,
// foizli chegara ham kichrayib, qoplama mijozga allaqachon berilgan
// naqd chegirmadan kam bo'lardi. Chegirmani berib bo'lgandan keyin uni
// qayta hisoblash — uni qaytarib olishga urinish demakdir.
// Tafsilot: onOrderCompletedApplyBonus ichidagi izoh.

// ============================================================
// SAFARNING TO'LIQ QIYMATI — bonus, cashback va komissiya uchun
// YAGONA hisob bazasi.
// ============================================================
// Avval har bir hisob boshqa-boshqa bazadan olinardi va bu chalkashlik
// hamda haqiqiy pul yo'qotishiga olib kelardi:
//   - mijoz ilovasi chegirma chegarasini (price + extrasTotal) dan,
//   - Cloud Function esa faqat `price` dan hisoblardi — natijada mijozga
//     ko'rsatilgan chegirma balansdan yechilganidan KATTA bo'lib,
//     ayirmasi hech kimdan undirilmasdan qolardi;
//   - cashback `price` dan, komissiya esa `finalPrice` dan olinardi.
// Endi uchalasi ham shu yagona `tripTotal` ustidan ishlaydi.
//
// `price` — safar oxirida metrlangan (haqiqiy) yo'l narxi
// (finalizeOrderPrice uni qayta yozadi), `extrasTotal` — mijoz tanlagan
// qo'shimcha xizmatlar. `finalPrice` (mijoz naqd to'laydigan summa) esa
// shundan bonus ayrilgani — u komissiya bazasi sifatida ISHLATILMAYDI.
function computeTripTotal(orderData: FirebaseFirestore.DocumentData): number {
  const price = typeof orderData.price === "number" ? orderData.price : 0;
  const extrasTotal = typeof orderData.extrasTotal === "number" ? orderData.extrasTotal : 0;
  return Math.max(0, price + extrasTotal);
}

// Admin dashboard'ning "Haydovchilar uchun kunlik bonus" va "Haydovchilar
// uchun haftalik bonus" (alohida kartalar, har birida Faol/Nofaol
// vklyuchateli) bo'limlarida sozlanadi (settings/driverBonus hujjati).
// `branchId` berilsa, umumiy standart (settings/driverBonus) USTIGA
// filialning hujjati (settings/driverBonus_branch_{id}) maydonma-maydon
// qo'yiladi — `readBranchScopedSettings` orqali, getBonusSettings bilan
// bir xil. (Avval izohda "topilmasa standart" deyilgan edi — bu eski,
// ALMASHTIRUVCHI mantiqning tavsifi.)
async function getDriverBonusSettings(branchId?: string | null): Promise<{
  dailyEnabled: boolean;
  dailyTripThreshold: number;
  bonusAmount: number;
  minTripDistanceKm: number;
  weeklyEnabled: boolean;
  weeklyTripThreshold: number;
  weeklyBonusAmount: number;
  perOrderEnabled: boolean;
  perOrderBonusAmount: number;
}> {
  const fallback = {
    dailyEnabled: true,
    dailyTripThreshold: 15,
    bonusAmount: 20000,
    minTripDistanceKm: 2,
    weeklyEnabled: false,
    weeklyTripThreshold: 0,
    weeklyBonusAmount: 0,
    perOrderEnabled: false,
    perOrderBonusAmount: 0,
  };
  try {
    const data = await readBranchScopedSettings("driverBonus", branchId);
    if (!data) return fallback;
    const weeklyTripThreshold =
      typeof data.weeklyTripThreshold === "number"
        ? data.weeklyTripThreshold
        : fallback.weeklyTripThreshold;
    return {
      dailyEnabled: typeof data.dailyEnabled === "boolean" ? data.dailyEnabled : fallback.dailyEnabled,
      dailyTripThreshold:
        typeof data.dailyTripThreshold === "number"
          ? data.dailyTripThreshold
          : fallback.dailyTripThreshold,
      bonusAmount: typeof data.bonusAmount === "number" ? data.bonusAmount : fallback.bonusAmount,
      minTripDistanceKm:
        typeof data.minTripDistanceKm === "number"
          ? data.minTripDistanceKm
          : fallback.minTripDistanceKm,
      // Eski hujjatlarda weeklyEnabled maydoni yo'q — bu holda ESKI
      // qoida (weeklyTripThreshold > 0 bo'lsa faol) bo'yicha xulosa
      // chiqaramiz, aks holda allaqachon ishlayotgan haftalik bonus
      // shu deploy'dan keyin "jim" o'chib qolar edi.
      weeklyEnabled:
        typeof data.weeklyEnabled === "boolean" ? data.weeklyEnabled : weeklyTripThreshold > 0,
      weeklyTripThreshold,
      weeklyBonusAmount:
        typeof data.weeklyBonusAmount === "number"
          ? data.weeklyBonusAmount
          : fallback.weeklyBonusAmount,
      perOrderEnabled:
        typeof data.perOrderEnabled === "boolean" ? data.perOrderEnabled : fallback.perOrderEnabled,
      perOrderBonusAmount:
        typeof data.perOrderBonusAmount === "number"
          ? data.perOrderBonusAmount
          : fallback.perOrderBonusAmount,
    };
  } catch {
    return fallback;
  }
}

// Cloud Functions UTC'da ishlaydi — Toshkent (UTC+5) kalendar sanasini
// olish uchun soddagina 5 soat qo'shib, ISO sanasini kesib olamiz
// (kunlik bonus hisob-kitobi shu "kun" bo'yicha guruhlanadi).
function tashkentDateStr(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// Haftaning boshlanishi (Dushanba, Toshkent kalendari) — haftalik bonus
// hisob-kitobi shu sana bo'yicha guruhlanadi.
function tashkentWeekStartStr(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  const day = shifted.getUTCDay(); // 0=Yakshanba, 1=Dushanba, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(shifted);
  monday.setUTCDate(shifted.getUTCDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}

// Filiallar ro'yxati dashboard tomonida `dashboardData/branches`
// hujjatida bitta JSON matn (`value`) sifatida saqlanadi (bir xil
// ko'rinish uchun barcha kompyuterlarda). Buyurtma dispatch qilishda
// eng yaqin filialni topish uchun shu yerdan o'qiymiz.
async function getBranchesForDispatch(): Promise<
  { id: string; lat?: number; lng?: number }[]
> {
  try {
    const doc = await db.collection("dashboardData").doc("branches").get();
    const raw = doc.data()?.value;
    if (typeof raw !== "string") return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    logger.warn("Filiallar ro'yxatini o'qishda xato:", error);
    return [];
  }
}

// Buyurtma olib ketish nuqtasiga eng yaqin filialni topadi (to'g'ri
// chiziq masofasi bo'yicha). Mijoz ilovasidan kelgan buyurtmalarda
// filial tanlanmagan bo'ladi (mijoz ilovasida filial tushunchasi
// yo'q) — shu funksiya orqali avtomatik aniqlanadi. Dispetcher
// dashboard orqali qo'lda tanlagan filial (order.branchId allaqachon
// mavjud bo'lsa) hech qachon bu funksiya bilan ustidan yozilmaydi.
async function computeNearestBranchId(
  lat: number | undefined,
  lng: number | undefined
): Promise<string | null> {
  if (lat == null || lng == null) return null;
  const branches = await getBranchesForDispatch();
  let nearestId: string | null = null;
  let nearestDist = Infinity;
  for (const b of branches) {
    if (!b.id || b.lat == null || b.lng == null) continue;
    const dist = getDistanceMeters(lat, lng, b.lat, b.lng);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestId = b.id;
    }
  }
  return nearestId;
}

// MUHIM: `driverId` ham tekshiriladi. Avval faqat `status` ga
// qaralardi — ya'ni egasi bor, lekin holati hamon "pending" bo'lgan
// buyurtma "hali bo'sh" deb hisoblanardi va sikl uni KEYINGI
// haydovchiga taklif qilishda davom etardi: buyurtmani bir haydovchi
// olib bo'lgach, biroz vaqtdan keyin ikkinchisining ekranida karta
// paydo bo'lardi.
//
// Ikkovi odatda bitta yozuvda keladi, lekin bunga TAYANIB bo'lmaydi:
// eski ilova versiyasi, uzilgan yozuv yoki dispetcherning qo'lda
// biriktirishi ularni ajratib yuborishi mumkin.
async function isOrderStillPending(orderId: string): Promise<boolean> {
  try {
    const data = (await db.collection("orders").doc(orderId).get()).data();
    if (!data) return false;
    if (data.status !== "pending") return false;
    return data.driverId == null;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPushToToken(
  token: string,
  orderId: string,
  dataPayload: Record<string, string>
): Promise<void> {
  try {
    await messaging.send({
      token,
      data: dataPayload,
      android: { priority: "high" },
    });
    logger.info(`Push yuborildi — buyurtma: ${orderId}`);
  } catch (error) {
    logger.warn(`Push yuborishda xato (buyurtma: ${orderId}):`, error);
  }
}

export const onNewOrderNotifyDrivers = onDocumentCreated(
  {
    document: "orders/{orderId}",
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.warn("Hujjat ma'lumotlari topilmadi");
      return;
    }

    const order = snapshot.data();
    const orderId = event.params.orderId;

    if (order.status !== "pending") {
      logger.info(`Buyurtma ${orderId} pending emas (${order.status}), o'tkazib yuborildi`);
      return;
    }

    // ── FILIAL ANIQLASH ───────────────────────────────────────
    // Dispetcher dashboard orqali qo'lda yaratgan buyurtmada
    // branchId allaqachon bor. Mijoz ilovasidan kelgan buyurtmada
    // yo'q — bu holda olib ketish nuqtasiga eng yaqin filial
    // avtomatik aniqlanadi va buyurtma hujjatiga yoziladi (shunda
    // dashboard ham, keyingi dispatch qadamlari ham buni ko'radi).
    let branchId: string | null = order.branchId || null;
    if (!branchId) {
      branchId = await computeNearestBranchId(order.pickupLat, order.pickupLng);
      if (branchId) {
        try {
          await snapshot.ref.update({ branchId });
        } catch (error) {
          logger.warn(`Buyurtma ${orderId} uchun branchId yozishda xato:`, error);
        }
      }
    }

    const dataPayload: Record<string, string> = {
      orderId,
      type: "new_order",
      title: "Yangi buyurtma!",
      body: `${order.fromAddress || "Manzil ko'rsatilmagan"} • ${
        order.price ? String(order.price) + " so'm" : ""
      }`,
      fromAddress: order.fromAddress || "",
      toAddress: order.toAddress || "",
      price: order.price != null ? String(order.price) : "0",
      distanceKm: order.distanceKm != null ? String(order.distanceKm) : "0",
      tariffName: order.tariffName || "",
      customerName: order.customerName || "Noma'lum mijoz",
      customerPhone: order.customerPhone || "",
    };

    // ── TO'G'RIDAN-TO'G'RI BUYURTMA ──────────────────────────
    if (order.driverId) {
      try {
        const driverDoc = await db.collection("drivers").doc(order.driverId).get();
        const token = driverDoc.data()?.pushToken;
        if (token) {
          await sendPushToToken(token, orderId, dataPayload);
        } else {
          logger.warn(`Haydovchi ${order.driverId} uchun pushToken topilmadi`);
        }
      } catch (error) {
        logger.error("To'g'ridan-to'g'ri buyurtma dispatch xatosi:", error);
      }
      return;
    }

    // MUHIM (filial izolyatsiyasi): filial aniqlanmasa (masalan hali
    // birorta filial sozlanmagan, yoki pickup koordinatalari yo'q),
    // ENDI hech kimga dispatch qilinmaydi — avval bu holatda barcha
    // onlayn haydovchilarga (filialidan qat'iy nazar) broadcast
    // qilinardi, bu boshqa filial haydovchisiga buyurtma tushishiga
    // sabab bo'lishi mumkin edi. Buyurtma shunchaki "pending" holatida
    // qoladi — dispetcher dashboard orqali qo'lda filial tayinlashi
    // yoki muammoni ko'rishi kerak.
    if (!branchId) {
      logger.warn(`Buyurtma ${orderId}: filial aniqlanmadi — dispatch qilinmadi`);
      return;
    }

    // ── POOL BUYURTMA — KETMA-KET DISPATCH ───────────────────
    const settings = await getDispatchSettings();
    const radiusCfg = await getRadiusConfig();
    logger.info(
      `Dispatch sozlamalari — radius: ${settings.radiusMeters}m, ` +
        `har haydovchiga: ${settings.timeoutSeconds}s, jami: ${settings.maxTotalSeconds}s`
    );

    let driversSnapshot;
    try {
      driversSnapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Haydovchilarni olishda xato:", error);
      return;
    }

    // `stale` — koordinatasi eskirgan (telefon jim turibdi): navbatdan
    // chiqarilmaydi, faqat OXIRIGA qo'yiladi.
    type DriverInfo = { id: string; token: string; distance: number; stale: boolean };

    const nearbyDrivers: DriverInfo[] = [];

    const pickupLat: number | undefined = order.pickupLat;
    const pickupLng: number | undefined = order.pickupLng;

    const dispatchNow = Date.now();
    let staleSkipped = 0;
    let noBalanceSkipped = 0;
    // Admin intizom uchun bloklaganlar.
    let blockedSkipped = 0;
    // "Domoy/Ish/Mening hududim" rejimi tufayli chetda qolganlar.
    let modeSkipped = 0;

    driversSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.pushToken) return;
      // Haqiqiy arvoh (tozalash vazifasi ham uni oflayn qiladi) —
      // chetda qoladi.
      if (!isDriverStillReachable(data, dispatchNow)) {
        staleSkipped++;
        return;
      }
      // Koordinatasi eskirgan, lekin seansi tirik. Navbatga QO'SHILADI,
      // faqat oxiriga — sabab yuqorida, DRIVER_FRESH_LOCATION_MS
      // ustidagi izohda.
      const locationMillis = driverLocationMillis(data);
      const staleLocation =
        locationMillis === 0 || dispatchNow - locationMillis > DRIVER_FRESH_LOCATION_MS;
      // MUHIM: band (safar davomidagi) haydovchiga yangi buyurtma
      // yuborilmasin — aks holda mijoz ilova tomonda (accept oqimi)
      // buni tekshirmasdan qabul qilsa, joriy faol safar Firestore'da
      // "osilib" (hech qachon yakunlanmay) qoladi.
      if (data.busy) return;
      // Admin bloklagan haydovchi — intizom buzilishi, qarz va h.k.
      // Ilova ham uni to'sadi, lekin taqsimlash bunga TAYANMASLIGI
      // kerak: eski versiyadagi ilova yoki qo'lda yuborilgan so'rov
      // baribir buyurtma olib qo'yishi mumkin edi.
      if (data.blocked === true) {
        blockedSkipped++;
        return;
      }
      // Balansi tugagan haydovchi navbatga QO'SHILMAYDI — yuqoridagi
      // izohga qarang (hasEnoughBalanceForOrder).
      if (!hasEnoughBalanceForOrder(data)) {
        noBalanceSkipped++;
        return;
      }
      if (
        settings.respectDriverArea &&
        !isDriverEligibleForOrder(data, pickupLat, pickupLng, radiusCfg)
      ) {
        // MUHIM: bu chetda qoldirish AVVAL JIMGINA sodir bo'lardi.
        // Haydovchi olish nuqtasining yonginasida tursa ham, uning
        // "qozig'i" uzoqda bo'lsa buyurtma bermasdik — jurnalda esa
        // shunchaki "0 ta yaqin haydovchi" deb ko'rinardi va sababni
        // topib bo'lmasdi.
        modeSkipped++;
        logger.info(
          `Buyurtma ${orderId}: haydovchi ${doc.id} "${data.activeMode}" rejimida — ` +
            `tanlagan hududidan tashqarida, o'tkazib yuborildi`
        );
        return;
      }
      // MUHIM (filial izolyatsiyasi, QAT'IY): faqat O'SHA filialga
      // tegishli haydovchilar ko'rib chiqiladi. branchId yuqorida
      // allaqachon tekshirilgan (null bo'lsa funksiya qaytib ketgan),
      // shuning uchun bu yerda "fail open" holati YO'Q — boshqa
      // filialning haydovchisi hech qanday holatda bu buyurtmani
      // ko'rmaydi yoki push olmaydi.
      if (data.branch !== branchId) return;

      if (pickupLat != null && pickupLng != null && data.lat != null && data.lng != null) {
        const dist = getDistanceMeters(pickupLat, pickupLng, data.lat, data.lng);
        if (dist <= settings.radiusMeters) {
          nearbyDrivers.push({
            id: doc.id,
            token: data.pushToken,
            distance: dist,
            stale: staleLocation,
          });
        }
      }
    });

    // Avval joylashuvi YANGI haydovchilar (masofa bo'yicha), so'ng
    // jim turganlar. Ikkinchi guruhning masofasi oxirgi ma'lum
    // nuqtadan o'lchanadi — u eskirgan bo'lishi mumkin, shuning
    // uchun ular navbatning oxirida.
    nearbyDrivers.sort((a, b) =>
      a.stale === b.stale ? a.distance - b.distance : a.stale ? 1 : -1
    );

    // Koordinatasi eskirgan, lekin navbatga TUSHGANLAR — jurnalda
    // chetda qolganlardan alohida ko'rinsin. Ataylab navbat
    // shakllangandan KEYIN sanaladi: filtrlardan oldin sanalsa,
    // boshqa filialdagi yoki radiusdan uzoq haydovchi ham qo'shilib,
    // son navbatdagi haqiqiy songa mos kelmasdi.
    const staleQueued = nearbyDrivers.filter((d) => d.stale).length;

    logger.info(
      `Buyurtma ${orderId} (filial: ${branchId}): ${nearbyDrivers.length} ta yaqin haydovchi ` +
        `(${settings.radiusMeters}m radius; ${staleQueued} tasining koordinatasi ` +
        `eskirgan — navbat oxirida), ${staleSkipped} ta "arvoh onlayn", ` +
        `${noBalanceSkipped} ta balansi tugagan, ${blockedSkipped} ta bloklangan, ` +
        `${modeSkipped} ta "o'z hududi" rejimidagi haydovchi o'tkazib yuborildi` +
        (settings.respectDriverArea ? "" : ' ("o\'z hududi" filtri O\'CHIRILGAN)')
    );

    // ── RADIUS ICHIDA HAYDOVCHI YO'Q ──────────────────────────
    // MUHIM: bu yerda ENDI boshqa haydovchilarga (radiusdan tashqarida
    // yoki boshqa filialda) broadcast QILINMAYDI. Buyurtma "pending"
    // holatida qoladi va shu filialning "Ochiq buyurtmalar" ro'yxatida
    // (listenToPoolOrders, branchId bo'yicha filtrlangan) avtomatik
    // paydo bo'ladi — filialdagi istalgan onlayn haydovchi uni qo'lda
    // "Olish" tugmasi orqali qabul qila oladi.
    if (nearbyDrivers.length === 0) {
      logger.info(
        `Buyurtma ${orderId}: radius ichida haydovchi yo'q — "Ochiq buyurtmalar"da qoladi (filial: ${branchId})`
      );
      return;
    }

    // ── KETMA-KET DISPATCH ────────────────────────────────────
    // MUHIM: butun sikl uchun vaqt chegarasi. Funksiyaning o'z chegarasi
    // 540 soniya (yuqorida), bitta haydovchiga esa `timeoutSeconds`
    // (odatda 20s) kutiladi — ya'ni 27 ta haydovchidan keyin funksiya
    // OG'ZIDA uziladi: qolganlariga taklif bormaydi va oxirgi
    // xulosa yozuvi ham chiqmaydi, ya'ni jurnalda hammasi joyidaday
    // ko'rinadi. Endi sikl o'zi to'xtaydi va NECHTASI qolib
    // ketganini AYTADI.
    // MUHIM: umumiy chegara endi SOZLAMADAN keladi. Avval u qat'iy
    // 7 daqiqa edi — funksiyaning o'z chegarasidan (540s) oshib
    // ketmasligi uchun qo'yilgan texnik to'siq, mijozning sabri
    // uchun emas. Amalda buyurtma 20 taga yaqin haydovchiga navbat
    // bilan taklif qilinib, mijoz daqiqalab kutib qolishi mumkin
    // edi. Endi u 60 soniya (sozlanadi), ya'ni 10 soniyadan 6 ta
    // haydovchi. Vaqt tugagach buyurtma "Ochiq buyurtmalar"da
    // qoladi va uni istalgan haydovchi qo'lda olishi mumkin.
    const dispatchDeadline =
      Date.now() + Math.min(settings.maxTotalSeconds * 1000, DISPATCH_LOOP_BUDGET_MS);
    let notOffered = 0;

    for (let i = 0; i < nearbyDrivers.length; i++) {
      const driver = nearbyDrivers[i];

      if (Date.now() > dispatchDeadline) {
        notOffered = nearbyDrivers.length - i;
        logger.warn(
          `Buyurtma ${orderId}: vaqt chegarasiga yetildi — ${notOffered} ta haydovchiga ` +
            `taklif YUBORILMADI (ular "Ochiq buyurtmalar"da ko'radi)`
        );
        break;
      }

      const stillPending = await isOrderStillPending(orderId);
      if (!stillPending) {
        logger.info(`Buyurtma ${orderId} qabul qilindi yoki bekor qilindi (${i}. haydovchida)`);
        return;
      }

      // MUHIM: haydovchining "band"ligi YUQORIDAGI ro'yxat tuzilganda
      // BIR MARTA tekshirilgan edi, sikl esa daqiqalab davom etadi.
      // Navbat shu haydovchiga yetguncha u boshqa buyurtmani olib
      // ulgurgan bo'lishi mumkin — o'sha holatda unga taklif yuborish
      // ikkinchi buyurtmani qabul qilishiga yo'l ochadi (haydovchi
      // ilovasidagi tekshiruv ham, `acceptOrder` ham "band"ni
      // ko'rmaydi), va birinchi safar hech qachon yakunlanmay qoladi.
      // Shuning uchun taklifdan OLDIN holat qayta o'qiladi.
      let stillFree = true;
      try {
        const fresh = await db.collection("drivers").doc(driver.id).get();
        const freshData = fresh.data();
        // Balans ham QAYTA tekshiriladi: sikl daqiqalab davom etadi,
        // shu orada haydovchi boshqa safarni yakunlab komissiya
        // yechilgan va balansi nolga tushgan bo'lishi mumkin.
        stillFree =
          !!freshData &&
          freshData.busy !== true &&
          freshData.isOnline === true &&
          hasEnoughBalanceForOrder(freshData);
      } catch (error) {
        // O'qib bo'lmadi — eski ma'lumot bilan davom etamiz (taklif
        // yubormaslikdan ko'ra yuborgan yaxshi: buyurtma mijozniki).
        logger.warn(`Haydovchi ${driver.id} holatini qayta o'qib bo'lmadi`, error);
      }
      if (!stillFree) {
        logger.info(
          `Buyurtma ${orderId}: haydovchi ${driver.id} endi band/oflayn/balanssiz — o'tkazib yuborildi`
        );
        continue;
      }

      logger.info(
        `Buyurtma ${orderId} → haydovchi ${driver.id} ` +
          `(masofa: ${Math.round(driver.distance)}m, navbat: ${i + 1}/${nearbyDrivers.length}` +
          `${driver.stale ? ", koordinatasi eskirgan" : ""})`
      );

      await sendPushToToken(driver.token, orderId, dataPayload);

      // Har doim (oxirgisi bo'lsa ham) navbatdagi tekshiruv/qaytishdan
      // oldin kutamiz — shu bilan haydovchiga qabul qilish uchun
      // yetarli vaqt beriladi.
      await sleep(settings.timeoutSeconds * 1000);
    }

    // ── BARCHA YAQIN HAYDOVCHILAR RAD ETDI/JAVOB BERMADI ─────
    // MUHIM: bu yerda ham ENDI broadcast YO'Q — xuddi yuqoridagi
    // kabi, buyurtma "pending" holatida qoladi va filialning "Ochiq
    // buyurtmalar" ro'yxatida boshqa (radiusdan tashqaridagi yoki
    // band bo'lmagan) haydovchilarga ko'rinadi, faqat SHU filial
    // ichida.
    const stillPendingAfterAll = await isOrderStillPending(orderId);
    if (stillPendingAfterAll) {
      logger.info(
        `Buyurtma ${orderId}: barcha yaqin haydovchilar rad etdi/javob bermadi — ` +
          `"Ochiq buyurtmalar"da qoladi (filial: ${branchId})`
      );
    } else {
      logger.info(`Buyurtma ${orderId} yaqin haydovchilar tugashidan oldin qabul qilindi`);
    }
  }
);

// ============================================================
// KUN.UZ YANGILIKLAR TASMASI — dashboard'dagi "begavaya dorojka"
// uchun. Brauzer to'g'ridan-to'g'ri kun.uz'ga so'rov yubora olmaydi
// (CORS cheklovi), shuning uchun bu funksiya oraliq (proxy)
// vazifasini bajaradi: server tomonda RSS'ni o'qiydi, JSON qilib
// qaytaradi.
// ============================================================

const KUN_UZ_RSS_URL = "https://kun.uz/news/rss";

type NewsItem = { title: string; link: string };

// Xotirada keshlash — har bir dispetcher sahifani ochganda kun.uz'ga
// qayta so'rov yubormaslik uchun. 5 daqiqa amal qiladi.
let newsCache: { items: NewsItem[]; fetchedAt: number } = {
  items: [],
  fetchedAt: 0,
};
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  let val = match[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return val
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function fetchKunUzNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (now - newsCache.fetchedAt < NEWS_CACHE_TTL_MS && newsCache.items.length > 0) {
    return newsCache.items;
  }
  const res = await fetch(KUN_UZ_RSS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (SevimliGoDashboard)" },
  });
  const xml = await res.text();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items: NewsItem[] = itemBlocks
    .slice(0, 15)
    .map((block) => ({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
    }))
    .filter((item) => item.title && item.link);

  if (items.length > 0) {
    newsCache = { items, fetchedAt: now };
  }
  return newsCache.items;
}

export const getKunUzNews = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    try {
      const items = await fetchKunUzNews();
      res.set("Cache-Control", "public, max-age=180");
      res.status(200).json({ items });
    } catch (error) {
      logger.error("Kun.uz yangiliklarini olishda xato:", error);
      res.status(200).json({ items: [] });
    }
  }
);

// ============================================================
// DISPETCHER BILDIRISHNOMALARI — dashboard'dagi "Bildirishnoma"
// bo'limidan yuborilgan xabarni tegishli haydovchilarga push
// sifatida yetkazadi.
// ============================================================

export const onNewNotificationSendPush = onDocumentCreated(
  {
    document: "notifications/{notificationId}",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const notif = snapshot.data();
    const notificationId = event.params.notificationId;
    const target: string = notif.target || "all_drivers";
    // MUHIM: dashboard menejer/depecher tomonidan yuborilgan
    // bo'lsa, o'z filial(lar)i bilan cheklangan (branchIds massivi) —
    // admin tomonidan yuborilgan bo'lsa bu maydon null/yo'q bo'ladi
    // (cheklovsiz, barcha filiallarga).
    const branchIds: string[] | null = Array.isArray(notif.branchIds) ? notif.branchIds : null;

    let driversSnapshot;
    try {
      driversSnapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Bildirishnoma uchun haydovchilarni olishda xato:", error);
      return;
    }

    const tokens: string[] = [];
    driversSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.pushToken) return;
      if (branchIds && !branchIds.includes(data.branch)) return;
      const busy = !!data.busy;
      if (target === "all_drivers" || target === "all") tokens.push(data.pushToken);
      else if (target === "free_drivers" && !busy) tokens.push(data.pushToken);
      else if (target === "busy_drivers" && busy) tokens.push(data.pushToken);
      else if (target === doc.id) tokens.push(data.pushToken);
    });

    if (tokens.length === 0) {
      logger.info(`Bildirishnoma ${notificationId}: yuboriladigan haydovchi topilmadi (target: ${target})`);
      return;
    }

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        data: {
          type: "dispatcher_notification",
          notificationId,
          title: notif.title || "Yangi xabar",
          body: notif.text || "",
        },
        android: { priority: "high" },
      });
      logger.info(
        `Bildirishnoma ${notificationId}: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
      );
    } catch (error) {
      logger.error("Bildirishnoma push xatosi:", error);
    }
  }
);

// ============================================================
// MIJOZ BONUS TIZIMI — mijoz ilovasi (customer app).
// Buyurtma "completed" holatiga o'tganda: buyurtmada sarflangan
// bonus (bonusUsed) mijoz balansidan yechiladi va narxning bir
// qismi (settings/bonus.earnPercent) yangi bonus sifatida
// qo'shiladi. Har ikkalasi ham customers/{id}/bonusHistory'ga
// yoziladi.
//
// MUHIM (xavfsizlik): bu — bonusBalance'ni o'zgartiradigan
// YAGONA joy bo'lishi kerak. Mijoz ilovasi Firestore Rules
// orqali bonusBalance'ni to'g'ridan-to'g'ri yoza olmaydi —
// aks holda mijoz balansni o'zi "hile" bilan oshirib yuborishi
// mumkin edi.
//
// MUHIM (poyga holati / race condition): haydovchi ilovasi safarni
// yakunlaganda IKKITA ALOHIDA Firestore yozuvi qiladi — avval
// updateOrderStatus(id, 'completed'), so'ng finalizeOrderPrice(id, ...)
// (yakuniy, metrlangan narx bilan `price`ni qayta yozadi) — bittasi
// kutilmasdan (E:\Sevimli Go\src\MapScreen.tsx, confirmFinishTrip).
// Bu ikkala yozuv ham shu triggerni ishga tushiradi va ULARNING
// FIRESTORE'GA YETIB KELISH TARTIBI KAFOLATLANMAGAN. Shuning uchun:
// (1) status "completed"ga o'tgan HAR safar (nafaqat birinchi marta)
// tekshiramiz, (2) tranzaksiya ichida buyurtmani QAYTA o'qiymiz (eventdagi
// eski snapshot emas) — shu bilan doim ENG SO'NGGI (yakuniy) `price`
// ishlatiladi, (3) `bonusApplied` flag orqali ikki marta qo'llanishning
// oldini olamiz (ikkala yozuv ham shu funksiyani chaqirsa ham).
// ============================================================

export const onOrderCompletedApplyBonus = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const after = event.data?.after;
    if (!after || after.data()?.status !== "completed") return;

    const orderId = event.params.orderId;
    const customerId: string | undefined = after.data()?.customerId;
    if (!customerId) {
      logger.info(`Buyurtma ${orderId} customerId'siz — bonus hisoblanmadi`);
      return;
    }

    const orderRef = after.ref;
    const customerRef = db.collection("customers").doc(customerId);
    const historyRef = customerRef.collection("bonusHistory");
    const bonusSettings = await getBonusSettings(after.data()?.branchId);
    // Mijoz bonusini kompaniya qoplaydi va bu AYNAN shu tranzaksiyada,
    // mijoz balansidan yechish bilan BIRGA bajariladi — sababi pastda.
    // Qoplama KIMGA berilishi tranzaksiya ICHIDA aniqlanadi (txDriverId),
    // chunki bu yerdagi snapshot eskirgan bo'lishi mumkin.

    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const orderData = orderSnap.data();
        if (!orderData || orderData.status !== "completed" || orderData.bonusApplied) {
          return;
        }

        const customerDoc = await tx.get(customerRef);
        const currentBalance =
          typeof customerDoc.data()?.bonusBalance === "number" ? customerDoc.data()!.bonusBalance : 0;
        // MUHIM: qoplama KIMGA berilishi tranzaksiya ichida QAYTA
        // o'qilgan buyurtmadan olinadi, hodisa snapshotidan emas.
        // Snapshot eskirgan bo'lishi mumkin (funksiya qayta urinilsa
        // yoki kechikib ishga tushsa) — o'shanda pul buyurtma
        // allaqachon qayta tayinlangan ESKI haydovchiga ketardi.
        // Funksiyaning o'z izohi ham buyurtmani qayta o'qish shart
        // deb turibdi; `driverId` esa e'tibordan chetda qolgan edi.
        const txDriverId: string | undefined =
          typeof orderData.driverId === "string" ? orderData.driverId : undefined;
        const txDriverRef = txDriverId ? db.collection("drivers").doc(txDriverId) : null;
        // MUHIM: Firestore tranzaksiyasida BARCHA o'qishlar BARCHA
        // yozishlardan oldin bo'lishi shart — shuning uchun haydovchi
        // hujjati ham shu yerda, yozishlar boshlanishidan avval olinadi.
        const driverDoc = txDriverRef ? await tx.get(txDriverRef) : null;

        // MUHIM: baza — safarning TO'LIQ qiymati (yo'l narxi + qo'shimcha
        // xizmatlar), aynan mijoz ilovasi chegirmani hisoblaganidek.
        // Avval bu yerda faqat `price` ishlatilardi, mijoz ilovasida esa
        // `price + extrasTotal` — natijada mijozga ko'rsatilgan chegirma
        // balansdan yechilganidan katta bo'lib, ayirmasi yo'qolardi.
        const tripTotal = computeTripTotal(orderData);
        const bonusUsed = typeof orderData.bonusUsed === "number" ? Math.max(0, orderData.bonusUsed) : 0;
        const earnAmount = Math.floor((tripTotal * bonusSettings.earnPercent) / 100);

        // ============================================================
        // CHEGIRMA — BITTA RAQAM, UCHALA TOMONDA BIR XIL
        // ============================================================
        // Mijoz naqd pulda AYNAN shuncha kam to'laydi:
        //     finalPrice = max(0, tripTotal - bonusUsed)
        // ya'ni haqiqiy chegirma = min(bonusUsed, tripTotal).
        // Buni haydovchi ilovasi (finalizeOrderPrice) va dashboard
        // (recomputeFinalPrice) hisoblab, haydovchiga shu summani
        // undirishni aytadi — safar tugagan zahoti, bu funksiya
        // ishlashidan OLDIN.
        //
        // MUHIM: shu sabab bu yerda admin chegarasini (perOrderCap)
        // QAYTA qo'llash MUMKIN EMAS. Avval shunday qilingan edi va u
        // pulni haydovchidan o'g'irlardi: metr bo'yicha narx taxmindan
        // past chiqsa, foizli chegara ham kichrayardi, ya'ni qoplama
        // mijozga berilgan naqd chegirmadan KAM bo'lardi.
        //
        //   Misol: chegara 50%, taxmin 30 000 -> bonusUsed 15 000.
        //   Metr bo'yicha 20 000 chiqdi. Mijoz 5 000 naqd to'laydi.
        //   Eski hisob: perOrderCap = 10 000 -> qoplama 10 000.
        //   Haydovchi 20 000 lik safar uchun 15 000 oldi — 5 000 yo'qotdi.
        //
        // Admin chegarasi o'z joyida — buyurtma BERILAYOTGANDA, mijoz
        // ilovasida qo'llanadi (computePerOrderBonusCap). Safar oxirida
        // uni qayta qo'llash chegirmani allaqachon berib bo'lgandan
        // keyin uni "qaytarib olish"ga urinish bo'lardi.
        //
        // `minBalanceToUse` ham ATAYLAB qayta tekshirilmaydi — xuddi
        // shu sabab: u buyurtma berish paytidagi shart.
        const discount = Math.min(bonusUsed, tripTotal);
        // Balans yetmasa ham haydovchi TO'LIQ qoplama oladi: chegirma
        // mijozga allaqachon naqd pulda berilgan, uni haydovchi
        // ko'tarmasligi kerak. Ayirmani kompaniya qoplaydi.
        const actualSpent = discount;
        const newBalance = Math.max(0, currentBalance - discount) + earnAmount;
        // MIJOZ BALANSIDAN haqiqatda yechilgan summa. Bu `discount` dan
        // KAM bo'lishi mumkin (balans yetmagan holat) — va aynan shu
        // farq qaytarishda muhim: qaytarishda `discount` ni tiklash
        // mijozga YO'QDAN bonus yasab berardi.
        //   Misol: balans 5 000, bonusUsed 8 000, cashback 1 200.
        //   Yechildi: 5 000 (balans 0 ga tushdi), qo'shildi: 1 200.
        //   Qaytarishda 8 000 tiklansa -> 8 000. Mijoz 5 000 bilan
        //   kirib, 8 000 bilan chiqadi: 3 000 yo'qdan paydo bo'ldi.
        const actuallyDeducted = Math.min(currentBalance, discount);

        tx.set(customerRef, { bonusBalance: newBalance }, { merge: true });
        // `bonusCompensation` — haydovchiga qoplab berilgan summa. U
        // buyurtmaga ham yoziladi: haydovchi ilovasining "Pul" bo'limi
        // shuni ko'rsatadi.
        tx.set(
          orderRef,
          {
            bonusApplied: true,
            bonusCompensation: actualSpent,
            // Quyidagi ikki maydon buyurtma keyinchalik "completed"dan
            // chiqarilsa (dispetcher qayta efirga tashlasa) kerak
            // bo'ladi: onOrderLeftCompletedRevertMoney AYNAN qancha
            // berilgani va KIMGA berilganini shulardan biladi.
            bonusEarned: earnAmount,
            bonusDeducted: actuallyDeducted,
            bonusCompensationDriverId: actualSpent > 0 && txDriverId ? txDriverId : null,
          },
          { merge: true }
        );

        // ============================================================
        // MIJOZ BONUSINI KOMPANIYA QOPLAYDI
        // ============================================================
        // Mijoz bonus ishlatsa, haydovchi qo'liga naqd pul shu miqdorda
        // KAM tushadi, garchi ishni to'liq bajargan bo'lsa ham. Ayirmani
        // kompaniya qoplaydi.
        //
        // MUHIM: qoplama aynan `actualSpent` — ya'ni mijoz balansidan
        // HAQIQATDA yechilgan summa, va u shu bitta tranzaksiyada,
        // yechish bilan birga beriladi. Avval bu boshqa funksiyada
        // (`onOrderCompletedDeductCommission`), `tripTotal - finalPrice`
        // formulasi bilan mustaqil hisoblanardi — ikkalasi turli
        // vaqtda, turli bazadan chiqqani uchun BIR-BIRIGA TENG
        // BO'LMASDI. Masalan metrlangan narx taxmindan past chiqsa,
        // haydovchiga 15 000 berilib, mijozdan 10 000 yechilardi —
        // ayirma har safar kompaniyadan yo'qolardi. Endi bitta manbadan
        // olingani uchun ular teng bo'lmasligi mumkin emas.
        if (actualSpent > 0 && txDriverRef && driverDoc) {
          const driverBalance =
            typeof driverDoc.data()?.balance === "number" ? driverDoc.data()!.balance : 0;
          tx.set(txDriverRef, { balance: driverBalance + actualSpent }, { merge: true });
          // Haydovchi balansidagi o'zgarish sababsiz ko'rinmasin.
          // MUHIM: ID ichida `${orderId}` bo'lishi SHART. Avval u tushib
          // qolgan edi (`compensation-`), ya'ni HAR BIR qoplama bitta
          // hujjatni qayta yozardi: haydovchi uchta safar uchun qoplama
          // olsa ham tarixda faqat oxirgisi ko'rinardi. Qaytarish esa
          // `compensation-${orderId}` ni o'chirishga urinardi va hech
          // narsa topmasdi — eski yozuv abadiy qolib ketardi.
          tx.set(txDriverRef.collection("bonusHistory").doc(`compensation-${orderId}`), {
            period: "bonus_compensation",
            date: tashkentDateStr(),
            amount: actualSpent,
            orderId,
            createdAt: FieldValue.serverTimestamp(),
          });
        } else if (actualSpent > 0 && !txDriverRef) {
          logger.warn(
            `Buyurtma ${orderId}: mijozdan ${actualSpent} bonus yechildi, lekin ` +
              "buyurtmada driverId yo'q — qoplama berilmadi."
          );
        }

        if (actualSpent > 0) {
          tx.set(historyRef.doc(), {
            type: "spent",
            amount: actualSpent,
            orderId,
            note: "Safarda ishlatildi",
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        if (earnAmount > 0) {
          tx.set(historyRef.doc(), {
            type: "earned",
            amount: earnAmount,
            orderId,
            note: "Safar uchun bonus",
            createdAt: FieldValue.serverTimestamp(),
          });
        }

        logger.info(
          `Buyurtma ${orderId}: bonus qo'llanildi (mijoz ${customerId}) — ` +
            `safar qiymati: ${tripTotal}, sarflangan: ${actualSpent}, olingan: ${earnAmount}`
        );
      });
    } catch (error) {
      logger.error(`Bonus tranzaksiyasi xatosi (buyurtma ${orderId}):`, error);
    }
  }
);

// ============================================================
// HAYDOVCHI KOMISSIYASI — buyurtma "completed" bo'lganda, tarifda
// belgilangan komissiya (foiz yoki qat'iy summa, dashboard'ning
// "Tariflar" bo'limi orqali sozlanadi) haydovchining balansidan
// yechiladi. E:\Sevimli Go\src\MapScreen.tsx balansi <=0 bo'lgan
// haydovchiga yangi buyurtma qabul qilishni taqiqlaydi — shu ikkisi
// birgalikda "avval hisobda pul bo'lishi kerak, so'ng har safar
// komissiya yechiladi" talabini ta'minlaydi.
// ============================================================

export const onOrderCompletedDeductCommission = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const after = event.data?.after;
    if (!after || after.data()?.status !== "completed") return;

    const orderId = event.params.orderId;
    const driverId: string | undefined = after.data()?.driverId;
    if (!driverId) {
      logger.info(`Buyurtma ${orderId} driverId'siz — komissiya hisoblanmadi`);
      return;
    }

    const orderRef = after.ref;

    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const orderData = orderSnap.data();
        if (!orderData || orderData.status !== "completed" || orderData.commissionApplied) {
          return;
        }

        // MUHIM: haydovchi TRANZAKSIYA ICHIDAGI o'qishdan olinadi, hodisa
        // suratidan emas. Eventarc kafolati "kamida bir marta" — ya'ni
        // eski hodisa qayta yetkazilishi mumkin. Buyurtma oradan qayta
        // ochilib boshqa haydovchiga o'tgan bo'lsa, hodisa suratidagi
        // `driverId` ALLAQACHON eskirgan bo'ladi va komissiya
        // NOTO'G'RI haydovchidan yechilardi (yangisidan esa umuman
        // yechilmasdi — bayroq allaqachon qo'yilgan bo'lardi).
        // `onOrderCompletedApplyBonus` shu tarzda allaqachon tuzatilgan.
        const txDriverId: string | undefined =
          typeof orderData.driverId === "string" ? orderData.driverId : undefined;
        if (!txDriverId) {
          logger.info(`Buyurtma ${orderId} driverId'siz — komissiya hisoblanmadi`);
          return;
        }
        const driverRef = db.collection("drivers").doc(txDriverId);

        // MUHIM (poyga holati): xuddi bonus funksiyasidagi kabi, "completed"ga
        // o'tish va yakuniy narxni yozish ikkita alohida yozuv — shuning uchun
        // buyurtmani QAYTA o'qiymiz (eng so'nggi `price`/`finalPrice` bilan) va
        // `commissionApplied` flag orqali ikki marta yechilishning oldini olamiz.
        let driverCommission = 0;
        let commissionType: "percent" | "fixed" = "percent";
        const tariffId: string | undefined = orderData.tariffId;
        if (tariffId) {
          const tariffSnap = await tx.get(db.collection("tariffs").doc(tariffId));
          const tariffData = tariffSnap.data();
          if (tariffData) {
            driverCommission =
              typeof tariffData.driverCommission === "number" ? tariffData.driverCommission : 0;
            commissionType = tariffData.commissionType === "fixed" ? "fixed" : "percent";
          }
        }

        // Komissiya safarning TO'LIQ qiymatidan hisoblanadi — mijoz bonus
        // ishlatgan-ishlatmaganidan qat'i nazar, haydovchi bajargan ish
        // bir xil.
        const tripTotal = computeTripTotal(orderData);
        const commissionAmount =
          commissionType === "fixed"
            ? driverCommission
            : Math.round((tripTotal * driverCommission) / 100);

        // MUHIM: mijoz bonusining qoplamasi bu yerda EMAS. U
        // `onOrderCompletedApplyBonus` ichida, mijoz balansidan yechish
        // bilan BIR TRANZAKSIYADA beriladi. Avval qoplama shu yerda,
        // `tripTotal - finalPrice` formulasi bilan mustaqil hisoblanardi
        // — u mijozdan haqiqatda yechilgan summaga teng bo'lmasdi va
        // ayirma har safar kompaniyadan yo'qolardi. Bu funksiya endi
        // faqat komissiya bilan shug'ullanadi.
        const driverDoc = await tx.get(driverRef);
        const currentBalance =
          typeof driverDoc.data()?.balance === "number" ? driverDoc.data()!.balance : 0;
        const newBalance = currentBalance - commissionAmount;

        tx.set(driverRef, { balance: newBalance }, { merge: true });
        // Komissiya summasi buyurtmaning o'ziga ham yoziladi — avval faqat
        // `commissionApplied` bayrog'i qo'yilardi va haydovchi ilovasi
        // komissiya qancha yechilganini KO'RSATA OLMASDI (buyurtmada
        // bunday maydon umuman yo'q edi). Endi "Pul" bo'limi haqiqiy
        // raqamlarni ko'rsata oladi.
        // `commissionDriverId` — komissiya KIMDAN yechilgani. Buyurtma
        // qayta efirga tashlansa, pul aynan shu haydovchiga qaytariladi
        // (onOrderLeftCompletedRevertMoney).
        tx.set(
          orderRef,
          { commissionApplied: true, commissionAmount, commissionDriverId: txDriverId },
          { merge: true }
        );

        logger.info(
          `Buyurtma ${orderId}: komissiya yechildi (haydovchi ${txDriverId}) — ` +
            `safar qiymati: ${tripTotal}, komissiya: ${commissionAmount}, ` +
            `yangi balans: ${newBalance}`
        );
      });
    } catch (error) {
      logger.error(`Komissiya tranzaksiyasi xatosi (buyurtma ${orderId}):`, error);
    }
  }
);

// ============================================================
// HAYDOVCHI KUNLIK/HAFTALIK BONUSI — buyurtma "completed" bo'lganda,
// agar masofa admin belgilagan minimal kilometrdan (minTripDistanceKm)
// kam bo'lmasa, shu kun VA shu hafta uchun haydovchining "haqiqiy"
// safarlar hisobiga qo'shiladi (drivers/{id}/dailyBonusStats/{sana} va
// drivers/{id}/weeklyBonusStats/{hafta boshi}). Har biri o'z chegarasiga
// (dailyTripThreshold / weeklyTripThreshold) yetganda, mos bonusAmount
// BIR MARTA haydovchi balansiga qo'shiladi. Haftalik bonus ixtiyoriy —
// weeklyTripThreshold 0 bo'lsa, o'chirilgan hisoblanadi.
//
// Nega masofa cheklovi bor: aks holda haydovchi o'ziga-o'ziga (yoki
// tanishiga) soniyalik, bo'sh buyurtma yaratib, haqiqatda safar
// qilmasdan turib safar sonini sun'iy oshirishi mumkin edi.
// ============================================================

export const onOrderCompletedCheckDriverBonus = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const after = event.data?.after;
    if (!after || after.data()?.status !== "completed") return;

    const orderId = event.params.orderId;
    const driverId: string | undefined = after.data()?.driverId;
    if (!driverId) return;

    const orderRef = after.ref;
    const dateStr = tashkentDateStr();
    const weekStartStr = tashkentWeekStartStr();
    // Buyurtmaning branchId'si — dispatch bosqichida haydovchining o'z
    // filialiga mos ravishda tayinlangan (onNewOrderNotifyDrivers faqat
    // shu filialdagi haydovchilarga yuboradi), shuning uchun bu yerda
    // alohida haydovchi hujjatini o'qimasdan to'g'ridan-to'g'ri ishlatish
    // mumkin.
    const driverBonusSettings = await getDriverBonusSettings(after.data()?.branchId);

    try {
      await db.runTransaction(async (tx) => {
        // MUHIM: Firestore tranzaksiyalarida barcha o'qishlar (get)
        // barcha yozishlardan (set) OLDIN bajarilishi shart — shuning
        // uchun kerak bo'lishi mumkin bo'lgan hujjatlarning HAMMASINI
        // avval o'qib olamiz, keyingina yozishga o'tamiz.
        const orderSnap = await tx.get(orderRef);
        const orderData = orderSnap.data();
        if (!orderData || orderData.status !== "completed" || orderData.driverBonusChecked) {
          return;
        }

        // MUHIM: haydovchi TRANZAKSIYA ICHIDAN o'qiladi — hodisa surati
        // eskirgan bo'lishi mumkin (izohi onOrderCompletedDeductCommission
        // ichida). Aks holda buyurtma qayta ochilib boshqa haydovchiga
        // o'tgan bo'lsa, safar ESKI haydovchining kunlik/haftalik
        // hisobiga yozilardi.
        const txDriverId: string | undefined =
          typeof orderData.driverId === "string" ? orderData.driverId : undefined;
        if (!txDriverId) return;
        const driverRef = db.collection("drivers").doc(txDriverId);
        const dailyStatsRef = driverRef.collection("dailyBonusStats").doc(dateStr);
        const weeklyStatsRef = driverRef.collection("weeklyBonusStats").doc(weekStartStr);

        // MUHIM: avval bu yerda `distanceKm` — buyurtma YARATILGANDAGI
        // taxminiy masofa o'qilardi. Haqiqiy, GPS bo'yicha o'lchangan
        // masofani haydovchi ilovasi `actualDistanceKm` ga yozadi
        // (finalizeOrderPrice), `distanceKm`ga esa umuman tegmaydi.
        // Oqibati: bordyur safarlari (ular `distanceKm: 0` bilan
        // yaratiladi, chunki manzil oldindan noma'lum) haydovchi 30 km
        // yursa ham minTripDistanceKm shartidan o'tolmay, HECH QACHON
        // bonus hisobiga kirmasdi. Endi avval haqiqiy masofa olinadi,
        // u yo'q bo'lsagina taxminiyga qaytiladi.
        //
        // `> 0` sharti ATAYLAB — `!== null` EMAS. `actualDistanceKm: 0`
        // "haydovchi 0 km yurdi" degani emas, "masofa O'LCHANMADI"
        // degani: GPS ruxsati berilmagan, ichkarida signal yo'qolgan
        // yoki ilova safar o'rtasida qayta ishga tushgan bo'lishi
        // mumkin (shunda tripDistanceRef nolga tushadi). `!== null`
        // bilan bunday holatda haqiqatda 12 km yurgan haydovchi ham
        // kunlik bonus hisobiga kirmay qolardi — o'lchov ishlamagani
        // uchun jazolangandek. Taxminiy masofa esa buyurtma
        // yaratilganda hisoblangan va haydovchi uni o'zgartira olmaydi,
        // shuning uchun unga qaytish xavfsiz.
        const actualDistanceKm =
          typeof orderData.actualDistanceKm === "number" ? orderData.actualDistanceKm : 0;
        const estimatedDistanceKm =
          typeof orderData.distanceKm === "number" ? orderData.distanceKm : 0;
        const distanceKm = actualDistanceKm > 0 ? actualDistanceKm : estimatedDistanceKm;
        const distanceOk = distanceKm >= driverBonusSettings.minTripDistanceKm;
        const dailyActive = driverBonusSettings.dailyEnabled && driverBonusSettings.dailyTripThreshold > 0;
        const weeklyActive = driverBonusSettings.weeklyEnabled && driverBonusSettings.weeklyTripThreshold > 0;
        const perOrderActive =
          driverBonusSettings.perOrderEnabled && driverBonusSettings.perOrderBonusAmount > 0;
        const dailyQualifies = dailyActive && distanceOk;
        const weeklyQualifies = weeklyActive && distanceOk;
        const perOrderQualifies = perOrderActive && distanceOk;

        const statsSnap = await tx.get(dailyStatsRef);
        const statsData = statsSnap.data();
        const currentCount =
          typeof statsData?.qualifyingTripCount === "number" ? statsData.qualifyingTripCount : 0;
        const alreadyAwarded = statsData?.bonusAwarded === true;
        const newCount = dailyQualifies ? currentCount + 1 : currentCount;
        const willAward =
          dailyQualifies && !alreadyAwarded && newCount >= driverBonusSettings.dailyTripThreshold;

        const weeklyStatsSnap = await tx.get(weeklyStatsRef);
        const weeklyStatsData = weeklyStatsSnap.data();
        const weeklyCurrentCount =
          typeof weeklyStatsData?.qualifyingTripCount === "number"
            ? weeklyStatsData.qualifyingTripCount
            : 0;
        const weeklyAlreadyAwarded = weeklyStatsData?.bonusAwarded === true;
        const weeklyNewCount = weeklyQualifies ? weeklyCurrentCount + 1 : weeklyCurrentCount;
        const weeklyWillAward =
          weeklyQualifies && !weeklyAlreadyAwarded && weeklyNewCount >= driverBonusSettings.weeklyTripThreshold;

        const driverDoc =
          willAward || weeklyWillAward || perOrderQualifies ? await tx.get(driverRef) : null;

        // ---- shu nuqtadan e'tiboran faqat yozishlar ----
        // Buyurtma keyinchalik "completed"dan chiqarilsa, bu safar
        // qaysi haydovchining QAYSI KUNGI/HAFTADAGI hisobiga
        // kirganini bilish shart — sana triggerning ishlash paytiga
        // bog'liq, buyurtmaning o'zida esa saqlanmaydi. Ertasi kuni
        // qayta efirga tashlansa, bugungi hisob kamayib ketmasligi
        // uchun aynan shu sanalar yozib qo'yiladi.
        tx.set(
          orderRef,
          {
            driverBonusChecked: true,
            driverBonusDriverId: txDriverId,
            driverBonusStatsDate: dateStr,
            driverBonusStatsWeek: weekStartStr,
            driverBonusDailyCounted: dailyQualifies,
            driverBonusWeeklyCounted: weeklyQualifies,
            driverBonusPerOrderAmount: perOrderQualifies
              ? driverBonusSettings.perOrderBonusAmount
              : 0,
          },
          { merge: true }
        );

        if (dailyQualifies) {
          tx.set(
            dailyStatsRef,
            {
              qualifyingTripCount: newCount,
              date: dateStr,
              tripThreshold: driverBonusSettings.dailyTripThreshold,
              targetBonusAmount: driverBonusSettings.bonusAmount,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        if (weeklyQualifies) {
          tx.set(
            weeklyStatsRef,
            {
              qualifyingTripCount: weeklyNewCount,
              weekStart: weekStartStr,
              tripThreshold: driverBonusSettings.weeklyTripThreshold,
              targetBonusAmount: driverBonusSettings.weeklyBonusAmount,
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        if ((willAward || weeklyWillAward || perOrderQualifies) && driverDoc) {
          const currentBalance =
            typeof driverDoc.data()?.balance === "number" ? driverDoc.data()!.balance : 0;
          const totalBonus =
            (willAward ? driverBonusSettings.bonusAmount : 0) +
            (weeklyWillAward ? driverBonusSettings.weeklyBonusAmount : 0) +
            (perOrderQualifies ? driverBonusSettings.perOrderBonusAmount : 0);
          const newBalance = currentBalance + totalBonus;

          tx.set(driverRef, { balance: newBalance }, { merge: true });

          if (willAward) {
            tx.set(
              dailyStatsRef,
              { bonusAwarded: true, bonusAmount: driverBonusSettings.bonusAmount },
              { merge: true }
            );
            tx.set(driverRef.collection("bonusHistory").doc(dateStr), {
              period: "daily",
              date: dateStr,
              amount: driverBonusSettings.bonusAmount,
              tripCount: newCount,
              createdAt: FieldValue.serverTimestamp(),
            });
            logger.info(
              `Haydovchi ${txDriverId}: kunlik bonus (${dateStr}) berildi — ${newCount} safar, ` +
                `+${driverBonusSettings.bonusAmount} so'm`
            );
          }

          if (weeklyWillAward) {
            tx.set(
              weeklyStatsRef,
              { bonusAwarded: true, bonusAmount: driverBonusSettings.weeklyBonusAmount },
              { merge: true }
            );
            tx.set(driverRef.collection("bonusHistory").doc(`week-${weekStartStr}`), {
              period: "weekly",
              date: weekStartStr,
              amount: driverBonusSettings.weeklyBonusAmount,
              tripCount: weeklyNewCount,
              createdAt: FieldValue.serverTimestamp(),
            });
            logger.info(
              `Haydovchi ${txDriverId}: haftalik bonus (${weekStartStr}) berildi — ${weeklyNewCount} safar, ` +
                `+${driverBonusSettings.weeklyBonusAmount} so'm`
            );
          }

          if (perOrderQualifies) {
            tx.set(driverRef.collection("bonusHistory").doc(`order-${orderId}`), {
              period: "perOrder",
              date: dateStr,
              amount: driverBonusSettings.perOrderBonusAmount,
              orderId,
              createdAt: FieldValue.serverTimestamp(),
            });
            logger.info(
              `Haydovchi ${txDriverId}: buyurtma-bonus (${orderId}) berildi — ` +
                `+${driverBonusSettings.perOrderBonusAmount} so'm`
            );
          }

          logger.info(`Haydovchi ${txDriverId}: yangi balans ${newBalance}`);
        } else if (dailyQualifies || weeklyQualifies) {
          logger.info(
            `Buyurtma ${orderId}: haydovchi ${txDriverId} hisobga qo'shildi — ` +
              (dailyQualifies ? `kunlik ${newCount}/${driverBonusSettings.dailyTripThreshold}` : "kunlik o'chirilgan") +
              (weeklyQualifies ? `, haftalik ${weeklyNewCount}/${driverBonusSettings.weeklyTripThreshold}` : "")
          );
        } else if (!distanceOk) {
          logger.info(
            `Buyurtma ${orderId}: masofa (${distanceKm}km) minimal chegaradan ` +
              `(${driverBonusSettings.minTripDistanceKm}km) kam — hisobga kirmadi`
          );
        } else {
          logger.info(`Buyurtma ${orderId}: kunlik va haftalik bonus ikkalasi ham o'chirilgan`);
        }
      });
    } catch (error) {
      logger.error(`Haydovchi bonus tranzaksiyasi xatosi (buyurtma ${orderId}):`, error);
    }
  }
);

// ============================================================
// BUYURTMA "COMPLETED"DAN CHIQARILGANDA — PULNI QAYTARISH
// ============================================================
// Dispetcher tugallangan buyurtmani "Qayta efirga tashlash" tugmasi
// bilan yana "pending"ga qaytarishi (yoki bekor qilishi) mumkin. Bu
// paytga kelib yuqoridagi uchala trigger allaqachon ishlagan bo'ladi:
// mijoz balansidan bonus yechilgan va unga cashback yozilgan,
// haydovchidan komissiya olingan, unga qoplama va buyurtma-bonusi
// berilgan, safar esa uning kunlik/haftalik hisobiga kirgan.
//
// Avval bu bayroqlar (`bonusApplied`, `commissionApplied`,
// `driverBonusChecked`) HECH QACHON tozalanmasdi. Oqibatlari:
//   * buyurtmani BOSHQA haydovchi bajarsa, undan komissiya umuman
//     olinmasdi — u bepul ishlardi, kompaniya esa daromadini
//     yo'qotardi;
//   * uning safari kunlik/haftalik bonus hisobiga kirmasdi va
//     buyurtma-bonusini ham olmasdi;
//   * birinchi haydovchi o'zi bajarmagan safar uchun to'lagan
//     komissiyasini qaytarib olmasdi, mijoz bonusining qoplamasini
//     esa o'zida saqlab qolardi.
//
// Endi buyurtma "completed" holatidan chiqqan zahoti hamma pul
// harakati qaytariladi va bayroqlar tozalanadi. Shundan so'ng buyurtma
// qayta tugallanganda, uchala trigger HAQIQATDA safarni bajargan
// haydovchi uchun toza holatdan qayta ishlaydi.
//
// Bu trigger o'z yozuvi bilan o'zini qayta chaqirmaydi: shart
// "oldingi holat completed, yangisi emas" — qaytarish yozuvidan keyin
// ikkala holat ham "completed" emas, demak shart bajarilmaydi.
// ============================================================

export const onOrderLeftCompletedRevertMoney = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const before = event.data?.before;
    const after = event.data?.after;
    if (!before || !after || !after.exists) return;
    if (before.data()?.status !== "completed") return;
    if (after.data()?.status === "completed") return;

    const orderId = event.params.orderId;
    const orderRef = after.ref;
    const customerId: string | undefined = after.data()?.customerId;

    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const o = orderSnap.data();
        if (!o) return;
        // Poyga holati: buyurtma shu orada yana "completed"ga qaytgan
        // bo'lsa, qaytarishga hojat yo'q.
        if (o.status === "completed") return;

        // ============================================================
        // ESKI BUYURTMALAR — QAYTARIB BO'LMAYDIGANLARI
        // ============================================================
        // Qaytarish uchun kerak bo'lgan maydonlar (`bonusEarned`,
        // `commissionDriverId`, `driverBonusDriverId` va h.k.) shu
        // funksiya bilan BIR VAQTDA joriy qilindi. Undan OLDIN
        // yakunlangan buyurtmalarda ular umuman yo'q.
        //
        // Avval bu yerda bayroqlar SO'ZSIZ tozalanardi. Ya'ni eski
        // buyurtma qayta efirga tashlansa: hech narsa qaytarilmasdi
        // (ma'lumot yo'q), lekin bayroqlar tushirilardi — va buyurtma
        // qayta yakunlanganda mijozdan bonus IKKINCHI MARTA yechilar,
        // haydovchidan komissiya IKKINCHI MARTA olinardi.
        //
        // Endi har bir bayroq FAQAT o'zi haqiqatan qaytarilgan bo'lsa
        // tozalanadi. Qaytarib bo'lmasa bayroq joyida qoladi: bunday
        // buyurtmada ikkinchi haydovchi komissiyasiz ishlaydi (eski
        // xatti-harakat), lekin HECH KIMDAN ikki marta pul olinmaydi.
        // Ikki yomonlikning kichigi.
        const hadBonus = o.bonusApplied === true;
        const hadCommission = o.commissionApplied === true;
        const hadDriverBonus = o.driverBonusChecked === true;
        if (!hadBonus && !hadCommission && !hadDriverBonus) return;

        // Yangi kod yozgan "iz" maydonlari bormi — qaytarish shunga
        // bog'liq.
        const canRevertBonus = hadBonus && typeof o.bonusEarned === "number";
        const canRevertCommission = hadCommission && typeof o.commissionDriverId === "string";
        const canRevertDriverBonus = hadDriverBonus && typeof o.driverBonusDriverId === "string";
        if (
          (hadBonus && !canRevertBonus) ||
          (hadCommission && !canRevertCommission) ||
          (hadDriverBonus && !canRevertDriverBonus)
        ) {
          logger.warn(
            `Buyurtma ${orderId}: yangilanishdan OLDIN yakunlangan — ` +
              `qaytarib bo'lmaydigan qismlar bor (bonus:${hadBonus && !canRevertBonus}, ` +
              `komissiya:${hadCommission && !canRevertCommission}, ` +
              `haydovchi bonusi:${hadDriverBonus && !canRevertDriverBonus}). ` +
              "Ularning bayrog'i ATAYLAB tozalanmaydi — ikki marta yechilishining oldini olish uchun."
          );
        }

        // ---- 1-qadam: BARCHA o'qishlar (Firestore tranzaksiyasi
        // yozishdan keyin o'qishga ruxsat bermaydi) ----
        const num = (v: unknown): number => (typeof v === "number" ? v : 0);

        // Har bir summa faqat O'SHA qismi qaytarilishi mumkin bo'lsa
        // hisobga olinadi (yuqoridagi izohga qarang).
        // Haydovchidan qaytarib olinadigan summa — unga BERILGAN qoplama.
        const bonusSpent = canRevertBonus ? Math.max(0, num(o.bonusCompensation)) : 0;
        // Mijozga qaytariladigan summa esa — undan HAQIQATDA yechilgani.
        // Bu ikkalasi TENG EMAS: balans yetmagan holatda kompaniya
        // haydovchiga to'liq qoplab beradi, mijozdan esa bori yechiladi.
        // Ikkalasini birlashtirib yuborish mijozga yo'qdan bonus yasab
        // berardi (izohi `bonusDeducted` yozilgan joyda).
        //
        // Eski buyurtmalarda `bonusDeducted` maydoni yo'q — ularda
        // avvalgidek `bonusCompensation` ishlatiladi (ular uchun bu
        // ikkalasi deyarli har doim teng bo'lgan).
        const bonusReturnedToCustomer = canRevertBonus
          ? typeof o.bonusDeducted === "number"
            ? Math.max(0, o.bonusDeducted)
            : bonusSpent
          : 0;
        const bonusEarned = canRevertBonus ? Math.max(0, num(o.bonusEarned)) : 0;
        const commissionAmount = canRevertCommission ? num(o.commissionAmount) : 0;
        const perOrderBonus = canRevertDriverBonus ? Math.max(0, num(o.driverBonusPerOrderAmount)) : 0;

        const customerRef =
          canRevertBonus && customerId ? db.collection("customers").doc(customerId) : null;
        const customerDoc = customerRef ? await tx.get(customerRef) : null;

        // Uchala summa ODATDA bitta haydovchiga tegishli, lekin buyurtma
        // oraliqda qayta tayinlangan bo'lishi mumkin — shuning uchun har
        // biri o'z egasiga qaytariladi va bitta haydovchining bir nechta
        // harakati bitta yozuvga jamlanadi.
        const driverDelta = new Map<string, number>();
        const bump = (id: unknown, amount: number): void => {
          if (typeof id !== "string" || !id || amount === 0) return;
          driverDelta.set(id, (driverDelta.get(id) || 0) + amount);
        };
        // Komissiya haydovchidan OLINGAN edi — qaytariladi (+).
        bump(o.commissionDriverId, commissionAmount);
        // Qoplama va buyurtma-bonusi haydovchiga BERILGAN edi — olinadi (-).
        bump(o.bonusCompensationDriverId, -bonusSpent);
        bump(o.driverBonusDriverId, -perOrderBonus);

        const driverSnaps = new Map<string, FirebaseFirestore.DocumentSnapshot>();
        for (const id of driverDelta.keys()) {
          driverSnaps.set(id, await tx.get(db.collection("drivers").doc(id)));
        }

        // Kunlik/haftalik safar hisobi AYNAN o'sha paytda oshirilgan
        // hujjatdan kamaytiriladi — shuning uchun sanalar buyurtmaning
        // o'zidan olinadi, tashkentDateStr() dan emas.
        const statsDriverId = canRevertDriverBonus ? (o.driverBonusDriverId as string) : null;
        const statsDriverRef = statsDriverId ? db.collection("drivers").doc(statsDriverId) : null;
        const dailyRef =
          statsDriverRef && o.driverBonusDailyCounted === true && typeof o.driverBonusStatsDate === "string"
            ? statsDriverRef.collection("dailyBonusStats").doc(o.driverBonusStatsDate)
            : null;
        const weeklyRef =
          statsDriverRef && o.driverBonusWeeklyCounted === true && typeof o.driverBonusStatsWeek === "string"
            ? statsDriverRef.collection("weeklyBonusStats").doc(o.driverBonusStatsWeek)
            : null;
        const dailySnap = dailyRef ? await tx.get(dailyRef) : null;
        const weeklySnap = weeklyRef ? await tx.get(weeklyRef) : null;

        // ---- 2-qadam: shu nuqtadan e'tiboran faqat yozishlar ----

        if (customerRef && customerDoc && (bonusReturnedToCustomer > 0 || bonusEarned > 0)) {
          const currentBalance = num(customerDoc.data()?.bonusBalance);
          // Sarflangani qaytariladi, hisoblangan cashback esa bekor
          // qilinadi. Nolda to'xtaydi: mijoz cashbackni allaqachon
          // boshqa safarda ishlatib yuborgan bo'lishi mumkin, balans
          // esa hech qachon manfiy bo'lmasligi kerak.
          const restored = Math.max(0, currentBalance + bonusReturnedToCustomer - bonusEarned);
          tx.set(customerRef, { bonusBalance: restored }, { merge: true });
          const history = customerRef.collection("bonusHistory");
          // Tarix mijozga ko'rinadi — balans sababsiz o'zgarmasin.
          if (bonusReturnedToCustomer > 0) {
            tx.set(history.doc(), {
              type: "earned",
              amount: bonusReturnedToCustomer,
              orderId,
              note: "Buyurtma qayta ochildi — bonus qaytarildi",
              createdAt: FieldValue.serverTimestamp(),
            });
          }
          if (bonusEarned > 0) {
            tx.set(history.doc(), {
              type: "spent",
              amount: bonusEarned,
              orderId,
              note: "Buyurtma qayta ochildi — hisoblangan bonus bekor qilindi",
              createdAt: FieldValue.serverTimestamp(),
            });
          }
        }

        for (const [id, delta] of driverDelta) {
          const snap = driverSnaps.get(id);
          if (!snap) continue;
          // Balans manfiyga tushishi mumkin — komissiya yechilishida ham
          // shunday, va haydovchi ilovasi balansi <= 0 bo'lsa yangi
          // buyurtma qabul qilishga yo'l qo'ymaydi.
          tx.set(db.collection("drivers").doc(id), { balance: num(snap.data()?.balance) + delta }, { merge: true });
        }

        if (bonusSpent > 0 && typeof o.bonusCompensationDriverId === "string") {
          tx.delete(
            db.collection("drivers").doc(o.bonusCompensationDriverId)
              .collection("bonusHistory").doc(`compensation-${orderId}`)
          );
        }
        if (perOrderBonus > 0 && statsDriverRef) {
          tx.delete(statsDriverRef.collection("bonusHistory").doc(`order-${orderId}`));
        }

        // MUHIM: safar hisobi kamaytiriladi, lekin ALLAQACHON BERILGAN
        // kunlik/haftalik bonus qaytarib OLINMAYDI (`bonusAwarded`
        // tegilmaydi). Sababi: u o'nlab safar ustidan yig'ilgan va
        // berilgan paytda haqiqatan ham to'g'ri edi. `bonusAwarded`
        // true qolgani uchun hisob chegaraga qayta yetganda ikkinchi
        // marta ham berilmaydi — ya'ni ortiqcha to'lov bo'lmaydi.
        if (dailyRef && dailySnap) {
          tx.set(
            dailyRef,
            {
              qualifyingTripCount: Math.max(0, num(dailySnap.data()?.qualifyingTripCount) - 1),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }
        if (weeklyRef && weeklySnap) {
          tx.set(
            weeklyRef,
            {
              qualifyingTripCount: Math.max(0, num(weeklySnap.data()?.qualifyingTripCount) - 1),
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        }

        // MUHIM: bayroq FAQAT o'sha qism haqiqatan qaytarilgan bo'lsa
        // tushiriladi. Qaytarilmagan qismning bayrog'i joyida qoladi,
        // aks holda buyurtma qayta yakunlanganda o'sha pul IKKINCHI
        // MARTA olinardi (yuqoridagi izohga qarang).
        const revertPatch: FirebaseFirestore.DocumentData = {
          moneyRevertedAt: FieldValue.serverTimestamp(),
        };
        if (canRevertBonus) {
          revertPatch.bonusApplied = false;
          revertPatch.bonusCompensation = 0;
          revertPatch.bonusEarned = 0;
          revertPatch.bonusCompensationDriverId = null;
        }
        if (canRevertCommission) {
          revertPatch.commissionApplied = false;
          revertPatch.commissionAmount = 0;
          revertPatch.commissionDriverId = null;
        }
        if (canRevertDriverBonus) {
          revertPatch.driverBonusChecked = false;
          revertPatch.driverBonusPerOrderAmount = 0;
          revertPatch.driverBonusDailyCounted = false;
          revertPatch.driverBonusWeeklyCounted = false;
        }
        // Mijozga "safar yakunlandi" xabari qayta yuborilishi kerak —
        // buyurtma yana yakunlanganda.
        revertPatch.completedPushSent = false;
        tx.set(orderRef, revertPatch, { merge: true });

        logger.info(
          `Buyurtma ${orderId} "completed"dan chiqarildi — pul qaytarildi: ` +
            `mijozga +${bonusSpent}/-${bonusEarned} bonus, ` +
            `haydovchi(lar) balansi ${[...driverDelta].map(([id, d]) => `${id}:${d > 0 ? "+" : ""}${d}`).join(", ") || "o'zgarmadi"}`
        );
      });
    } catch (error) {
      logger.error(`Pulni qaytarish tranzaksiyasi xatosi (buyurtma ${orderId}):`, error);
    }
  }
);

// ============================================================
// MIJOZGA PUSH BILDIRISHNOMA — buyurtma holati mijoz uchun
// muhim bosqichga o'tganda (haydovchi topildi / safar yakunlandi /
// bekor qilindi) customers/{customerId}.pushToken orqali push
// yuboradi — drivers/{id}.pushToken bilan bir xil pattern.
// ============================================================

export const onOrderStatusChangeNotifyCustomer = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!before || !after) return;

    const orderId = event.params.orderId;
    const customerId: string | undefined = after.customerId;
    if (!customerId) return;

    let status: "accepted" | "completed" | "cancelled" | null = null;
    // "completed" holati uchun narx maydoni yakuniy (metrlangan) qiymat
    // bilan alohida yozuv orqali kelishi mumkin — shu holatda push matni
    // shu eng so'nggi ma'lumotdan quriladi (pastda tozalanadi).
    let messageData: FirebaseFirestore.DocumentData = after;

    if (after.status === "accepted" && before.status !== "accepted") {
      status = "accepted";
    } else if (after.status === "cancelled" && before.status !== "cancelled") {
      status = "cancelled";
    } else if (after.status === "completed") {
      // MUHIM (poyga holati): xuddi onOrderCompletedApplyBonus'dagi kabi,
      // "completed"ga o'tish va yakuniy narxni yozish IKKITA alohida
      // Firestore yozuvi — tartib kafolatlanmagan. Shuning uchun bu yerda
      // ham buyurtmani qayta o'qiymiz va push FAQAT bir marta (eng oxirgi,
      // yakuniy narx bilan) yuborilishini "completedPushSent" flag orqali
      // ta'minlaymiz.
      const orderRef = event.data!.after.ref;
      const shouldSend = await db.runTransaction(async (tx) => {
        const snap = await tx.get(orderRef);
        const data = snap.data();
        if (!data || data.status !== "completed" || data.completedPushSent) return false;
        tx.set(orderRef, { completedPushSent: true }, { merge: true });
        messageData = data;
        return true;
      });
      if (!shouldSend) return;
      status = "completed";
    } else {
      return;
    }

    let token: string | undefined;
    try {
      const customerDoc = await db.collection("customers").doc(customerId).get();
      token = customerDoc.data()?.pushToken;
    } catch (error) {
      logger.error(`Mijoz push tokenini olishda xato (${customerId}):`, error);
      return;
    }
    if (!token) {
      logger.info(`Mijoz ${customerId} uchun pushToken topilmadi — o'tkazib yuborildi`);
      return;
    }

    let title = "Sevimli Go";
    let body = "";

    if (status === "accepted") {
      title = "Haydovchi topildi!";
      body = "Haydovchingiz yo'lga chiqdi.";
      if (messageData.driverId) {
        try {
          const driverDoc = await db.collection("drivers").doc(messageData.driverId).get();
          const driverData = driverDoc.data();
          if (driverData) {
            const name = [driverData.firstName, driverData.lastName].filter(Boolean).join(" ");
            const car = [driverData.carBrand, driverData.carModel].filter(Boolean).join(" ");
            body = `${name || "Haydovchi"}${car ? " · " + car : ""} sizga yo'lda`;
          }
        } catch (error) {
          logger.warn(`Haydovchi ma'lumotini olishda xato (${messageData.driverId}):`, error);
        }
      }
    } else if (status === "completed") {
      title = "Safar yakunlandi";
      const price = typeof messageData.price === "number" ? messageData.price : undefined;
      body = price != null ? `To'lov: ${price} so'm. Rahmat!` : "Xush safar bo'lsin!";
    } else if (status === "cancelled") {
      title = "Buyurtma bekor qilindi";
      body = messageData.cancelReason || "Buyurtma bekor qilindi.";
    }

    try {
      await messaging.send({
        token,
        data: { type: "order_status", orderId, status, title, body },
        android: { priority: "high" },
      });
      logger.info(`Mijozga push yuborildi (${customerId}) — buyurtma ${orderId}: ${status}`);
    } catch (error) {
      logger.error(`Mijozga push yuborishda xato (${customerId}):`, error);
    }
  }
);

// ============================================================
// MIJOZ ILOVASI KIRISHI — Eskiz.uz orqali SMS kod
// ============================================================
// Firebase Phone Auth sideload qilingan (Play Store'ga chiqmagan) APK
// bilan ishlamaydi (Play Integrity mijozning haqiqiy telefon raqamini
// tasdiqlay olmaydi — faqat Console'ga qo'shilgan test raqamlar
// ishlaydi). Shuning uchun SMS kodni o'zimiz Eskiz.uz orqali yuboramiz,
// tekshirgandan keyin esa Firebase'ning "custom token"ini yaratib
// mijoz ilovasiga qaytaramiz — shu token bilan `signInWithCustomToken`
// chaqirilsa, qolgan BUTUN tizim (Firestore Rules, customers/{uid}
// profil, bonus va h.k.) hech qanday o'zgarishsiz, avvalgidek ishlaydi,
// faqat SMS yuborish/tekshirish usuli almashadi.

const OTP_TTL_MS = 5 * 60 * 1000; // 5 daqiqa
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // qayta yuborishdan oldin kutish
const OTP_MAX_ATTEMPTS = 5;

// Eskiz SMS shabloni hali moderatsiyada bo'lgan paytda, Eskiz'dan tashqari
// qolgan butun oqimni (kod tekshirish, custom token, tizimga kirish)
// sinash uchun — bu raqamga SMS UMUMAN YUBORILMAYDI, doim shu qattiq
// kod ishlatiladi. MUHIM: shablon tasdiqlangandan keyin bu vaqtinchalik
// yechim OLIB TASHLANISHI kerak — productionda hech qanday raqam SMS'siz
// kira olmasligi shart.
const TEST_PHONE_CODES: Record<string, string> = {
  "+998918118181": "0000",
};

function isValidUzPhone(phone: unknown): phone is string {
  return typeof phone === "string" && /^\+998\d{9}$/.test(phone);
}

// Eskiz'ning tokeni ~30 kun amal qiladi — settings/eskizToken'da keshlab
// qo'yamiz, shunda har bir SMS uchun qayta login qilinmaydi.
async function getEskizToken(): Promise<string> {
  const cacheRef = db.collection("settings").doc("eskizToken");
  const cached = await cacheRef.get();
  const cachedData = cached.data();
  if (cachedData?.token && typeof cachedData.expiresAtMillis === "number" &&
      cachedData.expiresAtMillis > Date.now() + 60_000) {
    return cachedData.token;
  }

  const res = await fetch("https://notify.eskiz.uz/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: eskizEmail.value(), password: eskizPassword.value() }),
  });
  if (!res.ok) {
    throw new Error(`Eskiz login xatosi: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json: any = await res.json();
  const token: string | undefined = json?.data?.token;
  if (!token) throw new Error("Eskiz login javobida token topilmadi");

  // Eskiz tokeni 30 kunlik — xavfsizlik uchun 25 kun deb keshlaymiz.
  const expiresAtMillis = Date.now() + 25 * 24 * 60 * 60 * 1000;
  await cacheRef.set({ token, expiresAtMillis }, { merge: true });
  return token;
}

// MUHIM: hozircha hech qayerdan chaqirilmaydi (Eskiz shabloni moderatsiyada,
// vaqtincha faqat Telegram ishlatilmoqda) — tasdiqlangach requestPhoneOtp
// ichida qayta yoqiladi. `export` — shu oraliqda ham "ishlatilmagan"
// xatosini bermasligi uchun.
export async function sendEskizSms(phone: string, message: string): Promise<void> {
  const mobilePhone = phone.replace("+", "");
  const send = async (token: string) =>
    fetch("https://notify.eskiz.uz/api/message/sms/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: new URLSearchParams({ mobile_phone: mobilePhone, message, from: "4546" }),
    });

  let token = await getEskizToken();
  let res = await send(token);
  if (res.status === 401) {
    // Token muddati o'tgan/bekor qilingan bo'lishi mumkin — keshni
    // tozalab, bir marta qayta urinib ko'ramiz.
    await db.collection("settings").doc("eskizToken").delete().catch(() => {});
    token = await getEskizToken();
    res = await send(token);
  }
  if (!res.ok) {
    throw new Error(`Eskiz SMS xatosi: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

const TELEGRAM_BOT_USERNAME = "sevimligo_bot";

async function sendTelegramMessage(chatId: number | string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${telegramBotToken.value()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`Telegram xabar yuborish xatosi: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

export const requestPhoneOtp = onRequest(
  { secrets: [eskizEmail, eskizPassword, telegramBotToken] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Faqat POST" });
      return;
    }
    const phone = req.body?.phone;
    if (!isValidUzPhone(phone)) {
      res.status(400).json({ error: "Telefon raqami noto'g'ri formatda (+998XXXXXXXXX kerak)" });
      return;
    }

    const otpRef = db.collection("otpCodes").doc(phone);
    try {
      const existing = await otpRef.get();
      const existingData = existing.data();
      if (
        existingData?.lastSentAtMillis &&
        Date.now() - existingData.lastSentAtMillis < OTP_RESEND_COOLDOWN_MS
      ) {
        res.status(429).json({ error: "Iltimos, biroz kutib qayta urinib ko'ring" });
        return;
      }

      // MUHIM: kod uzunligi va SMS matni Eskiz kabinetida moderatsiyadan
      // o'tkazilgan shablon bilan ANIQ bir xil bo'lishi shart ("Sevimli
      // Go ilovasida tasdiqlash kodi: 0000" — 4 xonali), aks holda
      // Eskiz "matn moderatsiyadan o'tmagan" xatosini qaytaradi.
      const testCode = TEST_PHONE_CODES[phone];
      const code = testCode || String(Math.floor(1000 + Math.random() * 9000));

      // MUHIM (xavfsizlik): har bir so'rov uchun YANGI, tasodifiy
      // linkToken yaratiladi — Telegram bot'ga "/start <token>" orqali
      // ulanish shu tokenga bog'liq, DOIMIY telefon->chat bog'lanishi
      // hech qayerda saqlanmaydi. Aks holda, kimdir boshqa birovning
      // telefon raqamini bilib, o'sha raqam uchun botni oldindan o'zi
      // ishga tushirib qo'ysa, haqiqiy egasining keyingi kirish
      // urinishlaridagi kod UNGA emas, o'sha kishiga borardi — bu real
      // hisobni o'g'irlash xavfi. Har safar yangi, faqat shu bitta
      // urinish uchun (5 daqiqa) amal qiladigan token bilan bu xavf
      // yo'qoladi.
      const linkToken = randomBytes(16).toString("base64url");
      await otpRef.set({
        code,
        linkToken,
        expiresAtMillis: Date.now() + OTP_TTL_MS,
        attempts: 0,
        lastSentAtMillis: Date.now(),
      });

      if (testCode) {
        logger.info(`Test raqami (${phone}) — hech narsa yuborilmadi, qattiq kod ishlatildi`);
        res.status(200).json({ ok: true });
        return;
      }

      // Hozircha FAQAT Telegram orqali yuboriladi (Eskiz SMS shabloni
      // hali moderatsiyada) — tasdiqlangach, sendEskizSms ham shu yerda
      // PARALEL chaqirilishi kerak (bittasi ikkinchisini almashtirmasdan).
      res.status(200).json({
        ok: true,
        telegramDeepLink: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${linkToken}`,
      });
    } catch (error) {
      logger.error(`SMS kod yuborishda xato (${phone}):`, error);
      res.status(500).json({ error: "SMS kod yuborishda xatolik yuz berdi" });
    }
  }
);

// Telegram bot'ning webhook manzili — @sevimligo_bot'da "/start <token>"
// kelganda, shu tokenga mos kutilayotgan OTP kodini o'sha chatga yuboradi.
// MUHIM: bu manzil Telegram'ning o'zida (setWebhook orqali) ro'yxatdan
// o'tkazilgan bo'lishi kerak, aks holda Telegram bu yerga hech narsa
// yubormaydi.
export const telegramBotWebhook = onRequest(
  { secrets: [telegramBotToken] },
  async (req, res) => {
    try {
      const message = req.body?.message;
      const text: string | undefined = message?.text;
      const chatId = message?.chat?.id;
      if (!text || !chatId || !text.startsWith("/start")) {
        res.status(200).send("ok");
        return;
      }

      const token = text.replace("/start", "").trim();
      if (!token) {
        res.status(200).send("ok");
        return;
      }

      const snap = await db.collection("otpCodes").where("linkToken", "==", token).limit(1).get();
      if (snap.empty) {
        await sendTelegramMessage(chatId, "Havola muddati tugagan. Ilovada qaytadan urinib ko'ring.");
        res.status(200).send("ok");
        return;
      }
      const data = snap.docs[0].data();
      if (Date.now() > data.expiresAtMillis) {
        await sendTelegramMessage(chatId, "Kod muddati tugagan. Ilovada qaytadan urinib ko'ring.");
        res.status(200).send("ok");
        return;
      }
      // MUHIM: shu chatId keyinchalik verifyPhoneOtp orqali haydovchi
      // hujjatiga (telegramChatId) ko'chiriladi — bu FAQAT to'g'ri kod
      // muvaffaqiyatli tasdiqlangandan keyin sodir bo'ladi, shuning
      // uchun yuqoridagi bir martalik linkToken xavfsizligini
      // buzmaydi (kelajakdagi kirishlar hali ham yangi token talab qiladi).
      await snap.docs[0].ref.set({ chatId }, { merge: true });
      await sendTelegramMessage(chatId, `Sevimli Go ilovasida tasdiqlash kodi: ${data.code}`);
      res.status(200).send("ok");
    } catch (error) {
      logger.error("Telegram webhook xatosi:", error);
      res.status(200).send("ok");
    }
  }
);

export const verifyPhoneOtp = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Faqat POST" });
    return;
  }
  const phone = req.body?.phone;
  const code = req.body?.code;
  if (!isValidUzPhone(phone) || typeof code !== "string") {
    res.status(400).json({ error: "Noto'g'ri so'rov" });
    return;
  }

  const otpRef = db.collection("otpCodes").doc(phone);
  try {
    const snap = await otpRef.get();
    const data = snap.data();
    if (!data) {
      res.status(400).json({ error: "Avval SMS kod so'rang" });
      return;
    }
    if (Date.now() > data.expiresAtMillis) {
      await otpRef.delete();
      res.status(400).json({ error: "Kod muddati tugagan, qaytadan so'rang" });
      return;
    }
    if ((data.attempts || 0) >= OTP_MAX_ATTEMPTS) {
      res.status(429).json({ error: "Urinishlar soni tugadi, qaytadan SMS so'rang" });
      return;
    }
    if (data.code !== code) {
      await otpRef.set({ attempts: (data.attempts || 0) + 1 }, { merge: true });
      res.status(400).json({ error: "Kod noto'g'ri" });
      return;
    }

    let userRecord;
    try {
      userRecord = await auth.getUserByPhoneNumber(phone);
    } catch {
      userRecord = await auth.createUser({ phoneNumber: phone });
    }
    const customToken = await auth.createCustomToken(userRecord.uid);

    // MUHIM: kodni FAQAT token muvaffaqiyatli yaratilgandan keyin
    // o'chiramiz — aks holda Auth tomonda vaqtinchalik xato (masalan
    // token imzolash ruxsati muammosi) to'g'ri kodni "sarflab" qo'yardi,
    // mijoz qaytadan butun SMS'ni so'rashga majbur bo'lardi.
    await otpRef.delete();
    res.status(200).json({ customToken, uid: userRecord.uid, chatId: data.chatId ?? null });
  } catch (error) {
    logger.error(`SMS kodni tekshirishda xato (${phone}):`, error);
    res.status(500).json({ error: "Tekshirishda xatolik yuz berdi" });
  }
});

// ============================================================
// HAYDOVCHI MODERATSIYASI — dashboard'da admin o'zi ro'yxatdan
// o'tgan haydovchini tasdiqlasa/rad etsa, haydovchiga @sevimligo_bot
// orqali xabar boradi (registratsiyada saqlangan telegramChatId
// orqali — RegisterScreen.tsx verifyDriverPhoneOtp muvaffaqiyatli
// bo'lgach, shu maydonni drivers/{phone} hujjatiga yozadi).
// ============================================================

// Tasdiqlash dashboard'da oddiy Firestore yozuvi (saveDriverToFirestore)
// orqali sodir bo'lgani uchun, bu yerda o'sha yozuvni "eshitib",
// approved false->true o'tganda xabar yuboramiz.
export const onDriverApprovedNotifyTelegram = onDocumentUpdated(
  { document: "drivers/{phone}", secrets: [telegramBotToken] },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after || before?.approved === true || after.approved !== true) return;

    const chatId = after.telegramChatId;
    if (!chatId) return;

    try {
      await sendTelegramMessage(
        chatId,
        "Tabriklaymiz! Sevimli Go haydovchi arizangiz tasdiqlandi — endi ilovaga kirishingiz mumkin."
      );
    } catch (error) {
      logger.error(`Haydovchi (${event.params.phone}) tasdiqlash xabarini yuborishda xato:`, error);
    }
  }
);

// Rad etish dashboard'da alohida chaqiriladi (oddiy Firestore
// yozuvidan farqli, chunki xabar yuborish uchun bot tokeni kerak,
// u faqat server tomonda mavjud) — xabar yuborilib, so'ng ariza
// o'chiriladi.
export const rejectDriver = onRequest(
  { region: "us-central1", cors: true, secrets: [telegramBotToken] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Faqat POST" });
      return;
    }
    const phone = req.body?.phone;
    if (typeof phone !== "string" || !phone) {
      res.status(400).json({ error: "Telefon raqami kerak" });
      return;
    }

    try {
      const driverRef = db.collection("drivers").doc(phone);
      const snap = await driverRef.get();
      const chatId = snap.data()?.telegramChatId;

      if (chatId) {
        try {
          await sendTelegramMessage(
            chatId,
            "Afsuski, Sevimli Go haydovchi arizangiz rad etildi. Qo'shimcha ma'lumot uchun qo'llab-quvvatlash xizmatiga murojaat qiling."
          );
        } catch (error) {
          logger.error(`Haydovchi (${phone}) rad etish xabarini yuborishda xato:`, error);
        }
      }

      await driverRef.delete();
      res.status(200).json({ ok: true });
    } catch (error) {
      logger.error(`Haydovchini rad etishda xato (${phone}):`, error);
      res.status(500).json({ error: "Rad etishda xatolik yuz berdi" });
    }
  }
);

// ============================================================
// DASHBOARD XODIMLARI (ROL TIZIMI) — /admin, /manager, /depecher
// bo'limlariga kirish uchun. Har bir xodim o'z Firebase Auth
// hisobiga (email+parol) ega bo'ladi, roli esa adminRoles/{uid}
// hujjatida saqlanadi — Firestore xavfsizlik qoidalari ham shu
// hujjatni o'qib, ma'lumotlarga kirishni cheklaydi (faqat interfeys
// emas, haqiqiy himoya).
// ============================================================
export const createStaffAccount = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Tizimga kiring");
  }

  // Faqat 'admin' roli boshqa xodim hisobini yarata oladi — bu
  // tekshiruv Firestore qoidalaridagi bilan bir xil mantiq, lekin
  // bu yerda alohida qayta tekshiriladi, chunki Cloud Function
  // Admin SDK orqali ishlagani sabab Firestore qoidalarini
  // umuman aylanib o'tadi.
  const callerRoleDoc = await db.collection("adminRoles").doc(callerUid).get();
  if (callerRoleDoc.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Faqat administrator xodim qo'sha oladi");
  }

  const { email, password, role, name, branches } = request.data || {};
  if (typeof email !== "string" || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "Email noto'g'ri formatda");
  }
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError("invalid-argument", "Parol kamida 6 belgidan iborat bo'lishi kerak");
  }
  if (!["admin", "manager", "depecher"].includes(role)) {
    throw new HttpsError("invalid-argument", "Rol noto'g'ri");
  }

  try {
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: typeof name === "string" ? name : undefined,
    });
    await db.collection("adminRoles").doc(userRecord.uid).set({
      email,
      role,
      name: typeof name === "string" ? name : "",
      branches: Array.isArray(branches) ? branches : [],
      createdAt: FieldValue.serverTimestamp(),
      createdBy: callerUid,
    });
    return { uid: userRecord.uid };
  } catch (error: any) {
    logger.error("Xodim hisobini yaratishda xato:", error);
    if (error?.code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "Bu email allaqachon ro'yxatdan o'tgan");
    }
    throw new HttpsError("internal", "Hisob yaratishda xatolik yuz berdi");
  }
});

// Rolni o'chirish (hisobni butunlay o'chirish emas — Firebase Auth
// hisobi qoladi, lekin adminRoles hujjati o'chgach, keyingi safar
// kirishga urinishda "rol topilmadi" deb rad etiladi). Shunchaki
// Firestore hujjatini o'chirish yetarli bo'lgani uchun bu alohida
// Cloud Function talab qilmaydi — dashboard to'g'ridan-to'g'ri
// o'chira oladi (Firestore qoidalari faqat 'admin' rolga ruxsat beradi).

// ============================================================
// "ARVOH ONLAYN" HAYDOVCHILARNI AVTOMATIK TOZALASH
// ============================================================
// `isOnline` — shunchaki hujjatdagi bayroq, va uni tozalaydigan kod
// FAQAT ilovaning ichida bor. Ilova o'ldirilganda (Android xotira
// uchun yopdi, telefon o'chdi/zaryadi tugadi, haydovchi ro'yxatdan
// surib tashladi, ilova quladi) hech kim uni tozalamaydi.
//
// 2026-08-17 da jonli bazada 64 ta haydovchidan 33 tasi "onlayn"
// ko'rinardi — ulardan atigi 7 tasi haqiqatan ishlayotgan edi.
// Qolgan 26 tasi soatlab (ba'zilari bir necha KUN) jim turgan.
//
// Zarari:
//   * dispetcher panelida ishlayotgan haydovchilar soni yolg'on;
//   * mijoz ilovasida "yaqin atrofda N ta mashina" soni yolg'on;
//   * dispatch navbati ularni ham hisobga olardi (bu endi
//     DRIVER_DISPATCH_STALE_MS bilan hal qilingan).
//
// Ilova tomonidagi tuzatishlar (chiqishda bo'shatish, ochilishda
// tozalash) YANGI versiya bilan keladi va eski versiyalarda
// ishlamaydi. Bu vazifa esa SERVER tomonda ishlaydi — ilova qaysi
// versiyada bo'lishidan qat'i nazar.
//
// MUHIM: `updatedAt` ATAYLAB YOZILMAYDI. Aks holda arvoh haydovchi
// "hozirgina yangilangan" bo'lib ko'rinib, eski koordinatasi yangiday
// qabul qilinardi.
// Chegara ATAYLAB keng (bir soat). Bu yerda xatoning narxi
// nosimmetrik: ortiqcha kutish faqat panelda bitta eskirgan yozuv
// qoldiradi, erta bosish esa ISHLAYOTGAN haydovchini buyurtmasiz
// qoldiradi. Haqiqiy muammo — soatlab/kunlab osilib qolganlar, ular
// bu chegaradan baribir o'tadi.
const GHOST_ONLINE_STALE_MS = 60 * 60 * 1000;

export const cleanupGhostOnlineDrivers = onSchedule(
  {
    schedule: "every 15 minutes",
    timeZone: "Asia/Tashkent",
    timeoutSeconds: 300,
    memory: "256MiB",
  },
  async () => {
    let snapshot;
    try {
      snapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Arvoh haydovchilarni qidirishda xato:", error);
      return;
    }

    const now = Date.now();
    let offlined = 0;
    let busyCleared = 0;
    let keptBusy = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      // MUHIM: bu yerda AYNAN `driverLastSeenMillis` — "seans tirikmi",
      // "koordinatasi yangimi" EMAS. Farqi katta, izohi funksiya ustida.
      const lastSeen = driverLastSeenMillis(data);
      if (lastSeen !== 0 && now - lastSeen <= GHOST_ONLINE_STALE_MS) continue;

      const patch: Record<string, unknown> = { isOnline: false };

      // "Band" bayrog'i faqat HAQIQATAN tugallanmagan safar
      // bo'lmaganda tozalanadi. Safar o'rtasida ilovasi o'lgan
      // haydovchi qaytib kelganda buyurtma hamon uniki bo'lishi
      // kerak — bayroqni tozalash unga IKKINCHI buyurtma
      // yuborilishiga yo'l ochib qo'yardi.
      if (data.busy === true) {
        let hasActive = false;
        try {
          for (const status of ACTIVE_ORDER_STATUSES) {
            const orders = await db
              .collection("orders")
              .where("driverId", "==", doc.id)
              .where("status", "==", status)
              .limit(1)
              .get();
            if (!orders.empty) { hasActive = true; break; }
          }
        } catch (error) {
          // Tekshirib bo'lmadi — xavfsiz tomoni: tegmaslik.
          logger.warn(`${doc.id}: faol buyurtmani tekshirib bo'lmadi`, error);
          hasActive = true;
        }
        if (hasActive) keptBusy++;
        else { patch.busy = false; busyCleared++; }
      }

      try {
        await doc.ref.update(patch);
        offlined++;
      } catch (error) {
        logger.warn(`${doc.id}: oflayn qilishda xato`, error);
      }
    }

    if (offlined > 0 || keptBusy > 0) {
      logger.info(
        `Arvoh tozalash: ${snapshot.size} ta "onlayn"dan ${offlined} tasi oflayn qilindi, ` +
          `${busyCleared} ta "band" tozalandi, ${keptBusy} tasida safar bor edi`
      );
    }
  }
);


// ============================================================
// `bonusUsed` NI SERVER TOMONDA CHEKLASH
// ============================================================
// `bonusUsed` — mijoz bonusidan qancha yechilishini belgilaydigan
// maydon, va uni MIJOZ ILOVASI yozadi. Safar yakunlanganda kompaniya
// aynan shu summani haydovchiga naqd pulda QOPLAB BERADI
// (onOrderCompletedApplyBonus). Ya'ni bu maydon — to'g'ridan-to'g'ri
// pul.
//
// Firestore qoidalari uni faqat buyurtma EGASI yozishini
// ta'minlaydi, lekin QANCHA yozishini cheklay olmaydi: qoidalar
// boshqa hujjatdagi (customers/{uid}.bonusBalance) qiymat bilan
// solishtira olmaydi. Ya'ni o'zgartirilgan ilova bilan mijoz balansida
// 0 bonus bilan `bonusUsed: 500000` yozib, safarni bepul qilib olishi,
// kompaniya esa haydovchiga o'sha 500 000 ni to'lab berishi mumkin edi.
//
// Shuning uchun tekshiruv SERVER tomonda, safar boshlanishidan oldin
// bajariladi: bonus mijozning HAQIQIY balansidan va safar narxidan
// oshib ketolmaydi. Tuzatish darhol yoziladi, ya'ni haydovchi ham,
// mijoz ham ekranda to'g'ri summani ko'radi.
//
// Halqa xavfi yo'q: tuzatishdan keyingi qayta ishga tushishda
// `bonusUsed` allaqachon chegara ichida bo'ladi va funksiya hech
// narsa yozmaydi.
const BONUS_EDITABLE_STATUSES = ["pending", "accepted", "arrived", "in_progress"];

export const onOrderBonusUsedClamp = onDocumentWritten(
  "orders/{orderId}",
  async (event) => {
    const after = event.data?.after;
    if (!after?.exists) return;
    const o = after.data();
    if (!o) return;

    // Safar yakunlangandan keyin tegmaymiz — u yerda hisob-kitob
    // allaqachon bo'lgan.
    if (!BONUS_EDITABLE_STATUSES.includes(o.status)) return;

    const claimed = typeof o.bonusUsed === "number" ? o.bonusUsed : 0;
    if (claimed <= 0) return;

    // Qiymat o'zgarmagan bo'lsa qayta tekshirmaymiz (har bir yozuvda
    // mijoz hujjatini o'qib o'tirmaslik uchun).
    const before = event.data?.before;
    const prevClaimed =
      before?.exists && typeof before.data()?.bonusUsed === "number"
        ? before.data()!.bonusUsed
        : null;
    const prevTotal = before?.exists ? computeTripTotal(before.data()!) : null;
    const tripTotal = computeTripTotal(o);
    if (prevClaimed === claimed && prevTotal === tripTotal) return;

    const orderId = event.params.orderId;
    const customerId: unknown = o.customerId;

    // Mijozsiz buyurtma (dispetcher paneldan yaratilgan) — bunda
    // mijoz bonusi tushunchasi umuman yo'q, chunki balansni yechadigan
    // hisob ham yo'q.
    if (typeof customerId !== "string" || !customerId) {
      logger.warn(
        `Buyurtma ${orderId}: customerId yo'q, lekin bonusUsed=${claimed} — nolga tushirildi`
      );
      await after.ref.update({ bonusUsed: 0, finalPrice: Math.max(0, tripTotal) });
      return;
    }

    let balance = 0;
    try {
      const snap = await db.collection("customers").doc(customerId).get();
      const raw = snap.data()?.bonusBalance;
      balance = typeof raw === "number" ? raw : 0;
    } catch (error) {
      // O'qib bo'lmadi — tegmaymiz. Kamaytirmaslik xavfsizroq:
      // mijozga ko'rsatilgan chegirmani o'zgartirib yuborish ham
      // zarar (u boshqa summani kutadi).
      logger.warn(`Buyurtma ${orderId}: mijoz balansini o'qib bo'lmadi`, error);
      return;
    }

    const allowed = Math.max(0, Math.min(claimed, balance, tripTotal));
    if (allowed === claimed) return;

    await after.ref.update({
      bonusUsed: allowed,
      finalPrice: Math.max(0, tripTotal - allowed),
    });
    logger.warn(
      `Buyurtma ${orderId}: bonusUsed ${claimed} -> ${allowed} ` +
        `(mijoz balansi: ${balance}, safar qiymati: ${tripTotal})`
    );
  }
);

// ============================================================
// HAYDOVCHI REYTINGI — mijozning bahosidan
// ============================================================
// Mijoz safar oxirida yulduzcha qo'yadi. Baho `orders/{id}` ga
// yoziladi (`customerRating`), chunki buyurtma mijozniki va
// Firestore qoidalari uni himoya qila oladi.
//
// Haydovchi hujjatiga to'g'ridan-to'g'ri yozib bo'lmaydi: haydovchi
// ilovasida Firebase Auth yo'q, ya'ni `drivers/{id}` autentifikatsiyasiz
// yoziladi — u yerga bahoni mijoz ilovasidan yozish har kimga
// istalgan haydovchining reytingini "chizib qo'yish"ga yo'l ochib
// berardi. O'rtachani shu funksiya hisoblaydi (Admin SDK).
//
// Halqa xavfi yo'q: bu funksiya `drivers` hujjatini yozadi, o'zi esa
// `orders` o'zgarishini tinglaydi.
export const onOrderRatedUpdateDriverRating = onDocumentUpdated(
  "orders/{orderId}",
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after) return;

    const rating = after.customerRating;
    if (typeof rating !== "number") return;
    // Faqat YANGI baho (yoki o'zgargan baho) hisobga olinadi.
    if (before && before.customerRating === rating) return;
    if (after.ratingCounted === true && before?.customerRating === rating) return;

    const driverId: unknown = after.driverId;
    if (typeof driverId !== "string" || !driverId) return;

    const orderId = event.params.orderId;
    const clamped = Math.max(1, Math.min(5, Math.round(rating)));
    const driverRef = db.collection("drivers").doc(driverId);
    const orderRef = event.data!.after.ref;

    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const o = orderSnap.data();
        // Ikki marta hisoblanmasin.
        if (!o || o.ratingCounted === true) return;
        const driverSnap = await tx.get(driverRef);
        const d = driverSnap.data() || {};
        const count = typeof d.ratingCount === "number" ? d.ratingCount : 0;
        const avg = typeof d.rating === "number" ? d.rating : 0;
        // Yangi o'rtacha: eski o'rtacha * soni + yangi baho, hammasi
        // yangi songa bo'linadi. Ikki xonagacha yaxlitlanadi.
        const nextCount = count + 1;
        const nextAvg = Math.round(((avg * count + clamped) / nextCount) * 100) / 100;

        tx.set(driverRef, { rating: nextAvg, ratingCount: nextCount }, { merge: true });
        tx.set(orderRef, { ratingCounted: true }, { merge: true });

        logger.info(
          `Buyurtma ${orderId}: haydovchi ${driverId} bahosi ${clamped} — ` +
            `o'rtacha ${avg} (${count} ta) -> ${nextAvg} (${nextCount} ta)`
        );
      });
    } catch (error) {
      logger.error(`Reytingni yangilashda xato (buyurtma ${orderId}):`, error);
    }
  }
);
