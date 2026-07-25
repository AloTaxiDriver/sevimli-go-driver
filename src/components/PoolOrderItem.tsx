// src/components/PoolOrderItem.tsx
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Order } from '../data/mockOrders';
import { COLORS } from '../theme/colors';

type Props = {
  order: Order;
  onTake: () => void;
};

export default function PoolOrderItem({ order, onTake }: Props) {
  return (
    <View style={styles.item}>
      <View style={styles.infoCol}>
        <Text style={styles.type}>{order.type}</Text>
        <Text style={styles.address}>{order.fromAddress}</Text>
        <View style={styles.metaRow}>
          <Ionicons name="navigate" size={16} color={COLORS.textMuted} />
          <Text style={styles.metaText}>{order.distanceKm} km</Text>
          <Text style={styles.metaDot}>•</Text>
          <Ionicons name="time" size={16} color={COLORS.textMuted} />
          <Text style={styles.metaText}>{order.durationMin} min</Text>
        </View>
      </View>

      <View style={styles.rightCol}>
        <Text style={styles.price}>{order.price.toLocaleString()} so'm</Text>
        <TouchableOpacity style={styles.takeBtn} onPress={onTake}>
          <Text style={styles.takeBtnText}>Olish</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(22,24,29,0.08)',
  },
  infoCol: { flex: 1, paddingRight: 14 },
  type: { fontSize: 19, fontWeight: '800', color: COLORS.dark },
  address: { fontSize: 16, color: COLORS.textMuted, marginTop: 4, lineHeight: 21 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  metaText: { fontSize: 15, color: COLORS.textMuted, fontWeight: '700' },
  metaDot: { color: COLORS.textMuted, fontSize: 15 },

  rightCol: { alignItems: 'flex-end', gap: 10 },
  price: { fontSize: 19, fontWeight: '800', color: COLORS.dark },
  takeBtn: {
    backgroundColor: COLORS.primary,
    borderRadius: 22,
    paddingHorizontal: 24,
    paddingVertical: 11,
  },
  takeBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
});