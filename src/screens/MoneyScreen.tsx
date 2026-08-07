// src/screens/MoneyScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import GlassPanel from '../components/GlassPanel';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme/colors';
import {
  DriverBonusGoal,
  DriverBonusSettings,
  FirestoreOrder,
  getDriverBonusSettings,
  listenToDriverDailyBonusStats,
  listenToDriverWeeklyBonusStats,
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

// Cloud Function (onOrderCompletedCheckDriverBonus) bilan BIR XIL
// mantiq — Toshkent (UTC+5) kalendar sanasi/hafta boshi (Dushanba),
// aks holda "faol maqsad" bu yerda boshqa kun/hafta bo'lib qolar edi.
function tashkentDateStr(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}
function tashkentWeekStartStr(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() + 5 * 60 * 60 * 1000);
  const day = shifted.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(shifted);
  monday.setUTCDate(shifted.getUTCDate() - diffToMonday);
  return monday.toISOString().slice(0, 10);
}

const UZ_MONTHS = [
  'yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun',
  'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr',
];

function formatUzDate(dateStr?: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00Z');
  return `${d.getUTCDate()}-${UZ_MONTHS[d.getUTCMonth()]}`;
}

function formatUzWeekRange(weekStartStr?: string): string {
  if (!weekStartStr) return '';
  const start = new Date(weekStartStr + 'T00:00:00Z');
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  return sameMonth
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${UZ_MONTHS[start.getUTCMonth()]}`
    : `${start.getUTCDate()} ${UZ_MONTHS[start.getUTCMonth()]} – ${end.getUTCDate()} ${UZ_MONTHS[end.getUTCMonth()]}`;
}

type GoalCardProps = {
  label: string;
  dateLabel: string;
  count: number;
  threshold: number;
  amount: number;
  isPast?: boolean;
  achieved?: boolean;
};

function GoalCard({ label, dateLabel, count, threshold, amount, isPast, achieved }: GoalCardProps) {
  if (!threshold || threshold <= 0) return null;
  const pct = Math.min(100, Math.round((count / threshold) * 100));
  return (
    <View style={[styles.goalCard, isPast ? styles.goalCardPast : styles.goalCardActive]}>
      <View style={styles.goalHeaderRow}>
        <View>
          <Text style={styles.goalLabel}>{label}</Text>
          <View style={styles.goalDateRow}>
            <Text style={styles.goalDate}>{dateLabel}</Text>
            {isPast && (
              <View style={[styles.goalBadge, achieved ? styles.goalBadgeWon : styles.goalBadgeLost]}>
                <Ionicons name={achieved ? 'checkmark' : 'close'} size={9} color="#fff" />
              </View>
            )}
          </View>
        </View>
        <Text style={[styles.goalAmount, isPast && !achieved && styles.goalAmountMuted]}>
          {amount.toLocaleString()} so'm
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[
            styles.progressFill,
            { width: `${pct}%` },
            isPast && !achieved && styles.progressFillMuted,
          ]}
        />
      </View>
      <Text style={styles.goalCountText}>{count} / {threshold} buyurtma</Text>
    </View>
  );
}

export default function MoneyScreen() {
  const { driver } = useAuth();
  const driverId = driver?.id || driver?.phone || 'unknown_driver';

  const [orders, setOrders] = useState<FirestoreOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(6); // bugun
  const [dailyGoals, setDailyGoals] = useState<DriverBonusGoal[]>([]);
  const [weeklyGoals, setWeeklyGoals] = useState<DriverBonusGoal[]>([]);
  const [bonusSettings, setBonusSettings] = useState<DriverBonusSettings | null>(null);

  useEffect(() => {
    setLoading(true);
    const unsubscribe = listenToOrderHistory(driverId, (result) => {
      setOrders(result);
      setLoading(false);
    });
    return unsubscribe;
  }, [driverId]);

  useEffect(() => {
    const unsubDaily = listenToDriverDailyBonusStats(driverId, setDailyGoals);
    const unsubWeekly = listenToDriverWeeklyBonusStats(driverId, setWeeklyGoals);
    return () => {
      unsubDaily();
      unsubWeekly();
    };
  }, [driverId]);

  useEffect(() => {
    getDriverBonusSettings().then(setBonusSettings);
  }, []);

  const weekEarnings = useMemo(() => buildWeekEarnings(orders), [orders]);
  const maxEarning = Math.max(1, ...weekEarnings.map((d) => d.amount));
  const selected = weekEarnings[selectedIndex] ?? weekEarnings[weekEarnings.length - 1];
  const totalWeek = weekEarnings.reduce((sum, d) => sum + d.amount, 0);
  const totalAllTime = useMemo(
    () => orders.filter((o) => o.status === 'completed').reduce((sum, o) => sum + o.price, 0),
    [orders]
  );

  const todayStr = useMemo(() => tashkentDateStr(), []);
  const weekStartStr = useMemo(() => tashkentWeekStartStr(), []);
  const todayGoal = dailyGoals.find((g) => g.id === todayStr);
  const weekGoal = weeklyGoals.find((g) => g.id === weekStartStr);
  const pastDailyGoals = dailyGoals.filter((g) => g.id !== todayStr).slice(0, 7);
  const pastWeeklyGoals = weeklyGoals.filter((g) => g.id !== weekStartStr).slice(0, 6);

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

          {(bonusSettings?.dailyEnabled || bonusSettings?.weeklyEnabled) ? (
            <>
              <Text style={styles.sectionTitle}>Faol maqsadlar</Text>
              <GoalCard
                label="Bugungi maqsad"
                dateLabel="Bugun"
                count={todayGoal?.qualifyingTripCount || 0}
                threshold={bonusSettings?.dailyEnabled ? (todayGoal?.tripThreshold || bonusSettings.dailyTripThreshold || 0) : 0}
                amount={todayGoal?.targetBonusAmount || bonusSettings?.bonusAmount || 0}
              />
              <GoalCard
                label="Haftalik maqsad"
                dateLabel={formatUzWeekRange(weekStartStr)}
                count={weekGoal?.qualifyingTripCount || 0}
                threshold={bonusSettings?.weeklyEnabled ? (weekGoal?.tripThreshold || bonusSettings.weeklyTripThreshold || 0) : 0}
                amount={weekGoal?.targetBonusAmount || bonusSettings?.weeklyBonusAmount || 0}
              />
            </>
          ) : null}

          {pastDailyGoals.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>O'tgan kunlar</Text>
              {pastDailyGoals.map((g) => (
                <GoalCard
                  key={g.id}
                  label="Kunlik"
                  dateLabel={formatUzDate(g.date || g.id)}
                  count={g.qualifyingTripCount}
                  threshold={g.tripThreshold || bonusSettings?.dailyTripThreshold || 0}
                  amount={g.targetBonusAmount || bonusSettings?.bonusAmount || 0}
                  isPast
                  achieved={g.bonusAwarded}
                />
              ))}
            </>
          )}

          {pastWeeklyGoals.length > 0 && (
            <>
              <Text style={styles.sectionTitle}>O'tgan haftalar</Text>
              {pastWeeklyGoals.map((g) => (
                <GoalCard
                  key={g.id}
                  label="Haftalik"
                  dateLabel={formatUzWeekRange(g.weekStart || g.id)}
                  count={g.qualifyingTripCount}
                  threshold={g.tripThreshold || bonusSettings?.weeklyTripThreshold || 0}
                  amount={g.targetBonusAmount || bonusSettings?.weeklyBonusAmount || 0}
                  isPast
                  achieved={g.bonusAwarded}
                />
              ))}
            </>
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

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    marginBottom: 8,
    marginTop: 4,
  },

  goalCard: {
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
  },
  goalCardActive: { backgroundColor: COLORS.successLight, borderColor: 'rgba(22,163,74,0.15)' },
  goalCardPast: { backgroundColor: '#FAFAFA', borderColor: 'rgba(0,0,0,0.06)' },
  goalHeaderRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  goalLabel: { fontSize: 10.5, fontWeight: '700', color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 },
  goalDateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  goalDate: { fontSize: 13, fontWeight: '700', color: COLORS.dark },
  goalBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  goalBadgeWon: { backgroundColor: COLORS.primary },
  goalBadgeLost: { backgroundColor: 'rgba(0,0,0,0.2)' },
  goalAmount: { fontSize: 13, fontWeight: '800', color: COLORS.primary },
  goalAmountMuted: { color: 'rgba(0,0,0,0.35)' },
  progressTrack: {
    height: 6,
    backgroundColor: 'rgba(0,0,0,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 10,
    marginBottom: 6,
  },
  progressFill: { height: '100%', backgroundColor: COLORS.primary, borderRadius: 3 },
  progressFillMuted: { backgroundColor: 'rgba(0,0,0,0.2)' },
  goalCountText: { fontSize: 11.5, color: COLORS.textMuted, fontWeight: '600' },

  loadingText: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600', textAlign: 'center', marginTop: 8 },
});