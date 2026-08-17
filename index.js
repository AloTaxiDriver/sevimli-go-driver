// index.js — ilovaning HAQIQIY kirish nuqtasi.
//
// package.json'dagi `main` avval to'g'ridan-to'g'ri "expo-router/entry"
// edi. Bu shuni anglatardiki, to'plam (bundle) yuklanganda faqat
// navigatsiya tizimi ishga tushardi — `app/` papkasidagi ekranlar esa
// render qilinganda, KEYINROQ yuklanardi.
//
// Ilova butunlay yopiq holatda Android JS'ni ekransiz ("headless")
// ishga tushiradi: yangi buyurtma push xabari kelganda va foreground
// service joylashuv yetkazganda. O'shanda hech qanday ekran render
// qilinmaydi, demak `app/_layout.tsx` ham yuklanmaydi. Fon rejimi
// uchun zarur ro'yxatdan o'tishlar aynan o'sha faylda turgani uchun
// ular AMALDA hech qachon bajarilmasdi.
//
// Endi ular alohida faylga ko'chirildi va shu yerda, expo-router'dan
// OLDIN import qilinadi — ya'ni to'plam yuklangan zahoti, ekran
// bor-yo'qligidan qat'i nazar bajariladi.
import './src/utils/backgroundRegistrations';

import 'expo-router/entry';
