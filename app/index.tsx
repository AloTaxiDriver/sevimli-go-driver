// app/index.tsx
import { Redirect } from 'expo-router';
import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../src/context/AuthContext';
import LoginScreen from '../src/screens/LoginScreen';
import { COLORS } from '../src/theme/colors';

export default function Index() {
  const { isLoggedIn, bootstrapping } = useAuth();

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg }}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen />;
  }

  return <Redirect href="/(tabs)" />;
}