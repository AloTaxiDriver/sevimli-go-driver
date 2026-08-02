// src/screens/RegisterScreen.tsx
import firestore from '@react-native-firebase/firestore';
import React, { useState } from 'react';
import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import GlassPanel from '../components/GlassPanel';
import { COLORS } from '../theme/colors';

interface Props {
  onBack: () => void;
  onSubmitted: () => void;
}

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

// MUHIM: haydovchi o'zi ro'yxatdan o'tganda hujjat DARHOL faol
// bo'lmaydi — `approved:false` bilan yoziladi. AuthContext.tsx'dagi
// login() shu maydonni tekshiradi va faqat admin dashboard'dan
// "Tasdiqlash" bosgandan keyin (approved:true) kirish ochiladi.
// Dashboard tomonidan qo'lda qo'shilgan eski haydovchilarda bu maydon
// umuman yo'q — ular bilan solishtirilganda hech narsa o'zgarmaydi
// (login() ularni hamon avvalgidek kiritaveradi).
export default function RegisterScreen({ onBack, onSubmitted }: Props) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [rawDigits, setRawDigits] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [carBrand, setCarBrand] = useState('');
  const [carModel, setCarModel] = useState('');
  const [carColor, setCarColor] = useState('');
  const [plate, setPlate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const fullPhone = '+998' + rawDigits;
  const phoneIsValid = rawDigits.length === 9;
  const isValid =
    firstName.trim() &&
    lastName.trim() &&
    phoneIsValid &&
    password.length >= 4 &&
    password === passwordConfirm &&
    carBrand.trim() &&
    carModel.trim() &&
    plate.trim();

  async function handleSubmit() {
    if (submitting) return;
    setError('');
    if (!firstName.trim() || !lastName.trim()) {
      setError('Ism va familiyangizni kiriting');
      return;
    }
    if (!phoneIsValid) {
      setError('Telefon raqamini toʻliq kiriting');
      return;
    }
    if (password.length < 4) {
      setError('Parol kamida 4 ta belgidan iborat boʻlishi kerak');
      return;
    }
    if (password !== passwordConfirm) {
      setError('Parollar bir xil emas');
      return;
    }
    if (!carBrand.trim() || !carModel.trim() || !plate.trim()) {
      setError('Avtomobil maʼlumotlarini toʻliq kiriting');
      return;
    }

    setSubmitting(true);
    try {
      const ref = firestore().collection('drivers').doc(fullPhone);
      const existing = await ref.get();
      if (existing.exists()) {
        setError('Bu raqam bilan haydovchi allaqachon roʻyxatdan oʻtgan');
        setSubmitting(false);
        return;
      }
      await ref.set({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        name: `${firstName.trim()} ${lastName.trim()}`,
        phone: fullPhone,
        password,
        carBrand: carBrand.trim(),
        carModel: carModel.trim(),
        carColor: carColor.trim(),
        car: `${carBrand.trim()} ${carModel.trim()}`,
        plate: plate.trim(),
        status: 'offline',
        approved: false,
        rating: 5.0,
        trips: 0,
        balance: 0,
        selfRegistered: true,
        joined: new Date().toISOString().slice(0, 10),
      });
      Alert.alert(
        'Roʻyxatdan oʻtish yuborildi',
        'Maʼlumotlaringiz moderatsiyaga yuborildi. Administrator tasdiqlagach, ilovaga kira olasiz.',
        [{ text: 'Tushunarli', onPress: onSubmitted }]
      );
    } catch (e) {
      console.warn('[REGISTER] Xato:', e);
      setError('Ulanishda xato yuz berdi. Internetni tekshiring.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.bg}>
      <View style={styles.ornamentTopRight} />
      <View style={styles.ornamentBottomLeft} />

      <SafeAreaView style={styles.safe}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.content}>
            <TouchableOpacity onPress={onBack} style={styles.backButton}>
              <Text style={styles.backButtonText}>{'< Orqaga'}</Text>
            </TouchableOpacity>

            <GlassPanel intensity={40} style={styles.glassCard}>
              <Text style={styles.title}>Roʻyxatdan oʻtish</Text>
              <Text style={styles.subtitle}>
                Maʼlumotlaringiz administratorga tekshirish uchun yuboriladi
              </Text>

              <Text style={styles.sectionLabel}>Shaxsiy maʼlumot</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder="Ism"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={lastName}
                  onChangeText={setLastName}
                  placeholder="Familiya"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
              </View>

              <Text style={styles.label}>Telefon raqamingiz</Text>
              <View style={styles.phoneRow}>
                <Text style={styles.prefix}>+998</Text>
                <TextInput
                  style={styles.phoneInput}
                  value={formatPhone(rawDigits)}
                  onChangeText={(t) => setRawDigits(onlyDigits(t))}
                  keyboardType="number-pad"
                  placeholder="(90) 123-45-67"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
              </View>

              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                placeholder="Parol"
                placeholderTextColor="rgba(22,24,29,0.3)"
              />
              <TextInput
                style={styles.input}
                value={passwordConfirm}
                onChangeText={setPasswordConfirm}
                secureTextEntry
                placeholder="Parolni tasdiqlang"
                placeholderTextColor="rgba(22,24,29,0.3)"
              />

              <Text style={styles.sectionLabel}>Avtomobil</Text>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={carBrand}
                  onChangeText={setCarBrand}
                  placeholder="Markasi (Chevrolet)"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={carModel}
                  onChangeText={setCarModel}
                  placeholder="Modeli (Cobalt)"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
              </View>
              <View style={styles.row}>
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={carColor}
                  onChangeText={setCarColor}
                  placeholder="Rangi (ixtiyoriy)"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                />
                <TextInput
                  style={[styles.input, styles.rowInput]}
                  value={plate}
                  onChangeText={setPlate}
                  placeholder="Davlat raqami"
                  placeholderTextColor="rgba(22,24,29,0.3)"
                  autoCapitalize="characters"
                />
              </View>

              {!!error && <Text style={styles.errorText}>{error}</Text>}

              <TouchableOpacity
                style={[styles.button, (!isValid || submitting) && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={!isValid || submitting}
              >
                <Text style={styles.buttonText}>
                  {submitting ? 'Yuborilmoqda...' : 'Roʻyxatdan oʻtkazish'}
                </Text>
              </TouchableOpacity>
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
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 50, justifyContent: 'flex-start' },

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

  backButton: { marginBottom: 16 },
  backButtonText: { color: 'rgba(22,24,29,0.5)', fontSize: 13, fontWeight: '700' },

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

  title: { fontSize: 24, fontWeight: '800', color: COLORS.dark },
  subtitle: { fontSize: 13, color: 'rgba(22,24,29,0.5)', marginTop: 6, marginBottom: 20 },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: COLORS.primary,
    marginTop: 10,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  label: { fontSize: 13, color: 'rgba(22,24,29,0.6)', marginBottom: 8, fontWeight: '700' },
  row: { flexDirection: 'row', gap: 10 },
  rowInput: { flex: 1 },
  phoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(22,24,29,0.15)',
    paddingBottom: 10,
    marginBottom: 14,
  },
  prefix: { fontSize: 18, fontWeight: '700', color: COLORS.dark, marginRight: 6 },
  phoneInput: { fontSize: 18, fontWeight: '700', color: COLORS.dark, flex: 1 },
  input: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.dark,
    borderBottomWidth: 1.5,
    borderBottomColor: 'rgba(22,24,29,0.15)',
    paddingVertical: 10,
    marginBottom: 14,
  },
  errorText: { color: COLORS.danger, fontSize: 13, marginTop: 4, marginBottom: 8, fontWeight: '700' },
  button: {
    backgroundColor: COLORS.primary,
    borderRadius: 16,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: 10,
    overflow: 'hidden',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  buttonDisabled: { backgroundColor: '#BBF7D0', shadowOpacity: 0 },
  buttonText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
});
