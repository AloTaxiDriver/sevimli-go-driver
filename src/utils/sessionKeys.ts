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
