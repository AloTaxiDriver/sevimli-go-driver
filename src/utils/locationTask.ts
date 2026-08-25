// src/utils/locationTask.ts
//
// HAYDOVCHI JOYLASHUVINI FON REJIMIDA YUBORISH
// ============================================================
// Avval joylashuv MapScreen ichidagi oddiy setInterval orqali har 10
// soniyada yozilardi. setInterval — JavaScript taymeri: ilova ekrandan
// yo'qolishi bilan (haydovchi Telegram'ga o'tdi, qo'ng'iroqqa javob
// berdi, ekranni o'chirdi) u to'xtaydi. Natijada:
//   - dispetcher panelida haydovchi ESKI joyda turaverardi;
//   - Android xotira kerak bo'lganda ilovani jimgina o'ldirardi, chunki
//     uni "faol ishlayotgan" deb hisoblash uchun hech qanday sabab
//     yo'q edi — safar o'rtasida ilova o'chib qolishining asosiy sababi
//     aynan shu.
//
// Endi joylashuv Android'ning FOREGROUND SERVICE'i orqali kuzatiladi:
// haydovchi onlayn bo'lganda doimiy bildirishnoma chiqadi va shu
// bildirishnoma turgan ekan, tizim ilovani o'ldirmaydi. Yandex/Uber
// kabi ilovalar ham aynan shunday ishlaydi.
//
// MUHIM: bu vazifa (task) ILOVA DARAJASIDA, komponentdan tashqarida
// ro'yxatdan o'tkazilishi shart — Android uni ilova butunlay yopilgandan
// keyin ham qayta ishga tushirishi mumkin, o'shanda hech qanday React
// komponenti mavjud bo'lmaydi. Shu sababli haydovchi ID'si props orqali
// emas, AsyncStorage orqali uzatiladi.

import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { getBackgroundLocationConsent } from './backgroundLocationConsent';
import { LOCATION_TASK_DRIVER_ID_KEY, SAVED_PHONE_KEY } from './sessionKeys';
import { addTripPoint } from './tripMeter';
import { recordTrackPoints } from './tripTrack';

export const DRIVER_LOCATION_TASK = 'sevimli-go-driver-location';
const DRIVER_ID_KEY = LOCATION_TASK_DRIVER_ID_KEY;

type LocationTaskPayload = {
  locations?: Location.LocationObject[];
};

TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Joylashuv vazifasi xatosi:', error);
    return;
  }
  const { locations } = (data || {}) as LocationTaskPayload;
  if (!locations || locations.length === 0) return;

  // MUHIM: Android joylashuvlarni TO'PLAB yetkazadi. Telefon uyquga
  // ketganda tizim ilovani har 10 soniyada uyg'otmaydi — nuqtalarni
  // yig'ib turadi va bir necha daqiqadan keyin HAMMASINI bitta
  // chaqiruvda beradi. `locations` ro'yxat bo'lishining sababi shu.
  //
  // Avval bu yerda faqat OXIRGISI olinardi:
  //
  //     const latest = locations?.[locations.length - 1];
  //
  // qolgani esa jimgina yo'qolardi. Ikkita haqiqiy buyurtmada
  // o'lchandi (21.08.2026): 22 nuqta yozilgan joyda ~82 tasi,
  // 60 nuqta yozilgan joyda ~112 tasi bo'lishi kerak edi. Eng
  // katta bo'shliqlar — 8 daqiqa 37 soniya va 7 daqiqa 08 soniya.
  // Haydovchi mijozni olib borib qaytgan, xaritada esa qaytish
  // yo'li umuman ko'rinmagan: iz ko'l ustidan to'g'ri chiziq bo'lib
  // kesib o'tgan, masofa ham o'sha to'g'ri chiziq bo'yicha
  // o'lchanib, yakuniy summa kam chiqqan.
  const ordered = [...locations].sort((a, b) => a.timestamp - b.timestamp);
  const latest = ordered[ordered.length - 1];

  try {
    const driverId = await AsyncStorage.getItem(DRIVER_ID_KEY);
    if (!driverId) return;

    // MUHIM: joylashuv AYNAN hozir tizimga kirgan haydovchining
    // hujjatiga yozilishi kerak. Bu vazifa React'dan tashqarida
    // ishlaydi va kimni yozishini faqat yuqoridagi kalitdan biladi —
    // ya'ni u ESKIRIB qolishi mumkin:
    //
    //   * ilova onlayn holatda o'ldirilgan bo'lsa, foreground service
    //     tirik qoladi (killServiceOnDestroy: false) va u eski
    //     haydovchining ID'si bilan ishlashda davom etadi;
    //   * shu telefonda BOSHQA haydovchi tizimga kirsa, o'sha xizmat
    //     hali ham eskisining hujjatiga yozib turardi — ya'ni
    //     dispetcher panelida allaqachon uyiga ketgan haydovchi
    //     shahar bo'ylab "yurib" ko'rinardi, yangisi esa umuman
    //     ko'rinmasdi.
    //
    // Shuning uchun ikkita MUSTAQIL kalit solishtiriladi: kuzatuv
    // kimniki ekani va kim tizimga kirgani (AuthContext yuritadi).
    // Ular mos kelmasa hech narsa yozilmaydi va kuzatuv to'xtatiladi.
    const signedInPhone = await AsyncStorage.getItem(SAVED_PHONE_KEY);
    if (signedInPhone !== driverId) {
      console.warn(
        `Joylashuv vazifasi eskirgan haydovchi uchun ishlayapti (${driverId}), ` +
          `tizimda: ${signedInPhone || "hech kim"} — to'xtatilmoqda`
      );
      await stopDriverLocationTracking();
      return;
    }

    await firestore()
      .collection('drivers')
      .doc(driverId)
      .set(
        {
          lat: latest.coords.latitude,
          lng: latest.coords.longitude,
          updatedAt: firestore.FieldValue.serverTimestamp(),
          // MUHIM: `locationUpdatedAt` — AYNAN koordinata qachon
          // yangilangani. Uni FAQAT shu joy yozadi.
          //
          // Dispetcher paneli ham, mijoz ilovasi ham "joylashuv
          // eskirganmi" degan qarorni shu vaqtga qarab chiqaradi. Avval
          // ular umumiy `updatedAt`ga qarardi, holbuki uni push tokeni
          // saqlanganda va "band" holati o'zgarganda ham yozib
          // ketilardi — ya'ni GPS o'lgan haydovchi ilovani ochib
          // qo'yishining o'zi uning ESKI koordinatasini "yangi" qilib
          // ko'rsatardi. Dispetcher unga buyurtma yuborardi, mijoz esa
          // xaritada aslida boshqa joydagi mashinani ko'rardi.
          locationUpdatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    // Faol safar bo'lsa, shu nuqta yo'l iziga ham qo'shiladi.
    // Ataylab `await` bilan: fon vazifasi qaytgach Android jarayonni
    // to'xtatib qo'yishi mumkin, ya'ni "keyin bajariladi" degan
    // yozuv umuman ketmay qolardi.
    // Yo'l iziga BUTUN to'plam yoziladi. Vaqt sifatida GPS o'lchagan
    // payt ishlatiladi — yetkazilgan payt emas, aks holda to'plangan
    // nuqtalarning hammasi bir xil vaqt olib, tartibi buzilardi.
    await recordTrackPoints(
      driverId,
      ordered.map((l) => ({
        lat: l.coords.latitude,
        lng: l.coords.longitude,
        t: l.timestamp,
      }))
    );

    // MUHIM: safar narxi shu qatorga bog'liq. Avval masofa FAQAT
    // MapScreen ichidagi `watchPositionAsync` orqali hisoblanardi — u
    // esa ilova ekranda turgandagina ishonchli ishlaydi. Haydovchi
    // navigatorga o'tsa yoki ekranni o'chirsa, o'sha vaqtdagi butun
    // yo'l hisobga olinmasdi va safar minimal narxda tugardi.
    //
    // Bu yerdagi nuqta va MapScreen'dagi nuqta bitta hisoblagichga
    // tushadi; har qabul qilingan nuqta langarni o'ziga ko'chirgani
    // uchun ikki marta hisoblash bo'lmaydi.
    // Hisoblagichga ham HAMMASI, vaqt tartibida beriladi — shunda u
    // yo'lni haqiqiy ketma-ketlik bo'yicha o'lchaydi.
    for (const l of ordered) {
      await addTripPoint(
        l.coords.latitude,
        l.coords.longitude,
        l.coords.accuracy,
        l.timestamp
      );
    }
  } catch (e) {
    console.warn('Fon rejimida joylashuvni yozishda xato:', e);
  }
});

// ============================================================
// BOSHLASH/TO'XTATISH POYGASI
// ============================================================
// Kuzatuvni boshlash — uzun asinxron zanjir: AsyncStorage yozuvi,
// ruxsat tekshiruvlari, ehtimol TIZIM RUXSAT OYNASI (u ochiq turganda
// bir necha soniya o'tishi mumkin), va nihoyat
// `startLocationUpdatesAsync`. To'xtatish ham asinxron.
//
// Ikkalasi ham kutilmasdan (fire-and-forget) chaqiriladi, shuning uchun
// ular BIR-BIRINING USTIGA tushishi mumkin edi:
//
//   haydovchi onlayn bo'ldi -> boshlash zanjiri ketdi (2 soniya)
//   haydovchi 1 soniyada oflayn bo'ldi -> to'xtatish chaqirildi, lekin
//     `hasStartedLocationUpdatesAsync` hali FALSE qaytardi (boshlash
//     tugamagan) -> to'xtatish hech narsa qilmadi
//   boshlash zanjiri tugadi -> XIZMAT YONDI
//
// Natijada haydovchi oflayn bo'la turib, doimiy bildirishnoma bilan
// qolardi va joylashuvi yuborilaverardi. Uni o'chirishning yagona
// yo'li — qayta onlayn bo'lib, yana oflayn bo'lish edi.
//
// Yechim: buyruqlar holatni to'g'ridan-to'g'ri o'zgartirmaydi, balki
// "KUZATUV YOQILGAN BO'LISHI KERAKMI" degan yagona niyatni yozadi
// (`desiredTracking`), so'ng navbat (`trackingQueue`) orqali birma-bir
// bajariladigan yarashtiruvchi haqiqatni shu niyatga moslaydi.
let desiredTracking = false;
let trackingDriverId: string | null = null;
let trackingQueue: Promise<void> = Promise.resolve();

function enqueueTrackingWork(work: () => Promise<void>): Promise<void> {
  // `.then(work, work)` — oldingi ish xato bilan tugasa ham navbat
  // to'xtab qolmasin.
  trackingQueue = trackingQueue.then(work, work);
  return trackingQueue;
}

/** Fon rejimida joylashuv kuzatuvini boshlaydi (haydovchi onlayn
 * bo'lganda). Qayta chaqirilsa hech narsa buzilmaydi — allaqachon
 * ishlab turgan bo'lsa qayta ishga tushirilmaydi. */
export async function startDriverLocationTracking(driverId: string): Promise<void> {
  desiredTracking = true;
  trackingDriverId = driverId;
  return enqueueTrackingWork(() => applyDesiredTracking());
}

async function beginTracking(driverId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(DRIVER_ID_KEY, driverId);

    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) return;

    // MUHIM: fon ruxsatini SO'RASHDAN OLDIN foydalanuvchi ilova ichidagi
    // tushuntirishni ko'rib, aniq rozilik bergan bo'lishi SHART — bu
    // Google Play talabi (Prominent Disclosure). Avval bu yerda tizim
    // oynasi to'g'ridan-to'g'ri, hech qanday tushuntirishsiz
    // chaqirilardi; bunday ilovani Google rad etadi.
    //
    // Rozilik berilmagan bo'lsa ham kuzatuv BOSHLANADI: foreground
    // service ishlayotgan paytda Android fon ruxsatini talab qilmaydi.
    // Ya'ni haydovchi rad etsa ham ishlay oladi, faqat ilova butunlay
    // yopilganda kuzatuv to'xtaydi.
    // MUHIM: fon ruxsati bu yerda SO'RALMAYDI. U faqat bitta joyda —
    // oshkora tushuntirish oynasi qabul qilingan zahoti so'raladi
    // (MapScreen.handleBgLocationDisclosure). Google Play talabi shu:
    // tizim oynasi tushuntirishdan keyin darhol chiqishi kerak.
    //
    // Bu yerda so'rash ikki xatoga olib kelardi: (1) tushuntirish bilan
    // so'rov orasiga bir nechta async qadam tushardi, (2) ilova keyingi
    // safar ochilganda so'rov hech qanday tushuntirishsiz chiqishi
    // mumkin edi. Ikkalasi ham siyosat buzilishi.

    // MUHIM: ruxsat oynasi ochiq turgan vaqt ichida (u soniyalab
    // cho'zilishi mumkin) haydovchi oflayn bo'lib ulgurgan bo'lishi
    // mumkin. Xizmatni yoqishdan OLDIN niyatni oxirgi marta
    // tekshiramiz.
    if (!desiredTracking) return;

    const already = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if (already) return;

    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 10000,
      // MUHIM: 0 bo'lishi SHART. Bu yerda avval 20 (metr) turardi va bu
      // og'ir xato edi — Android'da `distanceInterval` VA mantig'i bilan
      // ishlaydi, YOKI emas: expo-location uni `setMinUpdateDistanceMeters`
      // ga o'giradi (node_modules/expo-location/.../LocationHelpers.kt),
      // ya'ni yangilanish faqat "10 soniya o'tdi VA 20 metr YURILDI"
      // bo'lgandagina yetkaziladi.
      //
      // Demak svetoforda, tirbandlikda yoki mijozni kutib turgan
      // haydovchidan HECH QANDAY yangilanish kelmasdi. Dashboard esa
      // 90 soniyadan keyin joylashuvni "eskirgan" deb belgilaydi
      // (DRIVER_LOCATION_STALE_MS) — dispetcher ishlab turgan
      // haydovchini "aloqa uzilgan" deb ko'rardi, mijoz esa xaritada
      // qotib qolgan mashinani.
      //
      // 0 bilan yangilanish faqat vaqt bo'yicha, har 10 soniyada
      // keladi — bu ilovaning fon-rejimga o'tishidan oldingi
      // xatti-harakati bilan bir xil.
      distanceInterval: 0,
      // Shu bildirishnoma turgan ekan, Android ilovani o'ldirmaydi.
      foregroundService: {
        notificationTitle: 'Sevimli Go — ish rejimi',
        notificationBody: 'Buyurtmalarni qabul qilyapsiz. Joylashuv dispetcherga yuborilmoqda.',
        notificationColor: '#16A34A',
        killServiceOnDestroy: false,
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
  } catch (e) {
    console.warn('Fon rejimida joylashuv kuzatuvini boshlashda xato:', e);
  }
}

async function endTracking(): Promise<void> {
  try {
    const already = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if (already) {
      await Location.stopLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    }
    await AsyncStorage.removeItem(DRIVER_ID_KEY);
  } catch (e) {
    console.warn('Joylashuv kuzatuvini to\'xtatishda xato:', e);
  }
}

/** Kuzatuvni to'xtatadi — haydovchi oflayn bo'lganda yoki tizimdan
 * chiqqanda. Doimiy bildirishnoma ham shunda yo'qoladi. */
export async function stopDriverLocationTracking(): Promise<void> {
  desiredTracking = false;
  trackingDriverId = null;
  return enqueueTrackingWork(() => applyDesiredTracking());
}

// Haqiqatni oxirgi niyatga moslaydi. Navbat tufayli bir vaqtda faqat
// bittasi ishlaydi, shuning uchun boshlash va to'xtatish bir-birining
// o'rtasiga tushib qololmaydi.
async function applyDesiredTracking(): Promise<void> {
  if (desiredTracking) {
    if (trackingDriverId) await beginTracking(trackingDriverId);
    // Boshlash zanjiri davomida "to'xtat" kelgan bo'lsa, navbatdagi
    // keyingi ish uni baribir o'chiradi — lekin ortiqcha kutmaslik
    // uchun shu yerda ham darhol tekshiramiz.
    if (!desiredTracking) await endTracking();
  } else {
    await endTracking();
  }
}
