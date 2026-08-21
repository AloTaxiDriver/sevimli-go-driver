// src/utils/sessionKeys.ts
//
// Qurilma xotirasidagi (AsyncStorage) sessiya kalitlari. Ular BIR
// NECHTA mustaqil joyda o'qiladi — AuthContext, fon rejimidagi
// joylashuv vazifasi — shuning uchun alohida, hech narsa import
// qilmaydigan faylda turadi.
//
// MUHIM: bu fayl ATAYLAB "yengil". Fon rejimidagi joylashuv vazifasi
// ilova butunlay yopiq holatda, React umuman ishga tushmasdan
// bajariladi (qarang: src/utils/backgroundRegistrations.ts). Shu sabab
// u AuthContext'ni import qila olmaydi — u React, Firestore va boshqa
// og'ir narsalarni tortib kelgan bo'lardi.

/** Tizimga kirgan haydovchining telefon raqami. AuthContext login
 * paytida yozadi, chiqishda o'chiradi. Haydovchi hujjatining ID'si ham
 * aynan shu telefon raqami. */
export const SAVED_PHONE_KEY = 'oilaTaxiDriver_savedPhone';

/** Fon rejimidagi joylashuv vazifasi joylashuvni KIMGA yozishini shu
 * kalitdan biladi (vazifa React komponentlaridan tashqarida ishlagani
 * uchun unga propslar orqali hech narsa uzatib bo'lmaydi). */
export const LOCATION_TASK_DRIVER_ID_KEY = 'location_task_driver_id';


/** Hozir qaysi buyurtmaning yo'l izi yozilayotgani. Fon rejimidagi
 * joylashuv vazifasi shu kalitga qarab nuqtani `orderTracks`ga
 * qo'shadi. Safar tugagach/bekor qilingach o'chiriladi. */
export const TRIP_TRACK_ORDER_KEY = 'trip_track_order_id';

/** Shu safarda nechta nuqta yozilgani — hujjat cheksiz o'sib
 * ketmasligi uchun sanab boriladi (qarang: tripTrack.ts,
 * MAX_TRACK_POINTS). */
export const TRIP_TRACK_COUNT_KEY = 'trip_track_point_count';

/** Safar taksometrining holati (qaysi buyurtma, hozirgacha necha km,
 * oxirgi langar nuqtasi). Uni IKKI joy yozadi — ekrandagi GPS
 * kuzatuvchisi va fon rejimidagi joylashuv vazifasi — shuning uchun u
 * React holatida emas, aynan shu kalitda yashaydi (qarang:
 * src/utils/tripMeter.ts). */
export const TRIP_METER_KEY = 'trip_meter_state';

/** Tugallanmagan safar yozuvi (haydovchi bo'yicha). MapScreen yozadi
 * va o'chiradi; ilova ILDIZI esa faqat O'QIYDI — bloklangan
 * haydovchiga to'liq ekran ko'rsatishdan oldin "safar ustidami?" degan
 * savolga javob shu yerdan olinadi. Kalit satri ikki joyda takrorlanib
 * ketmasligi uchun shu faylda turadi. */
export function activeTripStorageKey(driverId: string) {
  return `active_trip_${driverId}`;
}
