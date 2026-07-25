// src/utils/notifications.ts
// Buyurtma kelganda ovoz va vibratsiya signalini chiqarish.

import { Audio } from 'expo-av';
import * as Haptics from 'expo-haptics';

let orderSound: Audio.Sound | null = null;
let poolSound: Audio.Sound | null = null;
// "Safarni boshlash" bosilganda (xavfsizlik eslatmasi) va "Safarni
// yakunlash" bosilganda (xayrlashuv xabari) chalinadigan ovozlar
let tripStartSound: Audio.Sound | null = null;
let tripEndSound: Audio.Sound | null = null;

async function configureAudioMode() {
  try {
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
    });
  } catch (error) {
    console.warn('Audio mode sozlashda xato:', error);
  }
}

export async function preloadSounds() {
  await configureAudioMode();

  try {
    // MUHIM: fayl nomida bo'sh joy bo'lmasligi kerak — Metro/Expo Asset
    // server bu fayllarni URL orqali so'raydi, va bo'sh joy URL'da
    // "Illegal character in query" xatosini keltirib chiqaradi
    // (Development Build'da bu qattiq tekshiriladi). Shuning uchun
    // assets/sounds/ ichidagi fayllar pastki chiziq bilan nomlangan
    // bo'lishi kerak: asosiy_ovoz.mp3, ikkinchi_ovoz.mp3
    const { sound: s1 } = await Audio.Sound.createAsync(
      require('../../assets/sounds/asosiy_ovoz.mp3'),
      { volume: 1.0 }
    );
    orderSound = s1;
    console.log('Asosiy ovoz yuklandi');
  } catch (error) {
    console.warn('Asosiy ovozni yuklashda xato:', error);
  }

  try {
    const { sound: s2 } = await Audio.Sound.createAsync(
      require('../../assets/sounds/ikkinchi_ovoz.mp3'),
      { volume: 1.0 }
    );
    poolSound = s2;
    console.log('Ikkinchi ovoz yuklandi');
  } catch (error) {
    console.warn('Ikkinchi ovozni yuklashda xato:', error);
  }

  try {
    const { sound: s3 } = await Audio.Sound.createAsync(
      require('../../assets/sounds/safarni_boshlash.wav'),
      { volume: 1.0 }
    );
    tripStartSound = s3;
    console.log('Safarni boshlash ovozi yuklandi');
  } catch (error) {
    console.warn('Safarni boshlash ovozini yuklashda xato:', error);
  }

  try {
    const { sound: s4 } = await Audio.Sound.createAsync(
      require('../../assets/sounds/safarni_yakunlash.wav'),
      { volume: 1.0 }
    );
    tripEndSound = s4;
    console.log('Safarni yakunlash ovozi yuklandi');
  } catch (error) {
    console.warn('Safarni yakunlash ovozini yuklashda xato:', error);
  }
}

export async function notifyNewOrder() {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  try {
    if (orderSound) {
      await orderSound.setPositionAsync(0);
      await orderSound.playAsync();
    } else {
      console.warn('orderSound hali yuklanmagan');
    }
  } catch (error) {
    console.warn('Ovoz chalishda xato:', error);
  }
}

export async function notifyPoolOrder() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  try {
    if (poolSound) {
      await poolSound.setPositionAsync(0);
      await poolSound.playAsync();
    } else {
      console.warn('poolSound hali yuklanmagan');
    }
  } catch (error) {
    console.warn('Ovoz chalishda xato:', error);
  }
}

// "Safarni boshlash" bosilganda — xavfsizlik kamari eslatmasi
export async function notifyTripStart() {
  try {
    if (tripStartSound) {
      await tripStartSound.setPositionAsync(0);
      await tripStartSound.playAsync();
    } else {
      console.warn('tripStartSound hali yuklanmagan');
    }
  } catch (error) {
    console.warn('Ovoz chalishda xato:', error);
  }
}

// "Safarni yakunlash" bosilganda — xayrlashuv xabari
export async function notifyTripEnd() {
  try {
    if (tripEndSound) {
      await tripEndSound.setPositionAsync(0);
      await tripEndSound.playAsync();
    } else {
      console.warn('tripEndSound hali yuklanmagan');
    }
  } catch (error) {
    console.warn('Ovoz chalishda xato:', error);
  }
}

export async function unloadSounds() {
  await orderSound?.unloadAsync();
  await poolSound?.unloadAsync();
  await tripStartSound?.unloadAsync();
  await tripEndSound?.unloadAsync();
}