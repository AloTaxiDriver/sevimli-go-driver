// src/utils/tripTrack.ts
//
// SAFAR YO'L IZI — haydovchi haqiqatda qaysi yo'ldan yurgani
// ============================================================
// Joylashuv har 10 soniyada `drivers/{id}.lat/lng` ga yozilardi, ya'ni
// har safar OLDINGISINING USTIGA. Natijada tizimda faqat "hozir
// qayerda" degan bitta nuqta bo'lardi, safar tugagach esa u ham
// yo'qolardi — mijoz "u meni aylantirib yubordi, shuning uchun narx
// oshib ketdi" desa yoki haydovchi "men to'g'ri bordim" desa, buni
// tekshiradigan hech qanday ma'lumot yo'q edi.
//
// Endi faol safar davomida har bir nuqta `orderTracks/{orderId}`
// hujjatidagi `points` ro'yxatiga qo'shib boriladi. Dispetcher paneli
// buyurtma tafsilotida shu ro'yxatni xaritaga chizadi.
//
// NEGA ALOHIDA KOLLEKSIYA: `orders/{id}` hujjatini panel jonli
// tinglaydi. Yo'l izini o'sha hujjatga yozsak, har 10 soniyada butun
// buyurtmalar jadvali qayta chizilardi — panel sezilarli sekinlashardi.
// Alohida hujjat esa faqat tafsilot oynasi ochilganda o'qiladi.

import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import { TRIP_TRACK_ORDER_KEY, TRIP_TRACK_COUNT_KEY } from './sessionKeys';

/** Bitta safar uchun yoziladigan eng ko'p nuqta soni.
 *
 * MUHIM: bu xayoliy chegara emas. Safar Firestore'da "yakunlandi"
 * bo'lmay qolishi mumkin (ilova o'chdi, internet uzildi, haydovchi
 * tugatishni unutdi) — o'shanda kalit qurilmada qolib ketadi va
 * ro'yxat CHEKSIZ o'sardi, hujjat esa Firestore'ning 1 MB
 * chegarasiga urilib, YOZISH BUTUNLAY TO'XTARDI (jimgina).
 * 10 soniyalik oraliqda 2000 nuqta ≈ 5.5 soat. */
const MAX_TRACK_POINTS = 2000;

export type TrackPoint = { lat: number; lng: number; t: number };

/** Safar boshlandi — shu paytdan e'tiboran joylashuvlar yozib
 * boriladi. Haydovchi buyurtmani qabul qilganda chaqiriladi, ya'ni
 * mijozning oldiga borish yo'li ham izga tushadi (aynan shu qism
 * "haydovchi kelmadi" nizolarida kerak bo'ladi). */
export async function startTripTracking(orderId: string): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [TRIP_TRACK_ORDER_KEY, orderId],
      [TRIP_TRACK_COUNT_KEY, '0'],
    ]);
  } catch (e) {
    console.warn('Yo’l izini boshlashda xato:', e);
  }
}

/** Safar tugadi yoki bekor qilindi — yozishni to'xtatamiz. */
export async function stopTripTracking(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([TRIP_TRACK_ORDER_KEY, TRIP_TRACK_COUNT_KEY]);
  } catch (e) {
    console.warn('Yo’l izini to’xtatishda xato:', e);
  }
}

/** Joylashuv vazifasi har yangi nuqtada chaqiradi. Faol safar
 * bo'lmasa hech narsa qilmaydi.
 *
 * Xatolar YUTILADI: yo'l izi qo'shimcha ma'lumot, uni yozib
 * bo'lmagani haydovchining joylashuvi yangilanishiga (asosiy vazifa)
 * halal bermasligi kerak. */
export async function recordTrackPoint(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  try {
    const orderId = await AsyncStorage.getItem(TRIP_TRACK_ORDER_KEY);
    if (!orderId) return;

    const rawCount = await AsyncStorage.getItem(TRIP_TRACK_COUNT_KEY);
    const count = Number(rawCount) || 0;
    if (count >= MAX_TRACK_POINTS) return;

    const point: TrackPoint = { lat, lng, t: Date.now() };
    await firestore()
      .collection('orderTracks')
      .doc(orderId)
      .set(
        {
          orderId,
          driverId,
          points: firestore.FieldValue.arrayUnion(point),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    await AsyncStorage.setItem(TRIP_TRACK_COUNT_KEY, String(count + 1));
  } catch (e) {
    console.warn('Yo’l izi nuqtasini yozishda xato:', e);
  }
}
