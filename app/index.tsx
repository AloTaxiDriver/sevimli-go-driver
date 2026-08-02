// app/index.tsx
// MUHIM: kirish/chiqish holati endi app/_layout.tsx'da (AppNavigator)
// hal qilinadi — bu ekran shu <Stack/> mounted bo'lganda (ya'ni
// FAQAT tizimga kirilgan bo'lsa) ishga tushadi, shuning uchun bu
// yerda qayta autentifikatsiya tekshiruvi kerak emas.
import { Redirect } from 'expo-router';
import React from 'react';

export default function Index() {
  return <Redirect href="/(tabs)" />;
}
