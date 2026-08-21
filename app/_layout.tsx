// app/_layout.tsx
import notifee, { EventType } from '@notifee/react-native';
import crashlytics from '@react-native-firebase/crashlytics';
import { router, Stack } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthProvider, useAuth } from '../src/context/AuthContext';
import { consumePendingOrderNavigation } from '../src/utils/backgroundRegistrations';
import { activeTripStorageKey } from '../src/utils/sessionKeys';
import BlockedScreen from '../src/screens/BlockedScreen';
import LoginScreen from '../src/screens/LoginScreen';
import RegisterScreen from '../src/screens/RegisterScreen';
import { COLORS } from '../src/theme/colors';

// MUHIM: fon rejimidagi push handler (setBackgroundMessageHandler) va
// joylashuv vazifasi (TaskManager.defineTask) avval AYNAN SHU YERDA,
// fayl darajasida ro'yxatdan o'tardi. Ular
// `src/utils/backgroundRegistrations.ts` ga ko'chirildi va endi
// loyihaning ildizidagi `index.js` orqali chaqiriladi.
//
// Sababi: `app/` papkasidagi fayllarni expo-router `require.context`
// bilan faqat EKRAN RENDER QILINGANDA yuklaydi. Ilova butunlay yopiq
// holatda Android JS'ni ekransiz ishga tushirganda (push xabar kelishi,
// foreground service joylashuv yetkazishi) bu fayl umuman bajarilmasdi
// — demak ikkala ro'yxatdan o'tish ham amalda hech qachon ishlamasdi.
//
// Quyidagi useEffect'lar esa ATAYLAB shu yerda qoladi: ular ilova
// ko'rinib turganda kerak (bildirishnoma bosilganda ekranga o'tish).

export default function RootLayout() {
  // Ilova qulasa, sababi Firebase Crashlytics'ga yoziladi. Avval hech
  // qanday xato yozuvchi tizim yo'q edi — haydovchi "ilova o'chib
  // qoldi" desa, buni tekshirishning ILOJI YO'Q edi. Endi Firebase
  // konsolida aniq qaysi qurilmada, qaysi kodda uzilganini ko'rish
  // mumkin.
  useEffect(() => {
    crashlytics().setCrashlyticsCollectionEnabled(true).catch(() => {});
  }, []);

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

    // Ilova fonda turganda bosilgan bildirishnoma — uni
    // `src/utils/backgroundRegistrations.ts` dagi modul darajasidagi
    // handler ushlab, shu yerga qoldirib ketadi (u yerdagi izohga
    // qarang: handler ilova YOPIQ holatda ham ro'yxatdan o'tishi kerak,
    // shuning uchun bu `useEffect` ichida bo'lishi mumkin emas).
    const pending = consumePendingOrderNavigation();
    if (pending) navigateToIncomingOrder(pending);

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
      <AppNavigator />
    </AuthProvider>
  );
}

// MUHIM: kirish/chiqish holati shu yerda, ILOVA ILDIZIDA, to'g'ridan-to'g'ri
// AuthContext holatiga qarab hal qilinadi — `router.replace('/')` kabi
// buyruqli navigatsiyaga UMUMAN tayanmaydi. Avval "Chiqish" tugmasi
// logout()'dan keyin router.replace('/') chaqirar edi, lekin bu (tabs)
// ichidan chaqirilganda har doim ham to'liq/ishonchli ishlamas edi —
// natijada mijoz "chiqmadi, faqat ma'lumotlar o'chdi" holatida qolib
// ketardi. Endi logout() shunchaki `driver`ni null qiladi — shu yetarli,
// chunki quyidagi shart darhol qayta hisoblanib, Login ekraniga o'tadi.
function AppNavigator() {
  const { isLoggedIn, bootstrapping, driver, logout } = useAuth();
  const [showRegister, setShowRegister] = useState(false);

  // BLOKLANGAN HAYDOVCHI. Ekran ATAYLAB shu yerda, tab'lardan
  // YUQORIDA: avval u MapScreen ichida Modal edi va faqat xarita
  // tabini qoplardi — haydovchi "Tarix" tabiga o'tishi bilan
  // xabar yo'qolardi.
  //
  // Tugallanmagan safar bo'lsa ko'rsatilmaydi: mijoz mashinada
  // bo'lishi mumkin va haydovchi safarni yakunlab olishi kerak
  // (MapScreen unga qizil lenta ko'rsatadi). Qurilmadagi yozuv safar
  // tugashi bilan o'chadi, shuning uchun uni qayta-qayta tekshiramiz.
  const [tripInProgress, setTripInProgress] = useState(false);
  const blocked = !!driver?.blocked;
  const driverId = driver?.id;
  useEffect(() => {
    if (!blocked || !driverId) {
      setTripInProgress(false);
      return;
    }
    let alive = true;
    async function check() {
      try {
        const raw = await AsyncStorage.getItem(activeTripStorageKey(driverId as string));
        if (alive) setTripInProgress(!!raw);
      } catch {
        // O'qib bo'lmadi — safar BOR deb hisoblaymiz. Xato
        // tomoni ataylab shu: safar ustidagi haydovchini ekrandan
        // uzib qo'yishdan ko'ra, blok ekranini bir necha soniya
        // kechiktirgan yaxshiroq.
        if (alive) setTripInProgress(true);
      }
    }
    check();
    const iv = setInterval(check, 3000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [blocked, driverId]);

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg }}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (isLoggedIn && blocked && !tripInProgress) {
    return <BlockedScreen reason={driver?.blockedReason} onLogout={logout} />;
  }

  if (!isLoggedIn) {
    return showRegister ? (
      <RegisterScreen onBack={() => setShowRegister(false)} onSubmitted={() => setShowRegister(false)} />
    ) : (
      <LoginScreen onRegister={() => setShowRegister(true)} />
    );
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}