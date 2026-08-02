// src/context/AuthContext.tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';

export type Driver = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  password: string;
  branch: string;
  carBrand: string;
  carModel: string;
  color: string;
  plateRegion: string;
  plateBody: string;
  rating: number;
  balance: number;
  photo: string | null;
};

type AuthContextType = {
  driver: Driver | null;
  isLoggedIn: boolean;
  error: string;
  loading: boolean;
  bootstrapping: boolean;
  login: (phone: string, password: string) => Promise<boolean>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

// Qurilmada saqlanadigan kalit — faqat telefon raqami saqlanadi (PAROL
// EMAS), ilova qayta ochilganda shu raqam orqali Firestore'dan
// haydovchi qayta yuklanadi (parolsiz).
const SAVED_PHONE_KEY = 'oilaTaxiDriver_savedPhone';

function mapFirestoreDriver(phone: string, data: Record<string, any>): Driver {
  return {
    id: phone,
    firstName: data.firstName || '',
    lastName: data.lastName || '',
    phone,
    password: data.password || '',
    branch: data.branch || '',
    carBrand: data.carBrand || '',
    carModel: data.carModel || '',
    color: data.carColor || '',
    plateRegion: data.plateRegion || '',
    plateBody: data.plateBody || '',
    rating: typeof data.rating === 'number' ? data.rating : 5,
    balance: typeof data.balance === 'number' ? data.balance : 0,
    photo: data.photo || null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [driver, setDriver] = useState<Driver | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Ilova ochilganda, saqlangan sessiya bor-yo'qligini tekshirib
  // bo'lgunimizcha true — shu vaqt ichida Login ekrani "chaqnab"
  // ko'rinib ketmasligi uchun app/index.tsx shu holatni kuzatadi.
  const [bootstrapping, setBootstrapping] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const savedPhone = await AsyncStorage.getItem(SAVED_PHONE_KEY);
        console.log('[AUTH] Saqlangan telefon:', savedPhone);
        if (savedPhone) {
          const doc = await firestore().collection('drivers').doc(savedPhone).get();
          const data = doc.data();
          if (doc.exists() && data) {
            setDriver(mapFirestoreDriver(savedPhone, data));
            console.log('[AUTH] Sessiya tiklandi:', savedPhone);
          } else {
            await AsyncStorage.removeItem(SAVED_PHONE_KEY);
            console.log('[AUTH] Haydovchi Firestore\'da topilmadi, sessiya tozalandi');
          }
        }
      } catch (e) {
        console.warn('[AUTH] Sessiyani tiklashda xato:', e);
      } finally {
        setBootstrapping(false);
      }
    })();
  }, []);

  // MUHIM: bu funksiya Firestore'dan haydovchini qidiradi. Hujjat
  // ID'si sifatida TELEFON RAQAMI ishlatiladi.
  //
  // XAVFSIZLIK HAQIDA ESLATMA: hozircha parol Firestore'da oddiy matn
  // holida saqlanadi va tekshiriladi (demo darajasi uchun amaliy, lekin
  // productionda to'liq xavfsiz emas).
  async function login(phone: string, password: string): Promise<boolean> {
    setError('');
    setLoading(true);
    try {
      const doc = await firestore().collection('drivers').doc(phone).get();
      const data = doc.data();

      if (!doc.exists() || !data) {
        setError('Bu raqam bilan haydovchi topilmadi');
        return false;
      }
      if (!data.password || data.password !== password) {
        setError("Parol noto'g'ri");
        return false;
      }
      // MUHIM: faqat ANIQ `approved:false` bo'lgan hisoblar (o'zi
      // ro'yxatdan o'tib, hali moderatsiyadan o'tmagan) bloklanadi.
      // Dashboard'dan qo'lda qo'shilgan eski haydovchilarda bu maydon
      // umuman yo'q — ular bilan hech narsa o'zgarmaydi.
      if (data.approved === false) {
        setError("Hisobingiz hali moderatsiyada. Administrator tasdiqlashini kuting.");
        return false;
      }

      setDriver(mapFirestoreDriver(phone, data));
      await AsyncStorage.setItem(SAVED_PHONE_KEY, phone);
      console.log('[AUTH] Login muvaffaqiyatli, sessiya saqlandi:', phone);
      return true;
    } catch (e) {
      console.warn('[AUTH] Login xato:', e);
      setError('Ulanishda xato yuz berdi. Internetni tekshiring.');
      return false;
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    setDriver(null);
    AsyncStorage.removeItem(SAVED_PHONE_KEY).catch(() => {});
  }

  const value: AuthContextType = {
    driver,
    isLoggedIn: !!driver,
    error,
    loading,
    bootstrapping,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth AuthProvider ichida ishlatilishi kerak');
  return ctx;
}