// src/utils/tripMeter.ts
//
// SAFAR MASOFA HISOBLAGICHI (taksometr)
// ============================================================
// Safar narxi shu yerda o'lchangan masofaga qarab oshadi. Avval bu
// hisob MapScreen ichida, GPS callback'ining o'zida turardi va uning
// ikkita og'ir kamchiligi bor edi.
//
// 1) SHOVQIN FILTRI HAQIQIY HARAKATNI YEB QO'YARDI
//
//    Kod shunday edi:
//
//        const deltaKm = getDistanceKm(lastTripPointRef.current, newCoord);
//        if (deltaKm > 0.02 && deltaKm < 1.5) { ...qo'shamiz... }
//        lastTripPointRef.current = newCoord;   // <-- HAR DOIM
//
//    Ya'ni 20 metrdan kichik siljish hisobga OLINMASDI, lekin "oxirgi
//    nuqta" BARIBIR oldinga surilardi. GPS esa har 3 soniyada keladi:
//    20 km/soat tezlikda bu ~17 metr, 15 km/soat da ~12 metr. Demak
//    shahar ichida, tirbandlikda, svetoforlar orasida deyarli HAR BIR
//    bo'lak 20 metrdan kichik bo'lib chiqar va jimgina tashlab
//    yuborilardi. Hisoblagich deyarli qimirlamas, narx esa minimal
//    tarifda qotib qolardi.
//
//    Jonli tizimda o'lchangan (20.08.2026, tugallangan buyurtmalar):
//      buyurtma hQnFqdAk... — to'g'ri chiziqda 1.99 km, o'lchangani 0.8 km
//      buyurtma 4IjUSSCM... — to'g'ri chiziqda 0.87 km, o'lchangani 0 km
//      buyurtma iVCC9wpI... — to'g'ri chiziqda 1.00 km, o'lchangani 0 km
//    (haqiqiy yo'l to'g'ri chiziqdan har doim UZUNROQ, ya'ni farq
//    bundan ham katta edi).
//
//    Yechim: bo'lak shovqin chegarasidan kichik bo'lsa LANGAR
//    KO'CHIRILMAYDI. Harakat to'planib boradi va chegaradan oshgan
//    zahoti to'liq hisobga olinadi — bir metr ham yo'qolmaydi.
//
// 2) EKRAN O'CHSA HISOB TO'XTARDI
//
//    `watchPositionAsync` — ilova ochiq turgandagi kuzatuvchi.
//    Haydovchi navigatorga o'tsa yoki ekranni o'chirsa, u sekinlashadi
//    yoki butunlay to'xtaydi. Fon rejimidagi vazifa (locationTask) esa
//    har 10 soniyada aniq nuqta olib turardi, lekin uni masofaga
//    QO'SHMASDI — o'sha vaqt ichida bosib o'tilgan butun yo'l bepul
//    bo'lardi.
//
//    Endi hisoblagich shu yerda, ikkala oqim uchun UMUMIY. Ikkalasi
//    ham `addTripPoint()` chaqiradi. Har qabul qilingan nuqta langarni
//    o'ziga ko'chirgani uchun IKKI MARTA HISOBLASH BO'LMAYDI —
//    nuqtalar shunchaki zichroq tushadi, xolos.
//
// Holat AsyncStorage'da saqlanadi: fon vazifasi ilova butunlay yopiq
// holatda ham ishlashi mumkin, o'shanda React ham, undagi hech qanday
// o'zgaruvchi ham mavjud bo'lmaydi.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDistanceKm } from './distance';
import { TRIP_METER_KEY } from './sessionKeys';

/** Bundan noaniqroq nuqta umuman ishlatilmaydi. Tunnel, tor ko'cha,
 * baland binolar orasida GPS 100+ metr xato beradi — bunday nuqta
 * qo'shilsa, mashina turgan joyida narx o'z-o'zidan o'sib ketardi.
 *
 * MUHIM: bunday nuqta tashlab yuborilganda ham langar QOLDIRILADI,
 * ya'ni aloqa tiklanganda o'sha oradagi masofa yo'qolmaydi. */
const WORST_ACCURACY_M = 50;

/** GPS aniqligini bildirmagan qurilma uchun taxminiy qiymat. */
const ASSUMED_ACCURACY_M = 25;

/** Eng kichik shovqin chegarasi (km). GPS ideal ishlaganda ham nuqta
 * bir necha metr "titraydi" — shundan pastini harakat deb bo'lmaydi. */
const MIN_NOISE_KM = 0.015;

/** Shovqin chegarasi aniqlikning shuncha barobari. Aniqlik 20 metr
 * bo'lsa, 24 metrdan kichik siljish hali harakat emas. */
const NOISE_FROM_ACCURACY = 1.2;

/** Shundan tez "harakat" — GPS sakrashi, haqiqiy yurish emas.
 *
 * MUHIM: bu qat'iy masofa emas, TEZLIK. Avvalgi kodda "1.5 km dan
 * katta bo'lak — sakrash" degan qat'iy chegara turardi va u ikki
 * tomonlama xato edi: 3 soniyada 1.4 km (1680 km/soat!) sakrash deb
 * hisoblanmasdi, aloqa 1 daqiqaga uzilib qolganda esa haqiqiy 2 km
 * yo'l "sakrash" deb tashlab yuborilardi. */
const MAX_PLAUSIBLE_KMH = 180;

type MeterState = {
  orderId: string;
  /** Shu safarda hozirgacha o'lchangan masofa (km). */
  km: number;
  /** Oxirgi QABUL QILINGAN nuqta. `null` — hali langar yo'q
   * (safar endi boshlandi yoki ilova qayta ochildi). */
  lat: number | null;
  lng: number | null;
  /** Langar qachon qo'yilgani — tezlik tekshiruvi uchun. */
  at: number;
};

// Nuqtalar ikkita mustaqil oqimdan keladi (ekrandagi kuzatuvchi va fon
// vazifasi), ya'ni "o'qi -> o'zgartir -> yoz" ketma-ketligi bir-birining
// ustiga tushishi mumkin. Navbat buni oldini oladi.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  // `.then(work, work)` — oldingi ish xato bilan tugasa ham navbat
  // to'xtab qolmasin.
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function readState(): Promise<MeterState | null> {
  try {
    const raw = await AsyncStorage.getItem(TRIP_METER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MeterState;
    if (!parsed || typeof parsed.km !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeState(state: MeterState): Promise<void> {
  try {
    await AsyncStorage.setItem(TRIP_METER_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Masofa hisoblagichini saqlashda xato:', e);
  }
}

/** Safar boshlandi — hisoblagich noldan ketadi. */
export async function startTripMeter(orderId: string): Promise<void> {
  await enqueue(async () => {
    await writeState({ orderId, km: 0, lat: null, lng: null, at: Date.now() });
  });
}

/** Ilova qayta ochildi va tugallanmagan safar tiklandi.
 *
 * Hisoblagichdagi qiymat MapScreen'ning snapshot'idan ishonchliroq:
 * snapshot har 10 soniyada bir yozilardi, hisoblagich esa har bir
 * qabul qilingan nuqtada yangilanadi (fon vazifasidan kelgani ham).
 * Shuning uchun ikkalasining KATTAROG'I olinadi.
 *
 * Langar ataylab tozalanadi: ilova yopiq turgan vaqtdagi harakat
 * o'lchanmagan bo'lishi mumkin, uni keyingi nuqtaga qo'shib yuborsak
 * mijozdan yurilmagan yo'l uchun pul olingan bo'lardi. */
export async function resumeTripMeter(orderId: string, fallbackKm: number): Promise<number> {
  return enqueue(async () => {
    const state = await readState();
    const safeFallback = typeof fallbackKm === 'number' && fallbackKm > 0 ? fallbackKm : 0;
    const km = state && state.orderId === orderId ? Math.max(state.km, safeFallback) : safeFallback;
    await writeState({ orderId, km, lat: null, lng: null, at: Date.now() });
    return km;
  });
}

/** Safar tugadi yoki bekor qilindi. */
export async function stopTripMeter(): Promise<void> {
  await enqueue(async () => {
    try {
      await AsyncStorage.removeItem(TRIP_METER_KEY);
    } catch (e) {
      console.warn('Masofa hisoblagichini to’xtatishda xato:', e);
    }
  });
}

/**
 * Yangi GPS nuqtasini hisoblagichga beradi va safarning JAMI masofasini
 * qaytaradi. Faol safar bo'lmasa hech narsa qo'shilmaydi.
 *
 * Buni IKKALA oqim ham chaqiradi — ekrandagi kuzatuvchi (har ~3 soniya)
 * va fon rejimidagi joylashuv vazifasi (har 10 soniya).
 */
export async function addTripPoint(
  lat: number,
  lng: number,
  accuracyM?: number | null
): Promise<number | null> {
  return enqueue(async () => {
    const state = await readState();
    // Faol safar yo'q. ATAYLAB `null`, 0 emas: chaqiruvchi buni
    // "hisoblanmadi" deb tushunishi kerak. 0 qaytarilsa, ekrandagi
    // masofa safar tiklanayotgan lahzada bir zumga nolga tushib
    // ketardi.
    if (!state) return null;

    // Ishonchsiz nuqta: hisobga ham olinmaydi, langar ham
    // ko'chirilmaydi — aloqa tiklangach oradagi yo'l to'liq o'lchanadi.
    if (accuracyM != null && accuracyM > WORST_ACCURACY_M) return state.km;

    const now = Date.now();

    // Langar yo'q (safar endi boshlandi) — shu nuqtaning o'zi langar
    // bo'ladi, masofa qo'shilmaydi.
    if (state.lat == null || state.lng == null) {
      await writeState({ ...state, lat, lng, at: now });
      return state.km;
    }

    const deltaKm = getDistanceKm(
      { latitude: state.lat, longitude: state.lng },
      { latitude: lat, longitude: lng }
    );

    // Tezlik bo'yicha "sakrash" tekshiruvi. Langar ancha eski bo'lsa
    // (aloqa uzilgan, ilova yopilgan) katta bo'lak ham haqiqiy yo'l
    // bo'lishi mumkin — shuning uchun masofa emas, tezlik o'lchanadi.
    const elapsedSec = Math.max(1, (now - (state.at || now)) / 1000);
    if ((deltaKm / elapsedSec) * 3600 > MAX_PLAUSIBLE_KMH) {
      await writeState({ ...state, lat, lng, at: now });
      return state.km;
    }

    const noiseKm = Math.max(
      MIN_NOISE_KM,
      ((accuracyM ?? ASSUMED_ACCURACY_M) * NOISE_FROM_ACCURACY) / 1000
    );
    // ENG MUHIM QATOR: chegaradan kichik bo'lsa langar QOLADI.
    // Sekin harakat shu tariqa to'planib boradi va keyingi nuqtalarda
    // to'liq hisobga olinadi. Avval langar bu yerda ham ko'chirilar va
    // harakat butunlay yo'qolardi.
    if (deltaKm <= noiseKm) return state.km;

    const km = state.km + deltaKm;
    await writeState({ orderId: state.orderId, km, lat, lng, at: now });
    return km;
  });
}

