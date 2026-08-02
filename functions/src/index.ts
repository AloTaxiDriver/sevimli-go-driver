import { randomBytes } from "crypto";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";
import { onDocumentCreated, onDocumentUpdated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
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

async function getDispatchSettings(): Promise<{
  radiusMeters: number;
  timeoutSeconds: number;
}> {
  try {
    const doc = await db.collection("settings").doc("dispatch").get();
    const data = doc.data();
    return {
      radiusMeters: typeof data?.radiusMeters === "number" ? data.radiusMeters : 1500,
      timeoutSeconds: typeof data?.timeoutSeconds === "number" ? data.timeoutSeconds : 20,
    };
  } catch {
    return { radiusMeters: 1500, timeoutSeconds: 20 };
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
async function getBonusSettings(): Promise<{
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
    const doc = await db.collection("settings").doc("bonus").get();
    const data = doc.data();
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

// Berilgan yo'l narxi va bonus sozlamalari asosida, bitta buyurtmada
// ishlatilishi mumkin bo'lgan ENG KATTA bonus summasini hisoblaydi —
// mijoz balansidan tashqari qo'shimcha cheklov sifatida. Server tomonda
// ham qo'llaniladi (mijoz o'zboshimchalik bilan kattaroq `bonusUsed`
// yuborib bo'lmasligi uchun) va mijoz ilovasida ham xuddi shu formula.
function computePerOrderBonusCap(
  price: number,
  settings: { perOrderCapType: "amount" | "percent"; perOrderCapValue: number }
): number {
  return settings.perOrderCapType === "amount"
    ? settings.perOrderCapValue
    : Math.floor((price * settings.perOrderCapValue) / 100);
}

async function isOrderStillPending(orderId: string): Promise<boolean> {
  try {
    const doc = await db.collection("orders").doc(orderId).get();
    return doc.data()?.status === "pending";
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

    // ── POOL BUYURTMA — KETMA-KET DISPATCH ───────────────────
    const settings = await getDispatchSettings();
    const radiusCfg = await getRadiusConfig();
    logger.info(
      `Dispatch sozlamalari — radius: ${settings.radiusMeters}m, timeout: ${settings.timeoutSeconds}s`
    );

    let driversSnapshot;
    try {
      driversSnapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Haydovchilarni olishda xato:", error);
      return;
    }

    type DriverInfo = { id: string; token: string; distance: number };

    const nearbyDrivers: DriverInfo[] = [];
    // MUHIM: allDrivers endi id+token juftligi bilan saqlanadi,
    // shunda broadcast bosqichida nearbyDrivers'da bo'lganlarni
    // chiqarib tashlashimiz mumkin (ular allaqachon push oldi)
    const allDrivers: { id: string; token: string }[] = [];

    const pickupLat: number | undefined = order.pickupLat;
    const pickupLng: number | undefined = order.pickupLng;

    driversSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.pushToken) return;
      if (!isDriverEligibleForOrder(data, pickupLat, pickupLng, radiusCfg)) return;

      allDrivers.push({ id: doc.id, token: data.pushToken });

      if (pickupLat != null && pickupLng != null && data.lat != null && data.lng != null) {
        const dist = getDistanceMeters(pickupLat, pickupLng, data.lat, data.lng);
        if (dist <= settings.radiusMeters) {
          nearbyDrivers.push({ id: doc.id, token: data.pushToken, distance: dist });
        }
      }
    });

    nearbyDrivers.sort((a, b) => a.distance - b.distance);

    logger.info(
      `Buyurtma ${orderId}: ${nearbyDrivers.length} ta yaqin haydovchi, ` +
        `${allDrivers.length} ta jami online haydovchi`
    );

    // ── RADIUS ICHIDAGI HAYDOVCHILAR YO'Q ────────────────────
    if (nearbyDrivers.length === 0) {
      logger.info(`Radius ichida haydovchi yo'q — barcha onlaynlarga broadcast`);
      const tokens = allDrivers.map((d) => d.token);
      if (tokens.length > 0) {
        try {
          const response = await messaging.sendEachForMulticast({
            tokens,
            data: dataPayload,
            android: { priority: "high" },
          });
          logger.info(
            `Broadcast: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
          );
        } catch (error) {
          logger.error("Broadcast xatosi:", error);
        }
      }
      return;
    }

    // ── KETMA-KET DISPATCH ────────────────────────────────────
    // MUHIM: har bir haydovchidan keyin, KEYINGISIGA o'tishdan
    // OLDIN sleep qilamiz (oldingi versiyada bu shart faqat
    // "oxirgi bo'lmagan" holatlar uchun edi, va OXIRGI haydovchidan
    // keyin QOSHIMCHA sleep + BROADCAST bo'lardi — bu esa
    // ORTIQCHA push'ga sabab bo'lardi, chunki broadcast ro'yxatida
    // ALLAQACHON push olgan haydovchilar ham bor edi).
    const notifiedDriverIds = new Set<string>();

    for (let i = 0; i < nearbyDrivers.length; i++) {
      const driver = nearbyDrivers[i];

      const stillPending = await isOrderStillPending(orderId);
      if (!stillPending) {
        logger.info(`Buyurtma ${orderId} qabul qilindi yoki bekor qilindi (${i}. haydovchida)`);
        return;
      }

      logger.info(
        `Buyurtma ${orderId} → haydovchi ${driver.id} ` +
          `(masofa: ${Math.round(driver.distance)}m, navbat: ${i + 1}/${nearbyDrivers.length})`
      );

      await sendPushToToken(driver.token, orderId, dataPayload);
      notifiedDriverIds.add(driver.id);

      // Har doim (oxirgisi bo'lsa ham) navbatdagi tekshiruv/broadcast'dan
      // oldin kutamiz — shu bilan haydovchiga qabul qilish uchun
      // yetarli vaqt beriladi.
      await sleep(settings.timeoutSeconds * 1000);
    }

    // ── BARCHA YAQIN HAYDOVCHILAR TUGADI ─────────────────────
    const stillPendingAfterAll = await isOrderStillPending(orderId);
    if (!stillPendingAfterAll) {
      logger.info(`Buyurtma ${orderId} yaqin haydovchilar tugashidan oldin qabul qilindi`);
      return;
    }

    // MUHIM TUZATISH: broadcast faqat ALLAQACHON PUSH OLMAGAN
    // haydovchilarga yuboriladi — shu bilan bir xil haydovchiga
    // ikkinchi marta (overlay qayta chiqishiga sabab bo'ladigan)
    // push yuborilishining oldi olinadi.
    const remainingTokens = allDrivers
      .filter((d) => !notifiedDriverIds.has(d.id))
      .map((d) => d.token);

    logger.info(
      `Buyurtma ${orderId}: barcha yaqin haydovchilar rad etdi — ` +
        `${remainingTokens.length} ta qolgan online haydovchiga broadcast`
    );

    if (remainingTokens.length > 0) {
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: remainingTokens,
          data: dataPayload,
          android: { priority: "high" },
        });
        logger.info(
          `Broadcast natija: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
        );
      } catch (error) {
        logger.error("Broadcast xatosi:", error);
      }
    } else {
      logger.info(`Buyurtma ${orderId}: broadcast qilinadigan qolgan haydovchi yo'q`);
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
// (yakuniy, metrланган narx bilan `price`ni qayta yozadi) — bittasi
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
    const bonusSettings = await getBonusSettings();

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

        const price = typeof orderData.price === "number" ? orderData.price : 0;
        const bonusUsed = typeof orderData.bonusUsed === "number" ? Math.max(0, orderData.bonusUsed) : 0;
        const earnAmount = Math.floor((price * bonusSettings.earnPercent) / 100);

        // Mijoz haqiqatan ham bonus ishlatishga huquqli bo'lganini
        // (minBalanceToUse) va bitta buyurtma uchun admin belgilagan
        // chegaradan (perOrderCap) oshmaganini SERVER TOMONDA qayta
        // tekshiramiz — mijoz ilovasi `bonusUsed`ni o'zboshimchalik
        // bilan kattaroq yuborsa ham, undan ortig'i hech qachon
        // balansdan yechilmaydi.
        const eligible = currentBalance >= bonusSettings.minBalanceToUse;
        const perOrderCap = eligible ? computePerOrderBonusCap(price, bonusSettings) : 0;
        const actualSpent = eligible ? Math.min(bonusUsed, currentBalance, perOrderCap) : 0;
        const newBalance = currentBalance - actualSpent + earnAmount;

        tx.set(customerRef, { bonusBalance: newBalance }, { merge: true });
        tx.set(orderRef, { bonusApplied: true }, { merge: true });

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
            `narx: ${price}, sarflangan: ${actualSpent}, olingan: ${earnAmount}`
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
    const driverRef = db.collection("drivers").doc(driverId);

    try {
      await db.runTransaction(async (tx) => {
        const orderSnap = await tx.get(orderRef);
        const orderData = orderSnap.data();
        if (!orderData || orderData.status !== "completed" || orderData.commissionApplied) {
          return;
        }

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

        // Haydovchi mijozdan haqiqatda naqd olgan summa (bonus/qo'shimcha
        // xizmatlar hisobga olingan) — shu summadan komissiya hisoblanadi.
        const price =
          typeof orderData.finalPrice === "number"
            ? orderData.finalPrice
            : typeof orderData.price === "number"
            ? orderData.price
            : 0;
        const commissionAmount =
          commissionType === "fixed" ? driverCommission : Math.round((price * driverCommission) / 100);

        const driverDoc = await tx.get(driverRef);
        const currentBalance =
          typeof driverDoc.data()?.balance === "number" ? driverDoc.data()!.balance : 0;
        const newBalance = currentBalance - commissionAmount;

        tx.set(driverRef, { balance: newBalance }, { merge: true });
        tx.set(orderRef, { commissionApplied: true }, { merge: true });

        logger.info(
          `Buyurtma ${orderId}: komissiya yechildi (haydovchi ${driverId}) — ` +
            `narx: ${price}, komissiya: ${commissionAmount}, yangi balans: ${newBalance}`
        );
      });
    } catch (error) {
      logger.error(`Komissiya tranzaksiyasi xatosi (buyurtma ${orderId}):`, error);
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
    // "completed" holati uchun narx maydoni yakuniy (metrланган) qiymat
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