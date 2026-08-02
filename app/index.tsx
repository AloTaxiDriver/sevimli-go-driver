// app/index.tsx
import { Redirect } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../src/context/AuthContext';
import LoginScreen from '../src/screens/LoginScreen';
import RegisterScreen from '../src/screens/RegisterScreen';
import { COLORS } from '../src/theme/colors';

export default function Index() {
  const { isLoggedIn, bootstrapping } = useAuth();
  const [showRegister, setShowRegister] = useState(false);

  if (bootstrapping) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg }}>
        <ActivityIndicator size="large" color={COLORS.primary} />
      </View>
    );
  }

  if (!isLoggedIn) {
    return showRegister ? (
      <RegisterScreen onBack={() => setShowRegister(false)} onSubmitted={() => setShowRegister(false)} />
    ) : (
      <LoginScreen onRegister={() => setShowRegister(true)} />
    );
  }

  return <Redirect href="/(tabs)" />;
}