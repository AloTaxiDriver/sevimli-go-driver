// src/components/OrderCard.tsx
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Order } from '../data/mockOrders';
import { COLORS } from '../theme/colors';
import GlassPanel from './GlassPanel';

type Props = {
  order: Order;
  onAccept: () => void;
  onSkip: () => void;
};

export default function OrderCard({ order, onAccept, onSkip }: Props) {
  return (
    <GlassPanel intensity={80} style={styles.sheet}>
      <View style={styles.dragHandle} />

      <Text style={styles.title}>{order.type}</Text>

      <View style={styles.metaRow}>
        <View style={styles.metaItem}>
          <Ionicons name="navigate" size={18} color={COLORS.primary} />
          <Text style={styles.metaValue}>{order.distanceKm} km</Text>
        </View>
        <View style={styles.metaDivider} />
        <View style={styles.metaItem}>
          <Ionicons name="time" size={18} color={COLORS.primary} />
          <Text style={styles.metaValue}>{order.durationMin} min</Text>
        </View>
      </View>

      <Text style={styles.subMeta}>
        {order.pickupCount} olish, {order.dropoffCount} topshirish
      </Text>
      {!!order.packageDescription && (
        <Text style={styles.packageText} numberOfLines={2}>📦 {order.packageDescription}</Text>
      )}

      <View style={styles.cashRow}>
        <Text style={styles.cashLabel}>Naqd pul olish</Text>
        <Text style={styles.cashValue}>{order.price.toLocaleString()} so'm</Text>
      </View>

      <Text style={styles.fromLabel}>Qayerdan</Text>
      <Text style={styles.fromAddress}>{order.fromAddress}</Text>

      <View style={styles.routeDivider}>
        <View style={styles.routeDot} />
        <View style={styles.routeLine} />
        <View style={[styles.routeDot, styles.routeDotEnd]} />
      </View>

      <Text style={styles.fromLabel}>Qayerga</Text>
      <Text style={styles.fromAddress}>{order.toAddress}</Text>

      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.skipBtn} onPress={onSkip}>
          <Text style={styles.skipText}>O'tkazib yuborish</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.acceptBtn} onPress={onAccept}>
          <Text style={styles.acceptText}>Qabul qilish</Text>
        </TouchableOpacity>
      </View>
    </GlassPanel>
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
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(22,24,29,0.2)',
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 26, fontWeight: '800', color: COLORS.dark },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F4F4F6',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginTop: 12,
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

  subMeta: { fontSize: 14, color: COLORS.textMuted, marginTop: 10 },
  packageText: { fontSize: 13, color: COLORS.dark, fontWeight: '600', marginTop: 6 },

  cashRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#E3F5EC',
    borderRadius: 14,
    padding: 14,
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#CDEBDC',
  },
  cashLabel: { fontSize: 14, color: COLORS.dark, fontWeight: '600', flex: 1 },
  cashValue: { fontSize: 18, color: COLORS.dark, fontWeight: '800' },

  fromLabel: { fontSize: 13, color: COLORS.textMuted, marginTop: 16 },
  fromAddress: { fontSize: 16, color: COLORS.dark, fontWeight: '600', marginTop: 4 },

  routeDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
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
    flex: 0,
    width: 14,
    height: 1.5,
    backgroundColor: 'rgba(22,24,29,0.15)',
    marginHorizontal: 6,
  },

  actionsRow: {
    flexDirection: 'row',
    marginTop: 24,
    borderRadius: 30,
    overflow: 'hidden',
    gap: 10,
  },
  skipBtn: {
    flex: 1,
    backgroundColor: 'rgba(22,24,29,0.85)',
    borderRadius: 30,
    paddingVertical: 18,
    alignItems: 'center',
  },
  skipText: { color: COLORS.white, fontWeight: '700', fontSize: 15 },
  acceptBtn: {
    flex: 1,
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
  acceptText: { color: COLORS.white, fontWeight: '700', fontSize: 15 },
});