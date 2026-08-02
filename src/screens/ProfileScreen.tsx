// src/screens/ProfileScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, SafeAreaView, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import GlassPanel from '../components/GlassPanel';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme/colors';

export default function ProfileScreen() {
  const { driver, logout } = useAuth();

  // MUHIM: navigatsiya qilish shart emas — app/_layout.tsx'dagi
  // AppNavigator `isLoggedIn`ni to'g'ridan-to'g'ri kuzatib turadi,
  // driver null bo'lishi bilan avtomatik Login ekraniga o'tadi.
  function handleLogout() {
    logout();
  }

  return (
    <View style={styles.bg}>
      <View style={styles.ornamentTopRight} />
      <View style={styles.ornamentBottomLeft} />

      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.headerRow}>
            <View style={styles.avatar}>
              {driver?.photo ? (
                <Image source={{ uri: driver.photo }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="person" size={32} color={COLORS.white} />
              )}
            </View>
            <View>
              <Text style={styles.name}>{driver?.firstName} {driver?.lastName}</Text>
              <Text style={styles.sub}>{driver?.phone}</Text>
            </View>
          </View>

          <View style={styles.statsRow}>
            <GlassPanel intensity={75} style={[styles.statCard, styles.glassLight]}>
              <Ionicons name="star" size={20} color="#F5A623" />
              <Text style={styles.statValue}>{driver?.rating}</Text>
              <Text style={styles.statLabel}>Reyting</Text>
            </GlassPanel>
            <GlassPanel intensity={75} style={[styles.statCard, styles.glassLight]}>
              <Ionicons name="wallet" size={20} color={COLORS.success} />
              <Text style={styles.statValue}>{driver?.balance?.toLocaleString()}</Text>
              <Text style={styles.statLabel}>Balans (so'm)</Text>
            </GlassPanel>
          </View>

          <GlassPanel intensity={75} style={[styles.card, styles.glassLight]}>
            <Text style={styles.cardTitle}>Avtomobil</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Marka va model</Text>
              <Text style={styles.rowValue}>{driver?.carBrand} {driver?.carModel}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Rang</Text>
              <Text style={styles.rowValue}>{driver?.color}</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Davlat raqami</Text>
              <Text style={styles.rowValue}>{driver?.plateRegion} {driver?.plateBody}</Text>
            </View>
          </GlassPanel>

          <GlassPanel intensity={75} style={[styles.card, styles.glassLight]}>
            <Text style={styles.cardTitle}>Filial</Text>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Joylashuv</Text>
              <Text style={styles.rowValue}>{driver?.branch}</Text>
            </View>
          </GlassPanel>

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color={COLORS.white} />
            <Text style={styles.logoutText}>Chiqish</Text>
          </TouchableOpacity>
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
    top: -70,
    right: -50,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: COLORS.primaryLight,
  },
  ornamentBottomLeft: {
    position: 'absolute',
    bottom: -90,
    left: -70,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: 'rgba(99,102,241,0.08)',
  },

  glassLight: {
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 6,
  },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: COLORS.dark,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  avatarImg: { width: '100%', height: '100%' },
  name: { fontSize: 22, fontWeight: '800', color: COLORS.dark },
  sub: { fontSize: 14, color: COLORS.textMuted, marginTop: 2 },

  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  statCard: {
    flex: 1,
    borderRadius: 18,
    padding: 16,
    alignItems: 'center',
    overflow: 'hidden',
  },
  statValue: { fontSize: 20, fontWeight: '800', color: COLORS.dark, marginTop: 6 },
  statLabel: { fontSize: 11, color: COLORS.textMuted, marginTop: 2, fontWeight: '600' },

  card: {
    borderRadius: 20,
    padding: 18,
    marginBottom: 14,
    overflow: 'hidden',
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: COLORS.textMuted, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  rowLabel: { fontSize: 14, color: COLORS.textMuted, fontWeight: '600' },
  rowValue: { fontSize: 15, color: COLORS.dark, fontWeight: '700' },
  divider: { height: 1, backgroundColor: 'rgba(22,24,29,0.08)' },

  testBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 16,
    backgroundColor: '#6366F1',
    borderRadius: 16,
    shadowColor: '#6366F1',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  testBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 15 },

  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 10,
    paddingVertical: 16,
    backgroundColor: COLORS.dark,
    borderRadius: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  logoutText: { color: COLORS.white, fontWeight: '700', fontSize: 15 },
});