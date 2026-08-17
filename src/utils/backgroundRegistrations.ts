// src/utils/backgroundRegistrations.ts
//
// ILOVA BUTUNLAY YOPIQ BO'LGANDA HAM ISHLASHI KERAK BO'LGAN
// RO'YXATDAN O'TISHLAR
// ============================================================
// Android ba'zi hollarda JS to'plamini (bundle) HECH QANDAY EKRANSIZ
// ishga tushiradi — "headless" rejim:
//   * data-only push xabar kelganda (yangi buyurtma), ilova esa
//     o'ldirilgan bo'lsa;
//   * foreground service joylashuv yangilanishini yetkazganda.
// Bunday paytda React umuman render qilinmaydi.
//
// Avval bu ikkala ro'yxatdan o'tish `app/_layout.tsx` faylining
// yuqorisida, komponentdan tashqarida turardi — "fayl yuklanganda
// bajariladi" degan hisobda. Lekin `app/` ichidagi fayllarni
// expo-router `require.context` orqali FAQAT KERAK BO'LGANDA yuklaydi,
// ya'ni ekran render qilinganda. Headless ishga tushishda esa ekran
// yo'q — demak `_layout.tsx` UMUMAN bajarilmasdi va:
//   * `TaskManager.defineTask` ro'yxatdan o'tmasdi -> foreground
//     service joylashuv yuborsa "bunday vazifa topilmadi" bo'lardi,
//     ya'ni kechagi fon-joylashuv tuzatuvi release build'da umuman
//     ishlamasdi;
//   * `setBackgroundMessageHandler` ro'yxatdan o'tmasdi -> ilova
//     yopiq turganda kelgan yangi buyurtma xabari jimgina yo'qolardi.
//     Cloud Function xabarlarni FAQAT `data` bilan yuboradi
//     (`notification` bloki yo'q), shuning uchun Android o'zi hech
//     narsa ko'rsatmaydi — hammasi shu handlerga bog'liq.
//
// Endi bu fayl loyihaning ildizidagi `index.js` orqali, to'plam
// yuklanishi bilan BIRINCHI bo'lib bajariladi — ekran bor-yo'qligidan
// qat'i nazar.

import messaging from '@react-native-firebase/messaging';
import notifee, { EventType } from '@notifee/react-native';
import { displayDispatcherNotification, displayFullScreenOrderNotification } from './firebase';
// Shu import `TaskManager.defineTask(DRIVER_LOCATION_TASK, ...)` ni
// bajaradi — fon rejimidagi joylashuv vazifasini ro'yxatdan o'tkazadi.
import './locationTask';

// ============================================================
// BILDIRISHNOMA FON HODISALARI
// ============================================================
// MUHIM: `notifee.onBackgroundEvent` ham AYNAN shu yerda — modul
// darajasida — ro'yxatdan o'tishi SHART. Avval u `app/_layout.tsx`
// ichidagi `useEffect`da edi, ya'ni:
//   * ilova butunlay yopiq bo'lganda umuman ro'yxatdan o'tmasdi
//     (yuqoridagi izohga qarang: `app/` fayllari faqat ekran render
//     qilinganda yuklanadi) — Notifee esa handler yo'q bo'lsa
//     ogohlantirish beradi va fon hodisasini tashlab yuboradi;
//   * komponent har qayta ulanganda handler QAYTA o'rnatilardi
//     (Notifee'da handler bitta — yangisi eskisini almashtiradi).
//
// Ekran hali qurilmagan bo'lishi mumkin, shuning uchun bu yerdan
// to'g'ridan-to'g'ri navigatsiya qilib bo'lmaydi. Buyurtma ma'lumoti
// saqlanadi, ilova ochilganda `app/_layout.tsx` uni o'qib oladi.
let pendingOrderNavigation: Record<string, any> | null = null;

/** Fon hodisasidan qolgan buyurtmani BIR MARTA qaytaradi. */
export function consumePendingOrderNavigation(): Record<string, any> | null {
  const data = pendingOrderNavigation;
  pendingOrderNavigation = null;
  return data;
}

notifee.onBackgroundEvent(async ({ type, detail }) => {
  const { notification, pressAction } = detail;
  if (notification?.data?.type !== 'new_order') return;
  const pressed =
    type === EventType.PRESS ||
    (type === EventType.DELIVERED && pressAction?.id === 'incoming-order');
  if (pressed) pendingOrderNavigation = notification.data as Record<string, any>;
});

// MUHIM: bu handler komponent darajasidan TASHQARIDA, fayl yuklanganda
// darhol ro'yxatdan o'tadi. Shuning uchun ilova butunlay yopiq (killed)
// holatda bo'lsa ham, Android tizimi push notification kelganda shu
// funksiyani chaqiradi.
messaging().setBackgroundMessageHandler(async (remoteMessage) => {
  console.log('Background push notification:', remoteMessage);

  if (remoteMessage.data?.type === 'new_order') {
    // MUHIM: bu yerda faqat native overlay chiqariladi. Ilgari shu
    // joyda router.push('/incoming-order', ...) ham qo'shimcha
    // "zaxira urinish" sifatida chaqirilardi — lekin bu native
    // overlay bilan PARALLEL, mustaqil JS ekranini navigatsiya
    // stackiga qo'shib qo'yardi. Ilova keyinroq (masalan native
    // overlay'dagi "Qabul qilish" orqali) oldinga chiqqanda, o'sha
    // unutilgan /incoming-order ekrani ko'rinadigan bo'lib qolib,
    // o'zining alohida 15s taymeri bilan qayta paydo bo'lardi —
    // aynan "overlay 0 soniyada qayta chiqadi" muammosining haqiqiy
    // sababi shu edi. /incoming-order ekrani endi faqat notifee
    // fallback orqali (overlay ruxsati YO'Q holatlarda) ochiladi —
    // bu app/_layout.tsx ichidagi useEffect'da (handleNotificationEvent
    // va getInitialNotification orqali) allaqachon to'g'ri ishlaydi.
    await displayFullScreenOrderNotification(
      remoteMessage.data as Record<string, string>
    );
  } else if (remoteMessage.data?.type === 'dispatcher_notification') {
    // Dispetcher yuborgan xabar — ilova butunlay yopiq bo'lsa ham
    // shu yerda oddiy tizim bildirishnomasi ko'rsatiladi.
    await displayDispatcherNotification(
      remoteMessage.data as Record<string, string>
    );
  }
});
