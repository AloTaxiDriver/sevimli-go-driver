// src/screens/BlockedScreen.tsx
//
// ADMIN BLOKLAGAN HAYDOVCHI KO'RADIGAN EKRAN
// ============================================================
// MUHIM: bu ekran ILOVA ILDIZIDA (app/_layout.tsx) ko'rsatiladi,
// tab'larning ICHIDA emas.
//
// Avval u MapScreen ichida Modal edi va faqat XARITA tabini qoplardi:
// haydovchi pastdagi "Tarix" yoki "Hisob" tabiga o'tishi bilan xabar
// yo'qolar, u esa nima uchun ishlay olmayotganini bilmay qolardi.
//
// Tugallanmagan safar bo'lsa bu ekran KO'RSATILMAYDI — mijoz mashinada
// bo'lishi mumkin va uni yo'lda qoldirib bo'lmaydi. O'shanda haydovchi
// xaritada qizil lenta ko'radi va safarni yakunlab oladi.

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { SafeAreaView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';

type Props = {
  reason?: string;
  onLogout: () => void;
};

export default function BlockedScreen({ reason, onLogout }: Props) {
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.center}>
        <View style={styles.iconCircle}>
          <Ionicons name="lock-closed" size={44} color={COLORS.danger} />
        </View>

        <Text style={styles.title}>Siz admin tomonidan bloklangansiz</Text>

        <Text style={styles.text}>
          {reason && reason.trim()
            ? `Sababi: ${reason.trim()}`
            : "Batafsil ma'lumot uchun dispetcherga murojaat qiling."}
        </Text>

        <Text style={styles.note}>
          {'Blok olinmaguncha buyurtma qabul qila olmaysiz.'}
        </Text>

        <TouchableOpacity style={styles.btn} onPress={onLogout} activeOpacity={0.85}>
          <Text style={styles.btnText}>Chiqish</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30, gap: 16 },
  iconCircle: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: 'rgba(220,38,38,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  title: { fontSize: 21, fontWeight: '800', color: COLORS.dark, textAlign: 'center' },
  text: { fontSize: 15, color: COLORS.dark, textAlign: 'center', lineHeight: 22 },
  note: { fontSize: 13, color: COLORS.textMuted, textAlign: 'center', lineHeight: 19 },
  btn: {
    marginTop: 14,
    alignSelf: 'stretch',
    backgroundColor: COLORS.danger,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnText: { color: COLORS.white, fontSize: 16, fontWeight: '800' },
});
