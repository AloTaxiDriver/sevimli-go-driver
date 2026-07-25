// app/(tabs)/_layout.tsx
import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS } from '../../src/theme/colors';

export default function TabsLayout() {
  // insets.bottom - bu Android'da pastki tizim tugmalari (Menu/Uy/Orqaga)
  // egallagan joy balandligi. Har xil telefonlarda bu turlicha bo'ladi
  // (gesture navigatsiya yoki tugma navigatsiya), shuning uchun qat'iy
  // son yozish o'rniga, shu qiymatni dinamik ravishda olib qo'shamiz.
  const insets = useSafeAreaInsets();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: COLORS.primary,
        tabBarInactiveTintColor: COLORS.textMuted,
        tabBarStyle: {
          height: 64 + insets.bottom,
          paddingBottom: 8 + insets.bottom,
          paddingTop: 6,
          position: 'absolute',
          borderTopWidth: 1,
          borderTopColor: '#E8E8EC',
          // To'liq qattiq oq fon — orqadagi xarita yoki boshqa
          // kontent hech qachon ko'rinmasligi kerak
          backgroundColor: '#FFFFFF',
          elevation: 0,
        },
        // Android'da BlurView ishlatilmaydi (xira/noto'g'ri chiqadi),
        // shuning uchun tabBarBackground butunlay olib tashlandi —
        // tabBarStyle'dagi to'liq qattiq backgroundColor yetarli.
        // iOS'da hali ham shisha effekti uchun View qoldirildi (shaffof,
        // chunki haqiqiy blur kerak bo'lsa BlurView import qilib qo'shish mumkin).
        tabBarBackground:
          Platform.OS === 'ios' ? () => <View style={{ flex: 1 }} /> : undefined,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Buyurtmalar',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="navigate" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: 'Tarix',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="money"
        options={{
          title: 'Pul',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profil',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}