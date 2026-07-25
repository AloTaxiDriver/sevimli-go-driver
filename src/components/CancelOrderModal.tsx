// src/components/CancelOrderModal.tsx
//
// Haydovchi buyurtmani qabul qilgandan keyin (ready_to_start, to_pickup
// yoki waiting bosqichida) bekor qilmoqchi bo'lsa shu oyna ochiladi.
// Sababni tanlash SHART — sababsiz bekor qilishga ruxsat berilmaydi,
// chunki bu ma'lumot dispetcher paneli statistikasida ishlatiladi.

import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { COLORS } from '../theme/colors';

// MUHIM: bu ro'yxat dashboard'dagi (alotaxi_v50.html) CANCEL_REASONS
// bilan bir xil bo'lishi kerak, shunda ikkala tomondan kelgan sabablar
// bir xil ko'rinishda hisobotlarda chiqadi.
export const CANCEL_REASONS = [
  "Mijoz javob bermadi",
  "Mijoz manzilda yo'q edi",
  "Mijoz o'zi bekor qildi",
  "Texnik muammo",
  "Boshqa sabab",
];

type Props = {
  visible: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
};

export default function CancelOrderModal({ visible, onClose, onConfirm }: Props) {
  const [selected, setSelected] = useState(CANCEL_REASONS[0]);
  const [customReason, setCustomReason] = useState('');

  function handleConfirm() {
    const isOther = selected === CANCEL_REASONS[CANCEL_REASONS.length - 1];
    const reason = isOther && customReason.trim() ? customReason.trim() : selected;
    onConfirm(reason);
    // Keyingi safar ochilganda tozaligicha turishi uchun
    setSelected(CANCEL_REASONS[0]);
    setCustomReason('');
  }

  const isOtherSelected = selected === CANCEL_REASONS[CANCEL_REASONS.length - 1];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>Buyurtmani bekor qilish</Text>
          <Text style={styles.subtitle}>Sababini tanlang</Text>

          {CANCEL_REASONS.map((reason) => {
            const isSelected = selected === reason;
            return (
              <TouchableOpacity
                key={reason}
                style={styles.reasonRow}
                onPress={() => setSelected(reason)}
                activeOpacity={0.7}
              >
                <View style={[styles.radio, isSelected && styles.radioSelected]}>
                  {isSelected && <View style={styles.radioDot} />}
                </View>
                <Text style={styles.reasonText}>{reason}</Text>
              </TouchableOpacity>
            );
          })}

          {isOtherSelected && (
            <TextInput
              style={styles.input}
              placeholder="Sababni yozing..."
              placeholderTextColor={COLORS.textMuted}
              value={customReason}
              onChangeText={setCustomReason}
              multiline
            />
          )}

          <View style={styles.actions}>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose} activeOpacity={0.85}>
              <Text style={styles.closeBtnText}>Yopish</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmBtn} onPress={handleConfirm} activeOpacity={0.85}>
              <Ionicons name="close-circle" size={18} color={COLORS.white} />
              <Text style={styles.confirmBtnText}>Bekor qilish</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    padding: 20,
    paddingBottom: 36,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(22,24,29,0.2)',
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: { fontSize: 18, fontWeight: '800', color: COLORS.dark },
  subtitle: {
    fontSize: 13,
    color: COLORS.textMuted,
    marginTop: 4,
    marginBottom: 10,
    fontWeight: '600',
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: COLORS.primary },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: COLORS.primary },
  reasonText: { fontSize: 15, color: COLORS.dark, fontWeight: '600', flex: 1 },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 12,
    fontSize: 14,
    color: COLORS.dark,
    marginTop: 2,
    marginBottom: 8,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', gap: 12, marginTop: 16 },
  closeBtn: {
    flex: 1,
    paddingVertical: 15,
    borderRadius: 16,
    alignItems: 'center',
    backgroundColor: '#F4F4F6',
    borderWidth: 1,
    borderColor: '#E8E8EC',
  },
  closeBtnText: { color: COLORS.dark, fontWeight: '700', fontSize: 14 },
  confirmBtn: {
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 15,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.danger,
  },
  confirmBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },
});