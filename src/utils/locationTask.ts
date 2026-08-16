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

export const DRIVER_LOCATION_TASK = 'sevimli-go-driver-location';
const DRIVER_ID_KEY = 'location_task_driver_id';

type LocationTaskPayload = {
  locations?: Location.LocationObject[];
};

TaskManager.defineTask(DRIVER_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    console.warn('Joylashuv vazifasi xatosi:', error);
    return;
  }
  const { locations } = (data || {}) as LocationTaskPayload;
  const latest = locations?.[locations.length - 1];
  if (!latest) return;

  try {
    const driverId = await AsyncStorage.getItem(DRIVER_ID_KEY);
    if (!driverId) return;

    await firestore()
      .collection('drivers')
      .doc(driverId)
      .set(
        {
          lat: latest.coords.latitude,
          lng: latest.coords.longitude,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (e) {
    console.warn('Fon rejimida joylashuvni yozishda xato:', e);
  }
});

/** Fon rejimida joylashuv kuzatuvini boshlaydi (haydovchi onlayn
 * bo'lganda). Qayta chaqirilsa hech narsa buzilmaydi — allaqachon
 * ishlab turgan bo'lsa qayta ishga tushirilmaydi. */
export async function startDriverLocationTracking(driverId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(DRIVER_ID_KEY, driverId);

    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) return;

    // Fon ruxsati bo'lmasa ham davom etamiz: foreground service
    // ishlayotgan paytda Android uni talab qilmaydi, lekin ruxsat
    // berilgan bo'lsa kuzatuv ancha ishonchli bo'ladi.
    await Location.requestBackgroundPermissionsAsync().catch(() => {});

    const already = await Location.hasStartedLocationUpdatesAsync(DRIVER_LOCATION_TASK);
    if (already) return;

    await Location.startLocationUpdatesAsync(DRIVER_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      timeInterval: 10000,
      distanceInterval: 20,
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

/** Kuzatuvni to'xtatadi — haydovchi oflayn bo'lganda yoki tizimdan
 * chiqqanda. Doimiy bildirishnoma ham shunda yo'qoladi. */
export async function stopDriverLocationTracking(): Promise<void> {
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
