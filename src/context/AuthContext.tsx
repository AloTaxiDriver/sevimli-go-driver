// src/context/AuthContext.tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import React, { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import { releaseDriverOnLogout } from '../utils/firebase';
import { stopDriverLocationTracking } from '../utils/locationTask';
import { SAVED_PHONE_KEY } from '../utils/sessionKeys';

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
//
// MUHIM: kalitning o'zi endi `src/utils/sessionKeys.ts` da — uni fon
// rejimidagi joylashuv vazifasi ham o'qiydi (joylashuvni kimga
// yozishini tekshirish uchun). Ikki joyda ikkita nusxa bo'lsa, ular
// bir-biridan sezilmasdan ajralib ketishi mumkin edi.

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
      let sessionRestored = false;
      try {
        const savedPhone = await AsyncStorage.getItem(SAVED_PHONE_KEY);
        console.log('[AUTH] Saqlangan telefon:', savedPhone);
        if (savedPhone) {
          const doc = await firestore().collection('drivers').doc(savedPhone).get();
          const data = doc.data();
          if (doc.exists() && data) {
            setDriver(mapFirestoreDriver(savedPhone, data));
            sessionRestored = true;
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
      // Sessiya yo'q — demak hech kim onlayn bo'la olmaydi. Oldingi
      // ishga tushishdan qolib ketgan foreground service bo'lsa (ilova
      // onlayn holatda o'ldirilgan bo'lishi mumkin — xizmat ATAYLAB
      // ilovadan omon qoladi) uni shu yerda to'xtatamiz. MapScreen
      // ichidagi bir xil himoya faqat haydovchi tizimga kirgan holatni
      // qamrab oladi, bu esa chiqib ketgan holatni.
      if (!sessionRestored) {
        stopDriverLocationTracking();
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

      // MUHIM: yangi sessiyani ochishdan OLDIN oldingi haydovchidan
      // qolgan kuzatuvni to'xtatamiz. Ilova onlayn holatda o'ldirilgan
      // bo'lsa, foreground service tirik qolishi mumkin (u ATAYLAB
      // shunday) va u ESKI haydovchining ID'si bilan yozishda davom
      // etardi — shu telefonda boshqa haydovchi ishlay boshlasa,
      // joylashuv baribir eskisining hujjatiga tushardi.
      await stopDriverLocationTracking();

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

  // MUHIM: avval balans FAQAT login/sessiya-tiklash paytida bir marta
  // o'qilardi — har safar safar tugab komissiya yechilganda bu React
  // state'da ko'rinmasdi (chiqib-kirmaguncha eski qiymat qolardi), va
  // MapScreen'dagi "balans <=0 bo'lsa buyurtma qabul qilishni taqiqlash"
  // tekshiruvi ham shu eski qiymatga ishonardi. Endi sessiya davomida
  // haydovchi hujjatini jonli tinglaymiz, shunda balans (va boshqa
  // maydonlar) doim yangi.
  useEffect(() => {
    if (!driver?.id) return;
    const unsubscribe = firestore()
      .collection('drivers')
      .doc(driver.id)
      .onSnapshot(
        (doc) => {
          const data = doc.data();
          if (doc.exists() && data) {
            setDriver((prev) => (prev ? mapFirestoreDriver(prev.id, data) : prev));
          }
        },
        (error) => console.warn('[AUTH] Haydovchi hujjatini tinglashda xato:', error)
      );
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver?.id]);

  function logout() {
    // MUHIM: ID ni `setDriver(null)` dan OLDIN olamiz — keyin kech
    // bo'ladi.
    const leavingDriverId = driver?.id;
    setDriver(null);
    AsyncStorage.removeItem(SAVED_PHONE_KEY).catch(() => {});
    // Firestore'dagi ish holati ham bo'shatiladi: `isOnline: false`,
    // push tokeni o'chiriladi va (tugallanmagan safar bo'lmasa) "band"
    // bayrog'i tozalanadi. Avval bunga umuman tegilmasdi — chiqib
    // ketgan haydovchi panelda onlayn ko'rinib turar, buyurtma
    // taqsimlash unga navbat berib javob kutar, telefoniga esa yangi
    // buyurtma bildirishnomalari kelaverardi.
    if (leavingDriverId) {
      releaseDriverOnLogout(leavingDriverId).catch((e) =>
        console.warn('[AUTH] Chiqishda holatni bo\'shatishda xato:', e)
      );
    }
    // Fon rejimidagi joylashuv kuzatuvi va uning doimiy bildirishnomasi
    // ham to'xtashi shart. Avval bu MapScreen'ning unmount cleanup'iga
    // tayanardi — lekin u faqat ekran haqiqatan montaj qilingan VA
    // effektning onlayn shoxi ishlagan bo'lsa bajariladi. Chiqish esa
    // istalgan holatdan bo'lishi mumkin, shuning uchun bu yerda aniq
    // chaqiriladi. Kuzatuv ishlamayotgan bo'lsa, funksiya hech narsa
    // qilmaydi.
    stopDriverLocationTracking();
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