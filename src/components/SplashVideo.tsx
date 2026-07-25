// src/components/SplashVideo.tsx
//
// Ilova ochilganda bir marta ko'rsatiladigan video splash ekran.
// Video to'liq ekranni qoplaydi, ustida hech qanday matn/logotip yo'q.
// Video tugagandan keyin (yoki agar uzoq davom etsa, xavfsizlik
// chegarasi sifatida 6 soniyadan keyin) onFinish() chaqiriladi,
// bu orqali tashqi komponent (_layout.tsx) asosiy ilovaga o'tadi.

import { ResizeMode, Video } from 'expo-av';
import React, { useRef } from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';

type Props = {
  onFinish: () => void;
};

// Video kutilmaganda juda uzoq davom etsa yoki "didJustFinish"
// hodisasi ishlamasa, splash ekran abadiy turib qolmasligi uchun
// xavfsizlik chegarasi (fallback timer)
const MAX_SPLASH_MS = 6000;

export default function SplashVideo({ onFinish }: Props) {
  const finishedRef = useRef(false);

  function finishOnce() {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish();
  }

  React.useEffect(() => {
    const timer = setTimeout(finishOnce, MAX_SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      <Video
        source={require('../../assets/videos/splash_football.mp4')}
        style={styles.video}
        resizeMode={ResizeMode.CONTAIN}
        shouldPlay
        isLooping={false}
        isMuted
        onPlaybackStatusUpdate={(status) => {
  console.log('Video status:', JSON.stringify(status));
  if (status.isLoaded && status.didJustFinish) {
    finishOnce();
  }
}}
        onError={(error) => {
          console.warn('Splash video xatosi:', error);
          finishOnce();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  video: {
    flex: 1,
    width: '100%',
    height: '100%',
  },
});