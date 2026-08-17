// src/utils/backgroundLocationConsent.ts
//
// FON REJIMIDAGI JOYLASHUV UCHUN ROZILIK
// ============================================================
// Google Play qoidasi ("Prominent Disclosure & Consent Requirement"):
// ilova joylashuvni FON rejimida (ilova ochiq bo'lmaganda ham) yig'sa,
// tizimning o'z ruxsat oynasidan OLDIN ilovaning O'ZIDA alohida
// tushuntirish ko'rsatilishi SHART. Unda quyidagilar bo'lishi kerak:
//   * qanday ma'lumot yig'ilishi (joylashuv),
//   * u FON rejimida — ilova yopiq turganda ham yig'ilishi,
//   * nima uchun ishlatilishi,
//   * va foydalanuvchining ANIQ roziligi (tugma bosishi).
// Maxfiylik siyosatiga havola yoki tizim oynasining o'zi yetarli EMAS.
//
// Bu talab bajarilmasa Google ilovani rad etadi yoki do'kondan olib
// tashlaydi. Ilovada `ACCESS_BACKGROUND_LOCATION` ruxsati e'lon
// qilingan (app.json), shuning uchun talab bizga to'liq taalluqli.
//
// Javob shu yerda saqlanadi va `startDriverLocationTracking` tizim
// ruxsatini FAQAT rozilik berilgan bo'lsa so'raydi.

import AsyncStorage from '@react-native-async-storage/async-storage';

const CONSENT_KEY = 'background_location_consent_v1';

export type BackgroundLocationConsent = 'granted' | 'declined';

/** Foydalanuvchi javob bermagan bo'lsa `null` qaytaradi — o'shanda
 * tushuntirish oynasi ko'rsatilishi kerak. */
export async function getBackgroundLocationConsent(): Promise<BackgroundLocationConsent | null> {
  try {
    const raw = await AsyncStorage.getItem(CONSENT_KEY);
    return raw === 'granted' || raw === 'declined' ? raw : null;
  } catch {
    // O'qib bo'lmasa, javob berilmagan deb hisoblaymiz — ya'ni
    // tushuntirish QAYTA ko'rsatiladi. Xato tomon shu bo'lishi kerak:
    // rozilikni "bor" deb o'ylab yuborgandan ko'ra ortiqcha so'ragan
    // yaxshi.
    return null;
  }
}

export async function setBackgroundLocationConsent(
  value: BackgroundLocationConsent
): Promise<void> {
  try {
    await AsyncStorage.setItem(CONSENT_KEY, value);
  } catch (e) {
    console.warn('Fon joylashuvi roziligini saqlashda xato:', e);
  }
}
