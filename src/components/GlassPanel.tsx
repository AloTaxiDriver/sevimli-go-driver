// src/components/GlassPanel.tsx
//
// iOS'da BlurView (shisha effekti) chiroyli ishlaydi.
// Android'da BlurView ko'pincha xira/kulrang yoki shaffof bo'lib,
// noto'g'ri chiqadi, shuning uchun Android uchun TO'LIQ QATTIQ
// (shaffof emas) fon ishlatamiz — xarita yoki orqadagi hech narsa
// ko'rinmasligi kerak. Bu komponent shu mantiqni bir joyda jamlab,
// boshqa ekranlarda (MapScreen, LoginScreen, ProfileScreen va h.k.)
// qayta-qayta yozmasdan ishlatish imkonini beradi.
//
// `tintColor` berilsa, Android'da aynan shu rang to'liq qattiq holda
// ishlatiladi (masalan, coral power tugmasi uchun). Berilmasa,
// standart to'liq qattiq oq fon ishlatiladi.
//
// `onLayout` qabul qilinadi va to'g'ridan-to'g'ri ichki View/BlurView'ga
// uzatiladi — bu orqali tashqi komponentlar (masalan TripCard) kartaning
// haqiqiy o'lchangan balandligini olib, dinamik hisob-kitoblar qilishi mumkin.

import { BlurView } from 'expo-blur';
import React from 'react';
import { LayoutChangeEvent, Platform, StyleProp, View, ViewStyle } from 'react-native';

type Props = {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  // Agar berilsa, Android'da shu rang to'liq qattiq holda ishlatiladi
  // (masalan, coral power tugmasi uchun)
  tintColor?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
};

export default function GlassPanel({ children, style, intensity = 80, tintColor, onLayout }: Props) {
  if (Platform.OS === 'android') {
    return (
      <View
        onLayout={onLayout}
        style={[
          style,
          // To'liq qattiq fon — shaffoflik yo'q, orqadagi xarita ko'rinmaydi
          { backgroundColor: tintColor ?? '#FFFFFF' },
        ]}
      >
        {children}
      </View>
    );
  }
  return (
    <BlurView intensity={intensity} tint="light" style={style} onLayout={onLayout}>
      {children}
    </BlurView>
  );
}