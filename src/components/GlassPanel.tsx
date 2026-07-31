// src/components/GlassPanel.tsx
//
// MUHIM: bu komponent avval iOS'da haqiqiy BlurView (shisha/glassmorphism
// effekti) ishlatar edi. Foydalanuvchi buni ko'rgach rad etdi (mijoz
// ilovasida ham xuddi shu sabab bilan avval olib tashlangan edi) —
// endi ikkala platformada ham TO'LIQ QATTIQ (shaffof emas) fon
// ishlatiladi, xarita yoki orqadagi hech narsa ko'rinmaydi.
//
// `tintColor` berilsa, shu rang to'liq qattiq holda ishlatiladi
// (masalan, coral power tugmasi uchun). Berilmasa, standart to'liq
// qattiq oq fon ishlatiladi.
//
// `onLayout` to'g'ridan-to'g'ri ichki View'ga uzatiladi — bu orqali
// tashqi komponentlar (masalan TripCard) kartaning haqiqiy o'lchangan
// balandligini olib, dinamik hisob-kitoblar qilishi mumkin.

import React from 'react';
import { LayoutChangeEvent, StyleProp, View, ViewStyle } from 'react-native';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  tintColor?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
};

export default function GlassPanel({ children, style, tintColor, onLayout }: Props) {
  return (
    <View onLayout={onLayout} style={[style, { backgroundColor: tintColor ?? '#FFFFFF' }]}>
      {children}
    </View>
  );
}