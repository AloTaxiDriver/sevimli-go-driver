// app/(tabs)/history.tsx
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/context/AuthContext';
import { COLORS } from '../../src/theme/colors';
import { FirestoreOrder, listenToOrderHistory } from '../../src/utils/firebase';

function formatDate(millis?: number) {
  if (!millis) return '';
  const d = new Date(millis);
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  const hours = d.getHours().toString().padStart(2, '0');
  const minutes = d.getMinutes().toString().padStart(2, '0');
  return `${day}.${month} • ${hours}:${minutes}`;
}

export default function HistoryTab() {
  const { driver } = useAuth();
  const driverId = driver?.id || driver?.phone || 'unknown_driver';

  const [orders, setOrders] = useState<FirestoreOrder[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const unsubscribe = listenToOrderHistory(driverId, (result) => {
      setOrders(result);
      setLoading(false);
    });
    return unsubscribe;
  }, [driverId]);

  const completedOrders = orders.filter((o) => o.status === 'completed');
  const totalEarned = completedOrders.reduce((sum, o) => sum + o.price, 0);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Buyurtmalar tarixi</Text>
        <View style={styles.summaryRow}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{completedOrders.length}</Text>
            <Text style={styles.summaryLabel}>Safar</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryValue}>{totalEarned.toLocaleString()}</Text>
            <Text style={styles.summaryLabel}>so'm jami</Text>
          </View>
        </View>
      </View>

      {loading ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>Yuklanmoqda...</Text>
        </View>
      ) : orders.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="time-outline" size={48} color={COLORS.textMuted} />
          <Text style={styles.emptyText}>Hali yakunlangan safarlar yo'q</Text>
        </View>
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const isCancelled = item.status === 'cancelled';
            return (
              <View style={styles.card}>
                <View style={styles.cardTopRow}>
                  <Text style={styles.cardDate}>{formatDate(item.createdAtMillis)}</Text>
                  <View
                    style={[
                      styles.statusBadge,
                      isCancelled ? styles.statusBadgeCancelled : styles.statusBadgeDone,
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        isCancelled ? styles.statusTextCancelled : styles.statusTextDone,
                      ]}
                    >
                      {isCancelled ? 'Bekor qilingan' : 'Yakunlangan'}
                    </Text>
                  </View>
                </View>

                <View style={styles.routeRow}>
                  <View style={styles.routeIcons}>
                    <View style={[styles.routeDot, { backgroundColor: COLORS.success }]} />
                    <View style={styles.routeLine} />
                    <View style={[styles.routeDot, { backgroundColor: COLORS.danger }]} />
                  </View>
                  <View style={styles.routeTexts}>
                    <Text style={styles.routeAddress} numberOfLines={1}>
                      {item.fromAddress || "Manzil ko'rsatilmagan"}
                    </Text>
                    <View style={styles.routeGap} />
                    <Text style={styles.routeAddress} numberOfLines={1}>
                      {item.toAddress || "Manzil ko'rsatilmagan"}
                    </Text>
                  </View>
                </View>

                <View style={styles.cardBottomRow}>
                  <Text style={styles.customerName}>{item.customerName}</Text>
                  {!isCancelled && (
                    <Text style={styles.priceText}>{item.price.toLocaleString()} so'm</Text>
                  )}
                </View>
              </View>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 22, fontWeight: '800', color: COLORS.dark },
  summaryRow: {
    flexDirection: 'row',
    marginTop: 14,
    backgroundColor: COLORS.gray,
    borderRadius: 14,
    paddingVertical: 14,
  },
  summaryItem: { flex: 1, alignItems: 'center' },
  summaryDivider: { width: 1, backgroundColor: COLORS.border },
  summaryValue: { fontSize: 20, fontWeight: '800', color: COLORS.dark },
  summaryLabel: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600', marginTop: 2 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingBottom: 80 },
  emptyText: { fontSize: 14, color: COLORS.textMuted, fontWeight: '600' },
  listContent: { padding: 16, paddingBottom: 100, gap: 12 },
  card: { backgroundColor: COLORS.white, borderRadius: 18, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardDate: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600' },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusBadgeDone: { backgroundColor: COLORS.successLight },
  statusBadgeCancelled: { backgroundColor: '#FDEAEA' },
  statusText: { fontSize: 11, fontWeight: '700' },
  statusTextDone: { color: COLORS.success },
  statusTextCancelled: { color: COLORS.danger },
  routeRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  routeIcons: { alignItems: 'center', paddingTop: 4 },
  routeDot: { width: 8, height: 8, borderRadius: 4 },
  routeLine: { width: 2, flex: 1, minHeight: 16, backgroundColor: COLORS.border, marginVertical: 3 },
  routeTexts: { flex: 1 },
  routeAddress: { fontSize: 14, fontWeight: '600', color: COLORS.dark },
  routeGap: { height: 12 },
  cardBottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  customerName: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600' },
  priceText: { fontSize: 16, fontWeight: '800', color: COLORS.dark },
});