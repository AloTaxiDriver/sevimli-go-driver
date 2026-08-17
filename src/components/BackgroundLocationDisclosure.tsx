// src/components/BackgroundLocationDisclosure.tsx
//
// Google Play "Prominent Disclosure" oynasi — fon rejimidagi joylashuv
// uchun. Haydovchi ishni birinchi marta boshlaganda, TIZIMNING RUXSAT
// OYNASIDAN OLDIN ko'rsatiladi.
//
// Qoidaning talablari va ular shu yerda qanday bajarilgani:
//   1. Ilovaning O'ZIDA ko'rsatilsin, maxfiylik siyosatida emas — shu
//      oyna.
//   2. "FON rejimida", ya'ni ilova ochiq bo'lmaganda ham yig'ilishi
//      ANIQ yozilsin — sarlavha va birinchi xatboshi aynan shu haqda.
//   3. Nima uchun kerakligi tushuntirilsin — uchta sabab ro'yxati.
//   4. Foydalanuvchi ANIQ rozilik bersin — "Roziman" tugmasi. Oyna
//      o'zi yopilmaydi, tashqarisiga bosib ham yopib bo'lmaydi
//      (backdrop bosilmaydigan qilingan) — javob berish SHART.
//   5. Rad etish imkoniyati bo'lsin va u yashirilmasin — ikkinchi
//      tugma xuddi shunday ko'rinarli.
//
// MUHIM: rad etilsa ham haydovchi ishlay oladi — ilova ochiq turganda
// joylashuv baribir yuboriladi (foreground service). Faqat ilova
// yopilganda kuzatuv to'xtaydi. Shuning uchun rad etish tugmasi
// "ishlamaydi" degani emas, va matnda ham shunday aytilgan.

import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { COLORS } from '../theme/colors';

type Props = {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
};

const REASONS = [
  {
    icon: 'navigate' as const,
    title: 'Buyurtma taqsimlash',
    text:
      "Dispetcher tizimi buyurtmani eng yaqin haydovchiga yuboradi. Ilova ekranda " +
      "bo'lmaganda ham joriy joylashuvingiz kerak — aks holda sizga uzoqdagi " +
      "buyurtmalar tushadi yoki umuman tushmaydi.",
  },
  {
    icon: 'people' as const,
    title: 'Mijozni xabardor qilish',
    text: "Safar davomida mijoz sizning xaritada real vaqtda harakatlanishingizni kuzatadi.",
  },
  {
    icon: 'shield-checkmark' as const,
    title: 'Xavfsizlik',
    text: 'Nizo yoki favqulodda holatda safar marshruti tiklanadi.',
  },
];

export default function BackgroundLocationDisclosure({ visible, onAccept, onDecline }: Props) {
  return (
    // `onRequestClose` — Android'ning "orqaga" tugmasi. U ham rad etish
    // deb hisoblanadi: oyna javobsiz yopilib ketmasligi kerak.
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onDecline}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.headerRow}>
            <View style={styles.iconCircle}>
              <Ionicons name="location" size={22} color={COLORS.primary} />
            </View>
            <Text style={styles.title}>Joylashuv fon rejimida ham yig&apos;iladi</Text>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={styles.lead}>
              Sevimli Go Driver siz <Text style={styles.bold}>ish rejimini yoqqan</Text> paytda
              joylashuvingizni <Text style={styles.bold}>ilova yopiq turganda ham</Text> yig&apos;adi.
            </Text>

            {REASONS.map((r) => (
              <View key={r.title} style={styles.reasonRow}>
                <Ionicons name={r.icon} size={18} color={COLORS.primary} style={styles.reasonIcon} />
                <View style={styles.reasonTextWrap}>
                  <Text style={styles.reasonTitle}>{r.title}</Text>
                  <Text style={styles.reasonText}>{r.text}</Text>
                </View>
              </View>
            ))}

            <View style={styles.noteBox}>
              <Text style={styles.noteText}>
                Yig&apos;ish faqat siz ish rejimini yoqqaningizda boshlanadi va uni
                o&apos;chirsangiz <Text style={styles.bold}>darhol to&apos;xtaydi</Text>. Ish
                rejimida ekansiz, ekranda doimiy bildirishnoma turadi — kuzatuv ketayotganini
                har doim bilasiz.
              </Text>
              <Text style={[styles.noteText, styles.noteSpacing]}>
                Ma&apos;lumot uchinchi tomonlarga berilmaydi.
              </Text>
            </View>
          </ScrollView>

          <TouchableOpacity style={styles.acceptBtn} onPress={onAccept} activeOpacity={0.85}>
            <Text style={styles.acceptBtnText}>Roziman</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.declineBtn} onPress={onDecline} activeOpacity={0.85}>
            <Text style={styles.declineBtnText}>Faqat ilova ochiq bo&apos;lganda</Text>
          </TouchableOpacity>
          <Text style={styles.declineHint}>
            Bu holatda ham ishlashingiz mumkin, lekin ilova yopilsa buyurtmalar kamroq tushadi.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 28,
    maxHeight: '88%',
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(22,24,29,0.2)',
    alignSelf: 'center',
    marginBottom: 14,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primaryLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, fontSize: 18, fontWeight: '800', color: COLORS.dark },
  body: { marginTop: 14 },
  bodyContent: { paddingBottom: 4 },
  lead: { fontSize: 14, lineHeight: 21, color: COLORS.dark, marginBottom: 14 },
  bold: { fontWeight: '800' },
  reasonRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  reasonIcon: { marginTop: 2 },
  reasonTextWrap: { flex: 1 },
  reasonTitle: { fontSize: 14, fontWeight: '700', color: COLORS.dark, marginBottom: 2 },
  reasonText: { fontSize: 13, lineHeight: 19, color: COLORS.textMuted },
  noteBox: {
    backgroundColor: COLORS.gray,
    borderRadius: 14,
    padding: 14,
    marginTop: 4,
  },
  noteText: { fontSize: 13, lineHeight: 19, color: COLORS.dark },
  noteSpacing: { marginTop: 8 },
  acceptBtn: {
    marginTop: 16,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    backgroundColor: COLORS.primary,
  },
  acceptBtnText: { color: COLORS.white, fontWeight: '800', fontSize: 15 },
  declineBtn: {
    marginTop: 10,
    paddingVertical: 15,
    borderRadius: 16,
    alignItems: 'center',
    backgroundColor: '#F4F4F6',
    borderWidth: 1,
    borderColor: '#E8E8EC',
  },
  declineBtnText: { color: COLORS.dark, fontWeight: '700', fontSize: 14 },
  declineHint: {
    fontSize: 12,
    lineHeight: 17,
    color: COLORS.textMuted,
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 8,
  },
});
