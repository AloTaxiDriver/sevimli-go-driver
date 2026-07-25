// app/incoming-order.tsx
//
// Full-screen "kiruvchi qo'ng'iroq" uslubidagi ekran. Bu ekran
// notifee full-screen notification orqali ochiladi (ilova yopiq,
// fonda yoki ekran qulflangan holatda ham) — app/_layout.tsx
// faylidagi notifee event listenerlari shu ekranga
// useLocalSearchParams orqali buyurtma ma'lumotlarini uzatadi.
//
// Bu ekran Firestore'ga MUROJAAT QILMAYDI — barcha kerakli
// ma'lumot (manzil, narx, mijoz) Cloud Function tomonidan FCM
// "data" payload'i orqali allaqachon uzatilgan bo'ladi. Faqat
// "Qabul qilish" bosilganda Firestore'ga yozish amalga oshiriladi
// (acceptOrder), chunki bu — boshqa haydovchilarga ko'rinmas
// bo'lib qolishi uchun zarur bo'lgan yagona amal.

import { Ionicons } from '@expo/vector-icons';
import notifee from '@notifee/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
    Animated,
    BackHandler,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../src/context/AuthContext';
import { COLORS } from '../src/theme/colors';
import { acceptOrder } from '../src/utils/firebase';

// Buyurtmani qabul qilish uchun ajratilgan vaqt (soniya). Shu vaqt
// tugaganda ekran avtomatik yopiladi — xuddi boshqa taxi ilovalari
// kabi, haydovchi buyurtmaga "ulgurmagan" deb hisoblanadi.
const ACCEPT_TIMEOUT_SEC = 15;

export default function IncomingOrderScreen() {
  const params = useLocalSearchParams<{
    orderId?: string;
    fromAddress?: string;
    toAddress?: string;
    price?: string;
    distanceKm?: string;
    tariffName?: string;
    customerName?: string;
    customerPhone?: string;
  }>();

  const { driver } = useAuth();
  const driverId = driver?.id || driver?.phone || 'unknown_driver';

  const [secondsLeft, setSecondsLeft] = useState(ACCEPT_TIMEOUT_SEC);
  const [responding, setResponding] = useState(false);
  const progressAnim = useRef(new Animated.Value(1)).current;
  const closedRef = useRef(false);

  // Ekran ochilganda, foydalanuvchi telefonning orqaga qaytish
  // tugmasi bilan bu ekrandan "tasodifan" chiqib ketmasligi uchun
  // (chunki bu kiruvchi buyurtma — yo'qotib qo'yish oson bo'lmasligi
  // kerak) orqaga qaytishni ushlab qolamiz.
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => true
    );
    return () => subscription.remove();
  }, []);

  // Taymer: har soniyada kamayadi, 0 ga yetganda avtomatik yopiladi.
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: 0,
      duration: ACCEPT_TIMEOUT_SEC * 1000,
      useNativeDriver: false,
    }).start();

    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          closeScreen();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function closeScreen() {
    if (closedRef.current) return;
    closedRef.current = true;
    // Full-screen notification'ning o'zini ham bekor qilamiz —
    // aks holda u bildirishnomalar panelida "ongoing" sifatida
    // qolib ketadi (chunki firebase.ts'da autoCancel: false,
    // ongoing: true qilib yaratilgan edi).
    if (params.orderId) {
      notifee.cancelNotification(params.orderId).catch(() => {});
    }
    router.back();
  }

  async function handleAccept() {
    if (responding || !params.orderId) return;
    setResponding(true);
    try {
      await acceptOrder(params.orderId, driverId);
    } catch (error) {
      console.warn('Buyurtmani qabul qilishda xato:', error);
    }
    closeScreen();
    // Qabul qilingandan keyin asosiy xarita ekraniga o'tamiz —
    // u yerda MapScreen ichidagi mantiq (activeOrderSourceId va
    // Firestore tinglovchisi) buyurtmani davom ettiradi.
    router.replace('/');
  }

  function handleDecline() {
    if (responding) return;
    // Bu — pool buyurtmasi, shuning uchun Firestore'da hech narsa
    // o'zgartirmaymiz (boshqa haydovchilarga ko'rinishda davom
    // etadi). Shunchaki shu haydovchining ekranidan yopamiz.
    closeScreen();
  }

  const price = params.price ? Number(params.price) : 0;
  const distanceKm = params.distanceKm ? Number(params.distanceKm) : 0;

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.flex}>
        <View style={styles.header}>
          <View style={styles.pulseDot} />
          <Text style={styles.headerTitle}>Yangi buyurtma!</Text>
          <Text style={styles.headerTimer}>{secondsLeft}s</Text>
        </View>

        <View style={styles.progressTrack}>
          <Animated.View style={[styles.progressFill, { width: progressWidth }]} />
        </View>

        <View style={styles.card}>
          <View style={styles.priceRow}>
            <Text style={styles.priceValue}>
              {price > 0 ? price.toLocaleString() : '—'}
            </Text>
            <Text style={styles.priceCurrency}>so'm</Text>
          </View>

          {!!params.tariffName && (
            <View style={styles.tariffPill}>
              <Text style={styles.tariffText}>{params.tariffName}</Text>
            </View>
          )}

          <View style={styles.divider} />

          <View style={styles.routeRow}>
            <View style={styles.routeIcons}>
              <View style={[styles.routeDot, { backgroundColor: COLORS.success }]} />
              <View style={styles.routeLine} />
              <View style={[styles.routeDot, { backgroundColor: COLORS.danger }]} />
            </View>
            <View style={styles.routeTexts}>
              <Text style={styles.routeAddress} numberOfLines={2}>
                {params.fromAddress || "Manzil ko'rsatilmagan"}
              </Text>
              <View style={styles.routeGap} />
              <Text style={styles.routeAddress} numberOfLines={2}>
                {params.toAddress || "Manzil ko'rsatilmagan"}
              </Text>
            </View>
          </View>

          {distanceKm > 0 && (
            <View style={styles.distanceRow}>
              <Ionicons name="navigate-outline" size={16} color={COLORS.textMuted} />
              <Text style={styles.distanceText}>{distanceKm.toFixed(1)} km</Text>
            </View>
          )}

          <View style={styles.divider} />

          <View style={styles.customerRow}>
            <View style={styles.customerAvatar}>
              <Ionicons name="person" size={22} color={COLORS.white} />
            </View>
            <View style={styles.customerInfo}>
              <Text style={styles.customerName}>
                {params.customerName || "Noma'lum mijoz"}
              </Text>
              {!!params.customerPhone && (
                <Text style={styles.customerPhone}>{params.customerPhone}</Text>
              )}
            </View>
          </View>
        </View>

        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.declineBtn]}
            onPress={handleDecline}
            disabled={responding}
            activeOpacity={0.85}
          >
            <Ionicons name="close" size={26} color={COLORS.white} />
            <Text style={styles.actionLabel}>O'tkazib yuborish</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionBtn, styles.acceptBtn]}
            onPress={handleAccept}
            disabled={responding}
            activeOpacity={0.85}
          >
            <Ionicons name="checkmark" size={26} color={COLORS.white} />
            <Text style={styles.actionLabel}>
              {responding ? 'Yuklanmoqda...' : 'Qabul qilish'}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: {
    flex: 1,
    backgroundColor: COLORS.dark,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 10,
  },
  pulseDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.primary,
  },
  headerTitle: {
    flex: 1,
    color: COLORS.white,
    fontSize: 20,
    fontWeight: '800',
  },
  headerTimer: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: '800',
  },
  progressTrack: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    marginHorizontal: 24,
    marginTop: 14,
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
  },
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 24,
    margin: 20,
    marginTop: 24,
    padding: 22,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  priceValue: {
    fontSize: 36,
    fontWeight: '900',
    color: COLORS.dark,
  },
  priceCurrency: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.textMuted,
    marginBottom: 6,
  },
  tariffPill: {
    alignSelf: 'flex-start',
    backgroundColor: COLORS.gray,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 10,
    marginTop: 8,
  },
  tariffText: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.dark,
  },
  divider: {
    height: 1,
    backgroundColor: COLORS.border,
    marginVertical: 16,
  },
  routeRow: {
    flexDirection: 'row',
    gap: 12,
  },
  routeIcons: {
    alignItems: 'center',
    paddingTop: 4,
  },
  routeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  routeLine: {
    width: 2,
    flex: 1,
    minHeight: 24,
    backgroundColor: COLORS.border,
    marginVertical: 4,
  },
  routeTexts: {
    flex: 1,
  },
  routeAddress: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.dark,
  },
  routeGap: {
    height: 20,
  },
  distanceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
  },
  distanceText: {
    fontSize: 13,
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  customerAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customerInfo: {
    flex: 1,
  },
  customerName: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.dark,
  },
  customerPhone: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: 2,
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 20,
    gap: 14,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 18,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  declineBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  acceptBtn: {
    backgroundColor: COLORS.success,
  },
  actionLabel: {
    color: COLORS.white,
    fontSize: 14,
    fontWeight: '700',
  },
});