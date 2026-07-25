// src/components/TripCard.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useRef } from 'react';
import {
  Animated,
  Linking,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Order } from '../data/mockOrders';
import { COLORS } from '../theme/colors';
import GlassPanel from './GlassPanel';

type Stage = 'to_pickup' | 'in_progress';

type Props = {
  order: Order;
  stage: Stage;
  distanceKm: number;
  durationMin: number;
  // Faqat "in_progress" bosqichida beriladi — safar davomida jonli
  // oshib boruvchi narx. Berilmasa, narx bo'limi ko'rsatilmaydi.
  price?: number;
  onPrimaryAction: () => void;
  // Faqat "to_pickup" bosqichida beriladi — mijoz mashinaga
  // o'tirganidan keyin (in_progress) bekor qilish tugmasi
  // ko'rsatilmaydi, chunki safar allaqachon boshlangan bo'ladi.
  onCancel?: () => void;
};

// Karta to'liq ochiq holatda taxminan shuncha balandlikni egallaydi —
// bu boshlang'ich (fallback) qiymat, haqiqiy balandlik onLayout orqali
// o'lchanganidan keyin avtomatik to'g'rilanadi.
const FALLBACK_SHEET_HEIGHT = 420;
// Yopiq holatda shuncha balandlik (tutqich + ozgina sarlavha) ko'rinib tursin
const VISIBLE_WHEN_COLLAPSED = 56;

export default function TripCard({ order, stage, distanceKm, durationMin, price, onPrimaryAction, onCancel }: Props) {
  const isToPickup = stage === 'to_pickup';

  // 0 = to'liq ochiq, collapsedOffset = deyarli yopiq (faqat tutqich + sarlavha)
  const translateY = useRef(new Animated.Value(0)).current;
  const isCollapsed = useRef(false);
  // Kartaning haqiqiy o'lchangan balandligi (onLayout orqali)
  const sheetHeight = useRef(FALLBACK_SHEET_HEIGHT);
  // Shu balandlikdan kelib chiqib hisoblangan, qancha pastga
  // tushirish kerakligini bildiruvchi qiymat
  const collapsedOffsetRef = useRef(FALLBACK_SHEET_HEIGHT - VISIBLE_WHEN_COLLAPSED);

  function handleLayout(event: { nativeEvent: { layout: { height: number } } }) {
    const measuredHeight = event.nativeEvent.layout.height;
    if (measuredHeight > 0 && Math.abs(measuredHeight - sheetHeight.current) > 1) {
      sheetHeight.current = measuredHeight;
      collapsedOffsetRef.current = Math.max(0, measuredHeight - VISIBLE_WHEN_COLLAPSED);
      // Agar karta hozir yopiq holatda bo'lsa, yangi to'g'ri qiymatga moslashtiramiz
      if (isCollapsed.current) {
        translateY.setValue(collapsedOffsetRef.current);
      }
    }
  }

  const panResponder = useRef(
    PanResponder.create({
      // Faqat tutqich joylashgan hududda sudrashni boshlaymiz,
      // shunda ichkaridagi tugmalar (qo'ng'iroq, SMS, "Yetib keldim")
      // bosilganda tasodifan sudralib ketmaydi
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 2,
      onPanResponderMove: (_, gesture) => {
        const collapsedOffset = collapsedOffsetRef.current;
        const base = isCollapsed.current ? collapsedOffset : 0;
        const next = Math.max(0, Math.min(collapsedOffset, base + gesture.dy));
        translateY.setValue(next);
      },
      onPanResponderRelease: (_, gesture) => {
        const collapsedOffset = collapsedOffsetRef.current;
        const base = isCollapsed.current ? collapsedOffset : 0;
        const current = Math.max(0, Math.min(collapsedOffset, base + gesture.dy));

        // Tezlikni ham hisobga olamiz, faqat masofani emas — aks holda
        // tez silkitilgan qisqa harakat sezilmay, teskari tomonga
        // "tortilib" ketadi (tepaga ko'tarish pastga tushirishdan
        // qiyinroq tuyuladi, garchi harakat tezligi bir xil bo'lsa ham).
        const FLING_VELOCITY = 0.5;
        let shouldCollapse: boolean;
        if (gesture.vy > FLING_VELOCITY) {
          // Tez pastga silkitildi -> yopamiz
          shouldCollapse = true;
        } else if (gesture.vy < -FLING_VELOCITY) {
          // Tez tepaga silkitildi -> ochamiz
          shouldCollapse = false;
        } else {
          // Sekin harakat -> bosib o'tilgan masofaga qaraymiz
          shouldCollapse = current > collapsedOffset / 2;
        }

        isCollapsed.current = shouldCollapse;
        Animated.spring(translateY, {
          toValue: shouldCollapse ? collapsedOffset : 0,
          useNativeDriver: true,
          bounciness: 4,
        }).start();
      },
    })
  ).current;

  function callCustomer() {
    Linking.openURL(`tel:${order.customer.phone}`);
  }

  function smsCustomer() {
    Linking.openURL(`sms:${order.customer.phone}`);
  }

  return (
    <Animated.View style={{ transform: [{ translateY }] }}>
      <GlassPanel intensity={80} style={styles.sheet} onLayout={handleLayout}>
        <View {...panResponder.panHandlers} style={styles.dragArea}>
          <View style={styles.dragHandle} />
        </View>

        <View style={styles.stageRow}>
          <Text style={styles.stageLabel}>
            {isToPickup ? 'Manzilga ketayapsiz' : 'Safar davom etmoqda'}
          </Text>
          {isToPickup && !!onCancel && (
            <TouchableOpacity onPress={onCancel} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.cancelLink}>Bekor qilish</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.customerRow}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={24} color={COLORS.white} />
          </View>
          <View style={styles.customerInfo}>
            <Text style={styles.customerName}>{order.customer.name}</Text>
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={13} color="#F5A623" />
              <Text style={styles.ratingText}>{order.customer.rating}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.contactBtn} onPress={callCustomer}>
            <Ionicons name="call" size={20} color={COLORS.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.contactBtn} onPress={smsCustomer}>
            <Ionicons name="chatbubble-ellipses" size={20} color={COLORS.primary} />
          </TouchableOpacity>
        </View>

        <Text style={styles.address}>{order.fromAddress}</Text>

        <View style={styles.routeDivider}>
          <View style={styles.routeDot} />
          <View style={styles.routeLine} />
          <View style={[styles.routeDot, styles.routeDotEnd]} />
        </View>

        <Text style={styles.address}>{order.toAddress}</Text>

        {price != null && (
          <View style={styles.priceRow}>
            <Text style={styles.priceLabel}>Joriy narx</Text>
            <Text style={styles.priceValue}>{price.toLocaleString()} so'm</Text>
          </View>
        )}

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="navigate" size={18} color={COLORS.primary} />
            <Text style={styles.metaValue}>{distanceKm.toFixed(1)} km</Text>
          </View>
          <View style={styles.metaDivider} />
          <View style={styles.metaItem}>
            <Ionicons name="time" size={18} color={COLORS.primary} />
            <Text style={styles.metaValue}>{durationMin} min</Text>
          </View>
        </View>

        <TouchableOpacity style={styles.primaryBtn} onPress={onPrimaryAction}>
          <Text style={styles.primaryBtnText}>
            {isToPickup ? 'Yetib keldim' : 'Safarni yakunlash'}
          </Text>
        </TouchableOpacity>
      </GlassPanel>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 36,
    overflow: 'hidden',
    borderTopWidth: 1.5,
    borderLeftWidth: 1.5,
    borderRightWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  dragArea: {
    paddingVertical: 14,
    marginTop: -14,
    marginBottom: -2,
    minHeight: VISIBLE_WHEN_COLLAPSED,
    justifyContent: 'center',
  },
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(22,24,29,0.2)',
    alignSelf: 'center',
  },
  stageLabel: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600' },
  stageRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cancelLink: { fontSize: 13, color: COLORS.danger, fontWeight: '700' },

  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 10,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: COLORS.dark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customerInfo: { flex: 1 },
  customerName: { fontSize: 16, fontWeight: '800', color: COLORS.dark },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  ratingText: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600' },
  contactBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F4F4F6',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E8E8EC',
  },

  address: { fontSize: 18, fontWeight: '800', color: COLORS.dark, marginTop: 16 },

  routeDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    marginLeft: 2,
  },
  routeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.success,
  },
  routeDotEnd: {
    backgroundColor: COLORS.primary,
  },
  routeLine: {
    width: 14,
    height: 1.5,
    backgroundColor: 'rgba(22,24,29,0.15)',
    marginHorizontal: 6,
  },

  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,90,44,0.08)',
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,90,44,0.2)',
  },
  priceLabel: { fontSize: 13, fontWeight: '700', color: COLORS.textMuted },
  priceValue: { fontSize: 22, fontWeight: '900', color: COLORS.primary },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F4F4F6',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#E8E8EC',
  },
  metaItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  metaValue: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.dark,
  },
  metaDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(22,24,29,0.12)',
    marginHorizontal: 12,
  },

  primaryBtn: {
    marginTop: 20,
    backgroundColor: COLORS.primary,
    borderRadius: 30,
    paddingVertical: 18,
    alignItems: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  primaryBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
});