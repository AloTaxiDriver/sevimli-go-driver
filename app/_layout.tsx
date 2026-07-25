// app/_layout.tsx
import notifee, { EventType } from '@notifee/react-native';
import messaging from '@react-native-firebase/messaging';
import { router, Stack } from 'expo-router';
import React, { useEffect } from 'react';
import { AuthProvider } from '../src/context/AuthContext';
import { displayDispatcherNotification, displayFullScreenOrderNotification } from '../src/utils/firebase';

// MUHIM: bu handler ilova komponent darajasidan TASHQARIDA, fayl
// yuklanganda darhol ro'yxatdan o'tadi. Shuning uchun ilova butunlay
// yopiq (killed) holatda bo'lsa ham, Android tizimi push notification
// kelganda shu funksiyani chaqiradi.
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
    // bu handleNotificationEvent va getInitialNotification orqali
    // pastdagi useEffect ichida allaqachon to'g'ri ishlaydi.
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

export default function RootLayout() {
  // Notifee bildirishnoma hodisalarini (bosilganda, full-screen
  // avtomatik ochilganda) tinglaymiz. Bu useEffect ilova OCHILGANDA
  // (foreground'ga o'tganda) ham, fonda ham ishlashi uchun ikki xil
  // tinglovchi kerak: onForegroundEvent (ilova ochiq) va
  // onBackgroundEvent (ilova fonda/yopiq, lekin JS hali ishlayotgan
  // holatda — masalan foydalanuvchi bildirishnomani bosgandan keyin
  // ilova ochilayotganda).
  useEffect(() => {
    function navigateToIncomingOrder(data: Record<string, any> | undefined) {
      if (!data) return;
      // notifee/FCM "data" maydonidagi qiymatlar ba'zan string,
      // ba'zan boshqa tip bo'lishi mumkin. expo-router esa faqat
      // string qiymatlarni kutadi, shuning uchun har bir maydonni
      // xavfsiz tarzda String() bilan o'tkazamiz.
      const params: Record<string, string> = {};
      Object.keys(data).forEach((key) => {
        params[key] = String(data[key] ?? '');
      });
      router.push({
        pathname: '/incoming-order',
        params,
      });
    }

    function handleNotificationEvent(type: EventType, detail: any) {
      const { notification, pressAction } = detail;

      const isOrderNotification =
        notification?.data?.type === 'new_order';

      const wasPressedOrOpened =
        type === EventType.PRESS ||
        (type === EventType.DELIVERED && pressAction?.id === 'incoming-order');

      if (isOrderNotification && (type === EventType.PRESS || wasPressedOrOpened)) {
        navigateToIncomingOrder(notification.data);
      }
    }

    // Ilova OCHIQ holatda bildirishnoma bosilganda
    const unsubscribeForeground = notifee.onForegroundEvent(({ type, detail }) => {
      handleNotificationEvent(type, detail);
    });

    // Ilova fonda bo'lganda bildirishnoma bosilib, ilova ochilganda
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      handleNotificationEvent(type, detail);
    });

    // Ilova butunlay YOPIQ holatda edi va foydalanuvchi
    // bildirishnomani bosib ilovani ochdi — shu holatni alohida
    // tekshiramiz, chunki yuqoridagi event listenerlar bu holatni
    // qamrab olmaydi (ilova hali component daraxti qurilmagan edi).
    notifee.getInitialNotification().then((initial) => {
      if (initial?.notification?.data?.type === 'new_order') {
        navigateToIncomingOrder(initial.notification.data);
      }
    });

    return () => {
      unsubscribeForeground();
    };
  }, []);

  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}