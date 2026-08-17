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
import { displayDispatcherNotification, displayFullScreenOrderNotification } from './firebase';
// Shu import `TaskManager.defineTask(DRIVER_LOCATION_TASK, ...)` ni
// bajaradi — fon rejimidagi joylashuv vazifasini ro'yxatdan o'tkazadi.
import './locationTask';

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
