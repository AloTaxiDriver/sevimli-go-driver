// src/components/WaitingCard.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Linking,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { FREE_WAIT_SECONDS, Order, WAIT_PRICE_PER_MIN } from '../data/mockOrders';
import { COLORS } from '../theme/colors';

type Props = {
  order: Order;
  onStartTrip: () => void;
  onRecenterMap?: () => void;
  onCancel?: () => void;
};

// MUHIM: bu raqamni haqiqiy dispetcher/qo'llab-quvvatlash raqami bilan almashtiring
const DISPATCHER_PHONE = '+998901234567';

// Karta to'liq ochiq holatda taxminan shuncha balandlikni egallaydi —
// bu boshlang'ich (fallback) qiymat, haqiqiy balandlik onLayout orqali
// o'lchanganidan keyin avtomatik to'g'rilanadi.
const FALLBACK_SHEET_HEIGHT = 620;
// Yopiq holatda shuncha balandlik (tutqich + ozgina sarlavha) ko'rinib tursin
const VISIBLE_WHEN_COLLAPSED = 56;

const SCREEN_WIDTH = Dimensions.get('window').width;
const START_KNOB_SIZE = 54;

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function WaitingCard({ order, onStartTrip, onRecenterMap, onCancel }: Props) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(false);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isPausedRef.current) {
        setElapsedSeconds((prev) => prev + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const isFree = elapsedSeconds < FREE_WAIT_SECONDS;
  const paidSeconds = isFree ? 0 : elapsedSeconds - FREE_WAIT_SECONDS;
  const paidMinutes = Math.ceil(paidSeconds / 60);
  const waitCost = paidMinutes * WAIT_PRICE_PER_MIN;

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
      if (isCollapsed.current) {
        translateY.setValue(collapsedOffsetRef.current);
      }
    }
  }

  const panResponder = useRef(
    PanResponder.create({
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
        // "tortilib" ketadi
        const FLING_VELOCITY = 0.5;
        let shouldCollapse: boolean;
        if (gesture.vy > FLING_VELOCITY) {
          shouldCollapse = true;
        } else if (gesture.vy < -FLING_VELOCITY) {
          shouldCollapse = false;
        } else {
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

  // ── "Safarni boshlash" surish tugmasi ──────────────────────
  const startPan = useRef(new Animated.Value(0)).current;
  const trackWidthRef = useRef(0);

  function handleTrackLayout(event: { nativeEvent: { layout: { width: number } } }) {
    trackWidthRef.current = event.nativeEvent.layout.width;
  }

  const startPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => {
        const threshold = Math.max(0, trackWidthRef.current - START_KNOB_SIZE - 10);
        startPan.setValue(Math.max(0, Math.min(threshold, g.dx)));
      },
      onPanResponderRelease: (_, g) => {
        const threshold = Math.max(0, trackWidthRef.current - START_KNOB_SIZE - 10);
        if (g.dx > threshold / 2) {
          Animated.timing(startPan, { toValue: threshold, duration: 150, useNativeDriver: false })
            .start(() => {
              onStartTrip();
              startPan.setValue(0);
            });
        } else {
          Animated.spring(startPan, { toValue: 0, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  function callCustomer() {
    Linking.openURL(`tel:${order.customer.phone}`);
  }

  function callDispatcher() {
    Linking.openURL(`tel:${DISPATCHER_PHONE}`);
  }

  function togglePause() {
    setIsPaused((prev) => !prev);
  }

  return (
    <Animated.View style={{ transform: [{ translateY }] }}>
      <View style={styles.sheet} onLayout={handleLayout}>
        <View {...panResponder.panHandlers} style={styles.dragArea}>
          <View style={styles.dragHandle} />
        </View>

        <View style={styles.stageRow}>
          <Text style={styles.stageLabel}>Mijozni kutmoqdasiz</Text>
          {!!onCancel && (
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
            <Text style={styles.address} numberOfLines={1}>{order.fromAddress}</Text>
          </View>
        </View>

        <View style={[styles.timerBox, isFree ? styles.timerBoxFree : styles.timerBoxPaid]}>
          <Text style={styles.timerValue}>{formatTime(elapsedSeconds)}</Text>
          {isPaused ? (
            <Text style={styles.timerLabelPaused}>To'xtatib turilgan</Text>
          ) : isFree ? (
            <Text style={styles.timerLabelFree}>
              Bepul kutish ({formatTime(FREE_WAIT_SECONDS - elapsedSeconds)} qoldi)
            </Text>
          ) : (
            <Text style={styles.timerLabelPaid}>
              Pullik kutish • +{waitCost.toLocaleString()} so'm
            </Text>
          )}
        </View>

        <View style={styles.routeCard}>
          <View style={styles.routeIcons}>
            <View style={[styles.routeDot, { backgroundColor: COLORS.success }]} />
            <View style={styles.routeLine} />
            <View style={[styles.routeDot, { backgroundColor: COLORS.danger }]} />
          </View>
          <View style={styles.routeTexts}>
            <Text style={styles.routeAddress} numberOfLines={2}>{order.fromAddress}</Text>
            <View style={styles.routeGap} />
            <Text style={styles.routeAddress} numberOfLines={2}>{order.toAddress}</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Masofa</Text>
            <Text style={styles.statValue}>{order.distanceKm.toFixed(1)} km</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statLabel}>Taxminiy vaqt</Text>
            <Text style={styles.statValue}>{order.durationMin} min</Text>
          </View>
        </View>

        <View style={styles.paymentRow}>
          <Text style={styles.paymentIcon}>💵</Text>
          <Text style={styles.paymentText}>To'lov naqd pulda</Text>
        </View>

        <Text style={styles.priceValue}>{order.price.toLocaleString()} so'm</Text>

        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.actionItem} onPress={togglePause}>
            <View style={[styles.actionCircle, isPaused && styles.actionCircleActive]}>
              <Ionicons name={isPaused ? 'play' : 'pause'} size={20} color={isPaused ? COLORS.white : COLORS.dark} />
            </View>
            <Text style={styles.actionLabel}>{isPaused ? "Davom ettirish" : "To'xtatish"}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionItem} onPress={callCustomer}>
            <View style={styles.actionCircle}>
              <Ionicons name="call" size={20} color={COLORS.success} />
            </View>
            <Text style={styles.actionLabel}>Mijoz</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionItem} onPress={callDispatcher}>
            <View style={styles.actionCircle}>
              <Ionicons name="call" size={20} color={COLORS.success} />
            </View>
            <Text style={styles.actionLabel}>Dispetcher</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.actionItem} onPress={onRecenterMap}>
            <View style={styles.actionCircle}>
              <Ionicons name="navigate" size={20} color={COLORS.primary} />
            </View>
            <Text style={styles.actionLabel}>Xarita</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.startTrack} onLayout={handleTrackLayout} {...startPanResponder.panHandlers}>
          <Animated.View pointerEvents="none" style={styles.startTrackTextWrap}>
            <Text style={styles.startTrackTitle}>Safarni boshlash</Text>
          </Animated.View>
          <Animated.View style={[styles.startKnob, { transform: [{ translateX: startPan }] }]}>
            <Ionicons name="arrow-forward" size={26} color={COLORS.dark} />
          </Animated.View>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 36,
  },
  dragArea: {
    paddingVertical: 14,
    marginTop: -14,
    marginBottom: 2,
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

  customerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 10 },
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
  address: { fontSize: 13, color: COLORS.textMuted, marginTop: 2 },

  timerBox: {
    marginTop: 18,
    borderRadius: 18,
    paddingVertical: 20,
    alignItems: 'center',
  },
  timerBoxFree: { backgroundColor: COLORS.successLight },
  timerBoxPaid: { backgroundColor: COLORS.primaryLight },
  timerValue: { fontSize: 36, fontWeight: '800', color: COLORS.dark, fontVariant: ['tabular-nums'] },
  timerLabelFree: { fontSize: 13, color: COLORS.success, fontWeight: '700', marginTop: 4 },
  timerLabelPaid: { fontSize: 13, color: COLORS.primary, fontWeight: '700', marginTop: 4 },
  timerLabelPaused: { fontSize: 13, color: COLORS.textMuted, fontWeight: '700', marginTop: 4 },

  routeCard: { flexDirection: 'row', gap: 12, marginTop: 18 },
  routeIcons: { alignItems: 'center', paddingTop: 4 },
  routeDot: { width: 10, height: 10, borderRadius: 5 },
  routeLine: { width: 2, flex: 1, minHeight: 20, backgroundColor: COLORS.border, marginVertical: 4 },
  routeTexts: { flex: 1 },
  routeAddress: { fontSize: 14, fontWeight: '600', color: COLORS.dark },
  routeGap: { height: 16 },

  statsRow: { flexDirection: 'row', marginTop: 16, backgroundColor: COLORS.gray, borderRadius: 14, paddingVertical: 12 },
  statItem: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, backgroundColor: COLORS.border },
  statLabel: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600' },
  statValue: { fontSize: 16, color: COLORS.dark, fontWeight: '800', marginTop: 4 },

  paymentRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 16 },
  paymentIcon: { fontSize: 16 },
  paymentText: { fontSize: 14, color: COLORS.dark, fontWeight: '600' },

  priceValue: { fontSize: 34, fontWeight: '900', color: COLORS.dark, marginTop: 8 },

  actionsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  actionItem: { alignItems: 'center', gap: 6, width: '23%' },
  actionCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.gray,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionCircleActive: { backgroundColor: COLORS.primary },
  actionLabel: { fontSize: 11, color: COLORS.dark, fontWeight: '700', textAlign: 'center' },

  startTrack: {
    height: 64,
    borderRadius: 32,
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
    marginTop: 20,
    overflow: 'hidden',
  },
  startTrackTextWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  startTrackTitle: { fontSize: 17, color: COLORS.white, fontWeight: '800' },
  startKnob: {
    position: 'absolute',
    left: 5,
    width: START_KNOB_SIZE,
    height: START_KNOB_SIZE,
    borderRadius: START_KNOB_SIZE / 2,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 6,
  },
});