// src/screens/LoginScreen.tsx
import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import GlassPanel from '../components/GlassPanel';
import { useAuth } from '../context/AuthContext';
import { COLORS } from '../theme/colors';

function onlyDigits(text: string) {
  return text.replace(/\D/g, '').slice(0, 9);
}

function formatPhone(d: string) {
  let out = '';
  if (d.length > 0) out += '(' + d.slice(0, 2);
  if (d.length >= 2) out += ')';
  if (d.length > 2) out += ' ' + d.slice(2, 5);
  if (d.length > 5) out += '-' + d.slice(5, 7);
  if (d.length > 7) out += '-' + d.slice(7, 9);
  return out;
}

export default function LoginScreen() {
  const { login, error, loading } = useAuth();
  const [rawDigits, setRawDigits] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'phone' | 'password'>('phone');
  const [localError, setLocalError] = useState('');

  const fullPhone = '+998' + rawDigits;
  const phoneIsValid = rawDigits.length === 9;

  function handlePhoneChange(text: string) {
    setRawDigits(onlyDigits(text));
    setLocalError('');
  }

  function handleContinue() {
    if (!phoneIsValid) {
      setLocalError('Telefon raqamini to\u02bbliq kiriting');
      return;
    }
    setLocalError('');
    setStep('password');
  }

  // MUHIM: login() endi Firestore'ga murojaat qilgani uchun asinxron
  // (Promise qaytaradi) — shuning uchun bu funksiya ham async qilindi.
  async function handleLogin() {
    if (!password) {
      setLocalError('Parolni kiriting');
      return;
    }
    await login(fullPhone, password);
  }

  return (
    <View style={styles.bg}>
      {/* Bezak doiralar (ornament) — fon ustida coral rangda */}
      <View style={styles.ornamentTopRight} />
      <View style={styles.ornamentBottomLeft} />
      <View style={styles.ornamentSmall} />

      <SafeAreaView style={styles.safe}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.content}>
            <View style={styles.logoRow}>
              <View style={styles.logoIcon}>
                <Text style={styles.logoIconText}>Z</Text>
              </View>
              <View>
                <Text style={styles.logoName}>Zuvzuv Taxi</Text>
                <Text style={styles.logoSub}>HAYDOVCHI</Text>
              </View>
            </View>

            <GlassPanel intensity={40} style={styles.glassCard}>
              <Text style={styles.title}>
                {step === 'phone' ? 'Kirish' : 'Parolni kiriting'}
              </Text>

              {step === 'phone' ? (
                <>
                  <Text style={styles.label}>Telefon raqamingiz</Text>
                  <View style={styles.phoneRow}>
                    <Text style={styles.prefix}>+998</Text>
                    <TextInput
                      style={styles.phoneInput}
                      value={formatPhone(rawDigits)}
                      onChangeText={handlePhoneChange}
                      keyboardType="number-pad"
                      placeholder="(90) 123-45-67"
                      placeholderTextColor="rgba(22,24,29,0.3)"
                      autoFocus
                    />
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.label}>{fullPhone}</Text>
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={(t) => {
                      setPassword(t);
                      setLocalError('');
                    }}
                    secureTextEntry
                    placeholder="Parol"
                    placeholderTextColor="rgba(22,24,29,0.3)"
                    autoFocus
                  />
                </>
              )}

              {(localError || error) ? (
                <Text style={styles.errorText}>{localError || error}</Text>
              ) : null}

              <TouchableOpacity
                style={[
                  styles.button,
                  step === 'phone' && !phoneIsValid && styles.buttonDisabled,
                  step === 'password' && loading && styles.buttonDisabled,
                ]}
                onPress={step === 'phone' ? handleContinue : handleLogin}
                disabled={(step === 'phone' && !phoneIsValid) || (step === 'password' && loading)}
              >
                <Text style={styles.buttonText}>
                  {step === 'phone' ? 'Davom etish' : loading ? 'Kirilmoqda...' : 'Kirish'}
                </Text>
              </TouchableOpacity>

              {step === 'password' && (
                <TouchableOpacity onPress={() => setStep('phone')} style={styles.backLink}>
                  <Text style={styles.backLinkText}>{'< Raqamni o\u02bbzgartirish'}</Text>
                </TouchableOpacity>
              )}
            </GlassPanel>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: COLORS.bg, overflow: 'hidden' },
  safe: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingBottom: 40 },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 70, justifyContent: 'flex-start' },

  // Bezak (ornament) doiralar — fon ustida, juda och coral
  ornamentTopRight: {
    position: 'absolute',
    top: -80,
    right: -60,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: COLORS.primaryLight,
  },
  ornamentBottomLeft: {
    position: 'absolute',
    bottom: -100,
    left: -80,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: COLORS.primaryLight,
  },
  ornamentSmall: {
    position: 'absolute',
    top: '38%',
    right: -30,
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(255,90,44,0.08)',
  },

  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 36 },
  logoIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: COLORS.primary,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 10,
    elevation: 6,
  },
  logoIconText: { color: COLORS.white, fontWeight: '800', fontSize: 20 },
  logoName: { fontWeight: '800', fontSize: 20, color: COLORS.dark },
  logoSub: { fontWeight: '700', fontSize: 11, color: COLORS.primary, letterSpacing: 1 },

  glassCard: {
    borderRadius: 28,
    padding: 26,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 6,
  },

  title: { fontSize: 26, fontWeight: '800', color: COLORS.dark, marginBottom: 24 },
  label: { fontSize: 13, color: 'rgba(22,24,29,0.6)', marginBottom: 8, fontWeight: '700' },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(22,24,29,0.15)',
    paddingBottom: 10,
  },
  prefix: { fontSize: 20, fontWeight: '700', color: COLORS.dark, marginRight: 6 },
  phoneInput: { fontSize: 20, fontWeight: '700', color: COLORS.dark, flex: 1 },
  input: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.dark,
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(22,24,29,0.15)',
    paddingVertical: 10,
    marginBottom: 8,
  },
  errorText: { color: COLORS.danger, fontSize: 13, marginTop: 8, fontWeight: '700' },
  button: {
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 28,
    overflow: 'hidden',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  // To'liq qattiq, lekin ochroq/kamroq to'yingan rang — "o'chirilgan"
  // holatni bildiradi, shaffoflik ishlatilmaydi (orqadagi kartaning
  // foni bilan qo'shilib ikki qatlamli ko'rinish hosil bo'lmasligi uchun)
  buttonDisabled: { backgroundColor: '#FFC4AC', shadowOpacity: 0 },
  buttonText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
  backLink: { marginTop: 18, alignItems: 'center' },
  backLinkText: { color: 'rgba(22,24,29,0.5)', fontSize: 13, fontWeight: '700' },
});