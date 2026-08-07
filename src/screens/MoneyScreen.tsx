// src/screens/MoneyScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import GlassPanel from '../components/GlassPanel';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme/colors';
import {
  DriverBonusHistoryEntry,
  FirestoreOrder,
  listenToDriverBonusHistory,
  listenToOrderHistory,
} from '../utils/firebase';

const CHART_HEIGHT = 120;
const WEEKDAY_LABELS = ['Yak', 'Dush', 'Sesh', 'Chor', 'Pay', 'Jum', 'Shan'];

type DayEarning = {
  date: Date;
  day: number;
  label: string;
  amount: number;
  tripsCount: number;
};

// Oxirgi 7 kun (bugun bilan tugaydi) uchun, yakunlangan buyurtmalar
// narxidan real daromad hisoblanadi. Bekor qilingan buyurtmalar
// hisobga olinmaydi.
function buildWeekEarnings(orders: FirestoreOrder[]): DayEarning[] {
  const days: DayEarning[] = [];
  const today = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ date: d, day: d.getDate(), label: WEEKDAY_LABELS[d.getDay()], amount: 0, tripsCount: 0 });
  }
  orders.forEach((o) => {
    if (o.status !== 'completed' || !o.createdAtMillis) return;
    const od = new Date(o.createdAtMillis);
    od.setHours(0, 0, 0, 0);
    const match = days.find((d) => d.date.getTime() === od.getTime());
    if (match) {
      match.amount += o.price;
      match.tripsCount += 1;
    }
  });
  return days;
}

function formatBonusDate(dateStr: string): string {
  const parts = dateStr?.split('-');
  if (!parts || parts.length !== 3) return dateStr || '';
  return `${parts[2]}.${parts[1]}`;
}

export default function MoneyScreen() {
  const { driver } = useAuth();
  const driverId = driver?.id || driver?.phone || 'unknown_driver';

  const [orders, setOrders] = useState<FirestoreOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(6); // bugun
  const [bonusHistory, setBonusHistory] = useState<DriverBonusHistoryEntry[]>([]);

  useEffect(() => {
    setLoading(true);
    const unsubscribe = listenToOrderHistory(driverId, (result) => {
      setOrders(result);
      setLoading(false);
    });
    return unsubscribe;
  }, [driverId]);

  useEffect(() => {
    const unsubscribe = listenToDriverBonusHistory(driverId, setBonusHistory);
    return unsubscribe;
  }, [driverId]);

  const weekEarnings = useMemo(() => buildWeekEarnings(orders), [orders]);
  const maxEarning = Math.max(1, ...weekEarnings.map((d) => d.amount));
  const selected = weekEarnings[selectedIndex] ?? weekEarnings[weekEarnings.length - 1];
  const totalWeek = weekEarnings.reduce((sum, d) => sum + d.amount, 0);
  const totalAllTime = useMemo(
    () => orders.filter((o) => o.status === 'completed').reduce((sum, o) => sum + o.price, 0),
    [orders]
  );

  const isSelectedToday = selected.date.toDateString() === new Date().toDateString();
  const selectedDateLabel = `${selected.day.toString().padStart(2, '0')}.${(selected.date.getMonth() + 1)
    .toString()
    .padStart(2, '0')}`;

  return (
    <View style={styles.bg}>
      <View style={styles.ornamentTopRight} />
      <View style={styles.ornamentBottomLeft} />

      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Pul</Text>

          <Text style={styles.bigAmount}>{selected.amount.toLocaleString()} so'm</Text>
          <Text style={styles.bigAmountLabel}>
            {isSelectedToday ? 'Bugun' : selectedDateLabel} • {selected.tripsCount} safar
          </Text>

          <GlassPanel intensity={75} style={[styles.chartCard, styles.glassLight]}>
            <View style={styles.chartRow}>
              {weekEarnings.map((d, index) => {
                const isSelected = index === selectedIndex;
                const barHeight = Math.max(6, (d.amount / maxEarning) * CHART_HEIGHT);
                return (
                  <TouchableOpacity
                    key={d.date.getTime()}
                    style={styles.barColumn}
                    onPress={() => setSelectedIndex(index)}
                  >
                    <View style={styles.barTrack}>
                      <View
                        style={[
                          styles.bar,
                          { height: barHeight },
                          isSelected ? styles.barActive : styles.barInactive,
                        ]}
                      />
                    </View>
                    <Text style={[styles.dayLabel, isSelected && styles.dayLabelActive]}>
                      {d.label}
                    </Text>
                    <Text style={[styles.dayNumber, isSelected && styles.dayNumberActive]}>
                      {d.day}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </GlassPanel>

          <GlassPanel intensity={75} style={[styles.card, styles.glassLight]}>
            <View style={styles.cardRow}>
              <Text style={styles.cardLabel}>Hafta jami</Text>
              <Text style={styles.cardValue}>{totalWeek.toLocaleString()} so'm</Text>
            </View>
          </GlassPanel>

          <GlassPanel intensity={75} style={[styles.card, styles.glassLight]}>
            <View style={styles.cardRow}>
              <View style={styles.cardIconLabel}>
                <Ionicons name="wallet" size={18} color={COLORS.textMuted} />
                <View>
                  <Text style={styles.cardLabel}>Jami ishlab topilgan</Text>
                  <Text style={styles.cardSubLabel}>Barcha vaqt uchun</Text>
                </View>
              </View>
              <Text style={styles.cardValueBig}>{totalAllTime.toLocaleString()} so'm</Text>
            </View>
          </GlassPanel>

          {bonusHistory.length > 0 && (
            <GlassPanel intensity={75} style={[styles.card, styles.glassLight]}>
              <View style={styles.cardIconLabel}>
                <Ionicons name="gift" size={18} color={COLORS.textMuted} />
                <Text style={styles.cardLabel}>Bonus tarixi</Text>
              </View>
              {bonusHistory.map((entry) => (
                <View key={entry.id} style={styles.bonusRow}>
                  <View style={styles.bonusDateRow}>
                    <Text style={styles.bonusDate}>{formatBonusDate(entry.date)}</Text>
                    <View style={[styles.bonusBadge, entry.period === 'weekly' && styles.bonusBadgeWeekly]}>
                      <Text style={[styles.bonusBadgeText, entry.period === 'weekly' && styles.bonusBadgeTextWeekly]}>
                        {entry.period === 'weekly' ? 'Haftalik' : 'Kunlik'}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.bonusTrips}>{entry.tripCount} safar</Text>
                  <Text style={styles.bonusAmount}>+{entry.amount.toLocaleString()} so'm</Text>
                </View>
              ))}
            </GlassPanel>
          )}

          {loading && orders.length === 0 && (
            <Text style={styles.loadingText}>Yuklanmoqda...</Text>
          )}
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: COLORS.bg, overflow: 'hidden' },
  safe: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },

  ornamentTopRight: {
    position: 'absolute',
    top: -60,
    right: -60,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: COLORS.primaryLight,
  },
  ornamentBottomLeft: {
    position: 'absolute',
    bottom: -80,
    left: -70,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: COLORS.successLight,
  },

  title: { fontSize: 28, fontWeight: '800', color: COLORS.dark },

  bigAmount: { fontSize: 38, fontWeight: '800', color: COLORS.dark, marginTop: 8 },
  bigAmountLabel: { fontSize: 14, color: COLORS.textMuted, marginTop: 2, marginBottom: 16 },

  glassLight: {
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
  },

  chartCard: {
    borderRadius: 22,
    padding: 16,
    marginBottom: 16,
    overflow: 'hidden',
  },
  chartRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  barColumn: { alignItems: 'center', flex: 1 },
  barTrack: {
    height: CHART_HEIGHT,
    justifyContent: 'flex-end',
  },
  bar: {
    width: 20,
    borderRadius: 6,
  },
  barActive: { backgroundColor: COLORS.primary },
  barInactive: { backgroundColor: 'rgba(22,24,29,0.15)' },
  dayLabel: { fontSize: 11, color: COLORS.textMuted, marginTop: 8, fontWeight: '600' },
  dayLabelActive: { color: COLORS.dark },
  dayNumber: { fontSize: 13, color: COLORS.textMuted, fontWeight: '700' },
  dayNumberActive: { color: COLORS.primary },

  card: {
    borderRadius: 20,
    padding: 16,
    marginBottom: 12,
    overflow: 'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardIconLabel: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  cardLabel: { fontSize: 15, fontWeight: '700', color: COLORS.dark },
  cardSubLabel: { fontSize: 12, color: COLORS.textMuted, marginTop: 2 },
  cardValue: { fontSize: 16, fontWeight: '800', color: COLORS.dark },
  cardValueBig: { fontSize: 22, fontWeight: '800', color: COLORS.dark },

  bonusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
  },
  bonusDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  bonusDate: { fontSize: 13, fontWeight: '700', color: COLORS.dark },
  bonusBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 20, backgroundColor: COLORS.successLight },
  bonusBadgeWeekly: { backgroundColor: '#EEF2FF' },
  bonusBadgeText: { fontSize: 9, fontWeight: '700', color: COLORS.primary },
  bonusBadgeTextWeekly: { color: '#4338CA' },
  bonusTrips: { fontSize: 12, color: COLORS.textMuted, flex: 1, textAlign: 'center' },
  bonusAmount: { fontSize: 14, fontWeight: '800', color: COLORS.primary },

  loadingText: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600', textAlign: 'center', marginTop: 8 },
});