// src/MapScreen.tsx
import { Ionicons } from '@expo/vector-icons';
import notifee from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, DeviceEventEmitter, Dimensions, FlatList,
  Image,
  Modal,
  PanResponder,
  Linking as RNLinking,
  SafeAreaView, StyleSheet, Text, TextInput, TouchableOpacity, View
} from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BackgroundLocationDisclosure from './components/BackgroundLocationDisclosure';
import CancelOrderModal from './components/CancelOrderModal';
import GlassPanel from './components/GlassPanel';
import OrderCard from './components/OrderCard';
import PoolOrderItem from './components/PoolOrderItem';
import TripCard from './components/TripCard';
import WaitingCard from './components/WaitingCard';
import { useAuth } from './context/AuthContext';
import { MOCK_HEAT_POINTS, getHeatColor } from './data/heatmapData';
import { Order } from './data/mockOrders';
import { COLORS } from './theme/colors';
import { estimateDurationMin, getDistanceKm } from './utils/distance';
import {
  ACTIVE_ORDER_STATUSES,
  DispatcherNotification, FirestoreOrder, OrderAlreadyTakenError, acceptOrder, cancelOrder, computeTieredDistanceSurcharge, ensureOverlayPermission, fetchActiveOrderForDriver, fetchOrderById, finalizeOrderPrice, firestoreOrderToOrder,
  listenToDriverNotifications, listenToForegroundMessages, listenToOrderCancellation, listenToPoolOrders, registerForPushNotifications,
  revertOrderAcceptance, saveDriverPushToken, setDriverBusyStatus, startBordurTrip,
  updateOrderStatus
} from './utils/firebase';
import {
  getBackgroundLocationConsent,
  setBackgroundLocationConsent,
} from './utils/backgroundLocationConsent';
import { startDriverLocationTracking, stopDriverLocationTracking } from './utils/locationTask';
import { notifyTripEnd, notifyTripStart, preloadSounds, unloadSounds } from './utils/notifications';
import { getRoute } from './utils/routing';

const SCREEN_WIDTH = Dimensions.get('window').width;
const TRACK_PADDING = 20;
const TRACK_WIDTH = SCREEN_WIDTH - TRACK_PADDING * 2;
const KNOB_SIZE = 68;
const SWIPE_THRESHOLD = TRACK_WIDTH - KNOB_SIZE - 14;
const TAB_BAR_HEIGHT = 64;
const SIDE_BTN_SIZE = 56;

// "Boshlash" slayderi uchun (ready_to_start bosqichi) — bu karta
// endi boshqa kartalar (OrderCard, TripCard, WaitingCard) kabi
// to'liq kenglikda, faqat padding(20) bilan chiziladi (margin YO'Q).
const READY_CARD_PADDING = 20;
const START_TRACK_WIDTH = SCREEN_WIDTH - READY_CARD_PADDING * 2;
const START_KNOB_SIZE = 54;
const START_SWIPE_THRESHOLD = START_TRACK_WIDTH - START_KNOB_SIZE - 10;

type TripStage = 'ready_to_start' | 'to_pickup' | 'waiting' | 'in_progress' | null;
type Coords = { latitude: number; longitude: number };
type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

// Faol safar qurilmada saqlanadigan "snapshot" — ilova to'satdan
// yopilsa/qulab tushsa, qayta ochilganda safar aynan shu joydan davom
// etadi. Firestore buyurtma HOLATINI (accepted/arrived/in_progress)
// biladi, lekin faqat ilovada yashaydigan narsalarni — "Boshlash"
// surilganmi (ready_to_start / to_pickup), ikki manzilli buyurtmada
// qaysi oyoqdaligi va eng muhimi BOSIB O'TILGAN MASOFA — bilmaydi.
// Shu sabab ikkalasi birga ishlatiladi: Firestore — haqiqat manbasi,
// bu snapshot — uning ustidagi mahalliy tafsilotlar.
type ActiveTripSnapshot = {
  orderId: string;
  tripStage: Exclude<TripStage, null>;
  activeLeg: 1 | 2;
  tripDistanceKm: number;
  /** Snapshot qachon yozilgani. Ilova yopiq turgan vaqtda dispetcher
   * buyurtmani orqaga qaytargan bo'lishi mumkin — juda eski snapshot
   * o'sha o'zgarishni bosib ketmasligi uchun kerak. */
  savedAt?: number;
};

function activeTripStorageKey(driverId: string) {
  return `active_trip_${driverId}`;
}

// Safar bosqichlari qat'iy TARTIBDA boradi. Tiklashda ikki manba
// (Firestore va quridagi snapshot) qaysi biri OLDINDA ekanini shu
// tartibga qarab solishtiramiz.
const TRIP_STAGE_ORDER: Exclude<TripStage, null>[] = [
  'ready_to_start',
  'to_pickup',
  'waiting',
  'in_progress',
];
function tripStageRank(stage: Exclude<TripStage, null>): number {
  return TRIP_STAGE_ORDER.indexOf(stage);
}

// Firestore buyurtma holatidan mahalliy bosqichni chiqaradi. MUHIM:
// bu FAQAT ENG PAST chegara — `accepted` holatida haydovchi
// "Boshlash"ni surgan-surmagani Firestore'ga umuman yozilmaydi.
function stageFromOrderStatus(status: FirestoreOrder['status']): Exclude<TripStage, null> {
  if (status === 'in_progress') return 'in_progress';
  if (status === 'arrived') return 'waiting';
  return 'ready_to_start';
}

// Snapshot shundan eski bo'lsa, Firestore'ni bosib o'tishga ruxsat
// berilmaydi. Bitta safar 12 soat davom etmaydi.
const TRIP_SNAPSHOT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// Safarni tiklash shu vaqtdan uzoq cho'zilsa, kutish to'xtatiladi.
// `restoringTrip` buyurtma qabul qilishni bloklaydi, shuning uchun u
// abadiy true bo'lib qolsa haydovchi umuman ishlay olmaydi.
const TRIP_RESTORE_TIMEOUT_MS = 20000;

// Xaritada yo'l chizig'i qaysi nuqtagacha chizilishini aniqlaydi.
//
// MUHIM: olib ketish nuqtasiga yo'l HAR DOIM chiziladi — u har qanday
// buyurtmada ma'lum. Avval bu ham `toAddress !== ''` shartiga bog'langan
// edi, ya'ni mijoz manzilni ko'rsatmasdan buyurtma bersa (mijoz ilovasi
// bunday holda `toAddress` maydonini buyurtmaga UMUMAN yozmaydi),
// haydovchiga MIJOZGACHA bo'lgan yo'l ham chizilmasdi — u qayerga
// borishini xaritadan ko'ra olmasdi.
//
// Safar boshlangandan keyin (in_progress) esa manzil haqiqatan kerak:
// u yo'q bo'lsa (bordyur safari yoki manzilsiz buyurtma) chiziladigan
// yakuniy nuqta ham yo'q.
function computeRouteTarget(
  order: Order | null,
  stage: TripStage,
  leg: 1 | 2
): Coords | null {
  if (!order) return null;
  if (stage === 'to_pickup') return order.pickupLocation ?? null;
  if (stage === 'in_progress' && order.toAddress !== '') {
    return leg === 2 && order.dropoff2Location
      ? order.dropoff2Location
      : order.dropoffLocation ?? null;
  }
  return null;
}

export default function MapScreen({ acceptOrderId }: { acceptOrderId?: string }) {
  const insets = useSafeAreaInsets();
  const { driver } = useAuth();
  const driverId = driver?.id || driver?.phone || 'unknown_driver';

  const [location, setLocation] = useState<Coords | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(true);
  const [isOnline, setIsOnline] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [notifications, setNotifications] = useState<DispatcherNotification[]>([]);
  const [notifModalVisible, setNotifModalVisible] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [activeMode, setActiveMode] = useState<'home' | 'work' | 'nearby' | null>(null);
  const [savedLocations, setSavedLocations] = useState<{
    home?: { lat: number; lng: number; address?: string };
    work?: { lat: number; lng: number; address?: string };
  }>({});
  const [locationSettingsVisible, setLocationSettingsVisible] = useState(false);
  const [bgLocationDisclosureVisible, setBgLocationDisclosureVisible] = useState(false);
  const lastSeenNotifAtRef = useRef(0);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [tripStage, setTripStage] = useState<TripStage>(null);
  // Ikkinchi manzilli (multi-stop) buyurtmalarda qaysi "oyoq"da
  // ekanligini bildiradi — 1: A dan 1-manzilgacha, 2: 1-manzildan
  // 2-manzilgacha. Ikkinchi manzili yo'q buyurtmalarda hech qachon
  // 2ga o'zgarmaydi.
  const [activeLeg, setActiveLeg] = useState<1 | 2>(1);
  const [currentRegion, setCurrentRegion] = useState<Region | null>(null);
  const [poolVisible, setPoolVisible] = useState(false);
  const [poolOrders, setPoolOrders] = useState<FirestoreOrder[]>([]);
  const [skippedOrderIds, setSkippedOrderIds] = useState<Set<string>>(new Set());
  const [routeCoords, setRouteCoords] = useState<Coords[]>([]);
  const [pendingAcceptId, setPendingAcceptId] = useState<string | null>(acceptOrderId || null);
  // Buyurtmani bekor qilish (sabab tanlash) oynasi ko'rinishini
  // boshqaradi — ready_to_start/to_pickup/waiting bosqichlarida
  // ochiladi
  const [cancelModalVisible, setCancelModalVisible] = useState(false);
  // "Safarni yakunlash" bosilganda darhol yopilmasin — avval xulosa
  // (masofa, narx tafsiloti) ko'rsatiladi
  const [showTripSummary, setShowTripSummary] = useState(false);
  // "Haydash rejimi" uchun: joriy tezlik (km/h) va yo'nalish (heading,
  // 0-360°) — GPS orqali watchPositionAsync ichida yangilanadi
  const [speedKmh, setSpeedKmh] = useState(0);
  const [heading, setHeading] = useState<number | undefined>(undefined);
  // Safar (in_progress) davomida bosib o'tilgan haqiqiy masofa — narxni
  // jonli hisoblash uchun. tripStageRef watchPositionAsync ichidagi
  // "qotib qolgan" closure muammosini oldini olish uchun kerak (u
  // effekt faqat bir marta, bo'sh deps bilan ishga tushadi).
  const [liveTripDistanceKm, setLiveTripDistanceKm] = useState(0);
  const tripStageRef = useRef<TripStage>(null);
  const tripDistanceRef = useRef(0);
  const lastTripPointRef = useRef<Coords | null>(null);
  // Safar holati tiklanguncha (yoki tiklanadigan safar yo'qligi
  // aniqlanguncha) true — shu vaqt ichida yangi buyurtmani qabul qilish
  // effekti kutib turadi, aks holda tiklanayotgan safar ustiga yangi
  // buyurtma tushib qolishi mumkin.
  const [restoringTrip, setRestoringTrip] = useState(true);
  const tripRestoreStartedRef = useRef(false);
  const activeLegRef = useRef<1 | 2>(1);
  const lastTripPersistAtRef = useRef(0);

  const pan = useRef(new Animated.Value(0)).current;
  const startPan = useRef(new Animated.Value(0)).current;
  const mapRef = useRef<MapView>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const activeOrderSourceId = useRef<string | null>(null);
  const processedAcceptId = useRef<string | null>(null);
  // Buyurtma qabul qilingandan keyin, dispetcher uni bekor qilib
  // qo'ysa shundan xabardor bo'lish uchun tinglovchi
  const orderCancelUnsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => {
    preloadSounds();
    return () => { unloadSounds(); };
  }, []);

  // Dispetcher bildirishnomalarini real vaqtda tinglaymiz — ilova
  // ochiq/onlayn holatidan qat'iy nazar, doim ishlaydi.
  useEffect(() => {
    AsyncStorage.getItem(`notif_last_seen_${driverId}`).then((val) => {
      lastSeenNotifAtRef.current = val ? parseInt(val, 10) : 0;
      // Ilk yuklanishda ham "o'qilmagan" sonini to'g'ri hisoblash uchun
      setNotifications((prev) => {
        setUnreadNotifCount(prev.filter((n) => n.createdAtMillis > lastSeenNotifAtRef.current).length);
        return prev;
      });
    });
    const unsubscribe = listenToDriverNotifications(driverId, (items) => {
      setNotifications(items);
      setUnreadNotifCount(items.filter((n) => n.createdAtMillis > lastSeenNotifAtRef.current).length);
    });
    return unsubscribe;
  }, [driverId]);

  useEffect(() => {
    firestore().collection('drivers').doc(driverId).get().then((doc) => {
      const data = doc.data();
      if (!data) return;
      if (data.activeMode) setActiveMode(data.activeMode);
      if (data.savedLocations) setSavedLocations(data.savedLocations);
    }).catch((e) => console.warn('Saqlangan manzillarni olishda xato:', e));
  }, [driverId]);

  useEffect(() => {
    tripStageRef.current = tripStage;
  }, [tripStage]);

  useEffect(() => {
    activeLegRef.current = activeLeg;
  }, [activeLeg]);

  // Joriy safar holatini qurilmaga yozadi. FAQAT ref'lardan o'qiydi,
  // shuning uchun watchPositionAsync ichidagi (bo'sh deps bilan bir
  // marta yaratilgan, ya'ni "qotib qolgan" closure'li) callback'dan ham
  // xavfsiz chaqiriladi — .current har renderda yangilanib turadi.
  const writeTripSnapshot = useRef(() => {});
  writeTripSnapshot.current = () => {
    const orderId = activeOrderSourceId.current;
    const stage = tripStageRef.current;
    if (!orderId || !stage) return;
    const snapshot: ActiveTripSnapshot = {
      orderId,
      tripStage: stage,
      activeLeg: activeLegRef.current,
      tripDistanceKm: tripDistanceRef.current,
      savedAt: Date.now(),
    };
    AsyncStorage.setItem(activeTripStorageKey(driverId), JSON.stringify(snapshot)).catch(() => {});
  };

  function clearTripSnapshot() {
    lastTripPersistAtRef.current = 0;
    AsyncStorage.removeItem(activeTripStorageKey(driverId)).catch(() => {});
  }

  // Safar bosqichi yoki "oyoq"i o'zgargan zahoti snapshotni yangilaymiz.
  useEffect(() => {
    if (!tripStage || !activeOrder) return;
    writeTripSnapshot.current();
  }, [tripStage, activeLeg, activeOrder?.id]);

  // ============================================================
  // SAFARNI TIKLASH — ilova safar o'rtasida yopilgan/qulagan bo'lsa
  // ============================================================
  // Bu effekt ilova ochilganda BIR MARTA ishlaydi. Firestore'da shu
  // haydovchining tugallanmagan buyurtmasi bo'lsa, safar aynan
  // to'xtagan joyidan tiklanadi. Bo'lmasa — haydovchida qolib ketgan
  // "band" bayrog'i tozalanadi.
  //
  // MUHIM: avval bu yerda `location` kelishi KUTILARDI, chunki
  // `firestoreOrderToOrder` haydovchi joylashuvini talab qilardi — u
  // koordinatasi yo'q buyurtmalar uchun shu joylashuv atrofidan
  // tasodifiy nuqta yasab berardi. O'sha "o'ylab topish" olib
  // tashlangach, bog'liqlik ham yo'qoldi: endi safar GPS umuman
  // ishlamasa ham tiklanadi (ichkarida, ruxsat berilmagan telefonda).
  useEffect(() => {
    if (tripRestoreStartedRef.current) return;
    tripRestoreStartedRef.current = true;

    (async () => {
      try {
        let snapshot: ActiveTripSnapshot | null = null;
        try {
          const raw = await AsyncStorage.getItem(activeTripStorageKey(driverId));
          if (raw) snapshot = JSON.parse(raw) as ActiveTripSnapshot;
        } catch {
          snapshot = null;
        }

        // Avval snapshotdagi buyurtmani tekshiramiz (bitta o'qish), u
        // yaroqsiz bo'lsa — Firestore'dan qidiramiz.
        let fo: FirestoreOrder | null = null;
        if (snapshot?.orderId) {
          fo = await fetchOrderById(snapshot.orderId);
          // Snapshot eskirgan bo'lishi mumkin: buyurtma allaqachon
          // yakunlangan/bekor qilingan yoki boshqa haydovchiga o'tgan.
          if (fo && (fo.driverId !== driverId || !ACTIVE_ORDER_STATUSES.includes(fo.status))) {
            fo = null;
          }
        }
        if (!fo) {
          fo = await fetchActiveOrderForDriver(driverId);
          // Boshqa buyurtma topilgan bo'lsa, snapshotdagi mahalliy
          // tafsilotlar (masofa, oyoq) unga tegishli emas.
          if (fo && snapshot && fo.id !== snapshot.orderId) snapshot = null;
        }

        if (!fo) {
          // Tiklanadigan safar yo'q. Ammo haydovchi Firestore'da hamon
          // "band" bo'lib qolgan bo'lishi mumkin (safar yakunlanayotgan
          // paytda ilova qulab tushgan holat) — bu holda unga hech
          // qanday yangi buyurtma kelmay, "o'lik" qolib ketardi.
          //
          // MUHIM: bayroq faqat HAQIQATAN "band" bo'lib qolgan bo'lsa
          // tozalanadi. Har ilova ochilishida so'zsiz yozish
          // `updatedAt`ni ham yangilab yuborardi, dispetcher panelida esa
          // haydovchining joylashuvi "yangi"day ko'rinib qolardi —
          // aslida GPS ma'lumoti eski bo'lsa ham.
          clearTripSnapshot();
          const driverDoc = await firestore()
            .collection('drivers')
            .doc(driverId)
            .get()
            .catch(() => null);
          if (driverDoc?.data()?.busy === true) {
            setDriverBusyStatus(driverId, false).catch(() => {});
            console.log('Osilib qolgan "band" bayrog\'i tozalandi');
          }
          return;
        }

        // ---- Ikki manbani yarashtirish ----
        // Firestore va qurilmadagi snapshot BIR-BIRIDAN ORTDA QOLISHI
        // mumkin, va har ikki yo'nalishda ham:
        //
        //  * Snapshot oldinda: haydovchi "Safarni boshlash"ni surdi,
        //    lekin `updateOrderStatus(...)` yozuvi yetib bormadi
        //    (u ataylab `.catch(console.warn)` bilan, kutilmasdan
        //    chaqiriladi) — aloqa yo'q edi yoki ilova o'sha zahoti
        //    quladi. Firestore hamon `accepted` deb turadi.
        //  * Firestore oldinda: dispetcher panelda buyurtmani o'zi
        //    ilgari surgan.
        //
        // Avval bu yerda FAQAT Firestore holati hisobga olinardi, va
        // snapshotdan bor-yo'g'i `to_pickup` o'qilardi. Ya'ni birinchi
        // holatda haydovchi safar o'rtasida turib boshiga qaytarilardi
        // — eng yomoni, bosib o'tilgan masofa ham tiklanmasdi (u faqat
        // `in_progress` bosqichida tiklanadi), shuning uchun safar
        // oxirida narx eng past tarifga qulab tushardi.
        //
        // Endi ikkalasining OLDINROG'I olinadi.
        const firestoreStage = stageFromOrderStatus(fo.status);
        const snapshotStage =
          snapshot && snapshot.orderId === fo.id ? snapshot.tripStage : null;
        // Juda eski snapshot Firestore'ni bosib o'tmasin.
        const snapshotFresh =
          typeof snapshot?.savedAt === 'number' &&
          Date.now() - snapshot.savedAt < TRIP_SNAPSHOT_MAX_AGE_MS;

        let stage: Exclude<TripStage, null> = firestoreStage;
        if (snapshotStage && tripStageRank(snapshotStage) > tripStageRank(stage)) {
          // `to_pickup` Firestore'da alohida holat sifatida UMUMAN
          // saqlanmaydi (u `accepted` ichida yashaydi), shuning uchun
          // unga ishonish hech qanday ziddiyat tug'dirmaydi — hatto
          // eski, `savedAt`siz snapshotlarda ham (ilova yangilangandan
          // keyingi birinchi tiklash).
          if (snapshotStage === 'to_pickup' || snapshotFresh) {
            stage = snapshotStage;
          }
        }

        activeOrderSourceId.current = fo.id;
        // Aks holda o'sha buyurtma push/overlay orqali qayta "qabul
        // qilinishi" mumkin edi.
        processedAcceptId.current = fo.id;
        startWatchingOrderCancellation(fo.id);
        setActiveOrder(firestoreOrderToOrder(fo));
        setActiveLeg(snapshot?.activeLeg === 2 ? 2 : 1);
        setIsOnline(true);
        setTripStage(stage);
        startPan.setValue(0);

        // Snapshot Firestore'dan oldinda chiqdi — demak holatni yozish
        // urinishi yo'qolgan. Uni QAYTA yozamiz, aks holda ikkala tomon
        // bir-biriga zid bo'lib qolaveradi: haydovchi safarni davom
        // ettiradi, dispetcher panelida esa buyurtma hamon "safar
        // boshlanmagan" bo'lib turadi, va buyurtma tugaganda ham
        // holatlar mos kelmaydi. `to_pickup` uchun yozadigan narsa yo'q
        // — u Firestore'da saqlanmaydi.
        const statusForStage =
          stage === 'in_progress' ? 'in_progress' : stage === 'waiting' ? 'arrived' : null;
        if (statusForStage && statusForStage !== fo.status) {
          console.log(
            `Buyurtma ${fo.id}: holat "${fo.status}" -> "${statusForStage}" qayta yozilmoqda ` +
              '(qurilmadagi holat oldinda edi)'
          );
          updateOrderStatus(fo.id, statusForStage).catch(console.warn);
        }

        if (stage === 'in_progress') {
          // Bosib o'tilgan masofani tiklaymiz — aks holda hisoblagich
          // nolga tushib, safar oxirida narx eng past tarifga qulab
          // qolardi. lastTripPointRef ataylab null: ilova yopiq turgan
          // vaqtdagi harakat baribir o'lchanmagan, hisoblash keyingi
          // GPS nuqtasidan davom etadi.
          const restoredKm =
            typeof snapshot?.tripDistanceKm === 'number' && snapshot.tripDistanceKm > 0
              ? snapshot.tripDistanceKm
              : 0;
          tripDistanceRef.current = restoredKm;
          setLiveTripDistanceKm(restoredKm);
          lastTripPointRef.current = null;
        }

        // Firestore'dagi "band" bayrog'ini har ehtimolga qarshi
        // tasdiqlaymiz (safar bor, demak haydovchi band). Snapshotni bu
        // yerda qayta yozish shart emas — yuqoridagi setTripStage keyingi
        // renderda saqlash effektini o'zi ishga tushiradi.
        setDriverBusyStatus(driverId, true).catch(() => {});
        console.log('Tugallanmagan safar tiklandi:', fo.id, stage);
      } catch (e) {
        console.warn('Safarni tiklashda xato:', e);
      } finally {
        setRestoringTrip(false);
      }
    })();
  }, [driverId]);

  // Tiklash uchun ZAXIRA CHEGARA. Yuqoridagi effektning `finally` bloki
  // faqat xato chiqqanda ishlaydi — javob bermay QOTIB QOLGAN chaqiruvda
  // (tarmoq bor-yo'qday, Firestore o'qishi javobsiz) esa u umuman
  // navbatiga yetmaydi. Effektning o'zi ham `location` kelishini kutadi,
  // GPS esa hech qachon javob bermasligi mumkin.
  //
  // `restoringTrip` buyurtma qabul qilishni to'sadi, ya'ni u true bo'lib
  // qolsa haydovchi ilovani ochiq ushlab tursa ham ishlay olmaydi va
  // buning sababini bilmaydi. Shuning uchun kutish har qanday holatda
  // chegaralanadi.
  useEffect(() => {
    const timer = setTimeout(() => {
      setRestoringTrip((stillRestoring) => {
        if (stillRestoring) {
          console.warn(
            `Safarni tiklash ${TRIP_RESTORE_TIMEOUT_MS / 1000} soniyada tugamadi ` +
              '(GPS yoki tarmoq javob bermadi) — kutish to\'xtatildi'
          );
        }
        return false;
      });
    }, TRIP_RESTORE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    return () => { orderCancelUnsubscribe.current?.(); };
  }, []);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Joylashuvga ruxsat berilmadi');
        setLoading(false);
        // MUHIM: joylashuvsiz safarni tiklab bo'lmaydi (tiklash effekti
        // `location` kelishini kutadi), lekin `restoringTrip` true bo'lib
        // qolsa haydovchi buyurtma ham QABUL QILA OLMAYDI — pastdagi
        // qabul effekti unga qarab to'xtaydi. Avval aynan shunday bo'lardi:
        // ruxsat berilmagan telefonda ilova butunlay ishlamas holga kelardi,
        // hech qanday sabab ko'rsatmasdan.
        setRestoringTrip(false);
        return;
      }

      // MUHIM: `getCurrentPositionAsync` ichkarida yoki GPS "sovuq"
      // bo'lganda o'nlab soniya kutishi, hatto xato berishi mumkin.
      // Avval u try'siz chaqirilardi: xato chiqsa butun blok uzilib,
      // `setLoading(false)` ham bajarilmasdi — ekran "yuklanmoqda"
      // holatida qotib qolardi va safar tiklash ham boshlanmasdi.
      //
      // Endi avval OS keshidagi oxirgi ma'lum nuqta olinadi (u DARHOL
      // qaytadi), so'ng aniqrog'i bilan almashtiriladi.
      let initial: { latitude: number; longitude: number } | null = null;
      try {
        const known = await Location.getLastKnownPositionAsync();
        if (known) initial = { latitude: known.coords.latitude, longitude: known.coords.longitude };
      } catch {
        // Keshda nuqta yo'q — muammo emas, pastda aniqrog'ini olamiz.
      }
      try {
        const current = await Location.getCurrentPositionAsync({});
        initial = { latitude: current.coords.latitude, longitude: current.coords.longitude };
      } catch (e) {
        console.warn('Joriy joylashuvni aniqlab bo\'lmadi:', e);
      }

      if (initial) {
        setLocation(initial);
        setCurrentRegion({ ...initial, latitudeDelta: 0.05, longitudeDelta: 0.05 });
      } else {
        setErrorMsg('Joylashuv aniqlanmadi — GPS yoqilganini tekshiring');
        setRestoringTrip(false);
      }
      setLoading(false);

      locationSubscription.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 10 },
        (update) => {
          const newCoord = { latitude: update.coords.latitude, longitude: update.coords.longitude };
          setLocation(newCoord);
          // speed m/s da keladi, ba'zan noma'lum bo'lsa -1/null bo'lishi
          // mumkin — shunday holatda 0 deb olamiz
          const speedMs = update.coords.speed;
          setSpeedKmh(speedMs != null && speedMs > 0 ? speedMs * 3.6 : 0);
          const hdg = update.coords.heading;
          setHeading(hdg != null && hdg >= 0 ? hdg : undefined);

          // MUHIM: faqat "in_progress" bosqichida (mijoz mashinada,
          // safar boshlangan) masofani yig'amiz. GPS "sakrashi"dan
          // (bir joyda tursa ham xato koordinata kelishi) himoyalanish
          // uchun 0.02–1.5 km oralig'idagi harakatlarnigina hisobga
          // olamiz — bundan tashqarisi shovqin deb hisoblanadi.
          if (tripStageRef.current === 'in_progress') {
            if (lastTripPointRef.current) {
              const deltaKm = getDistanceKm(lastTripPointRef.current, newCoord);
              if (deltaKm > 0.02 && deltaKm < 1.5) {
                tripDistanceRef.current += deltaKm;
                setLiveTripDistanceKm(tripDistanceRef.current);
                // Bosib o'tilgan masofani vaqti-vaqti bilan qurilmaga
                // yozib boramiz (har 10 soniyada, ortiqcha yozuvni
                // oldini olish uchun) — ilova to'satdan yopilsa, safar
                // qayta ochilganda shu joydan davom etadi.
                const now = Date.now();
                if (now - lastTripPersistAtRef.current > 10000) {
                  lastTripPersistAtRef.current = now;
                  writeTripSnapshot.current();
                }
              }
            }
            lastTripPointRef.current = newCoord;
          }
        }
      );
    })();
    return () => { locationSubscription.current?.remove(); };
  }, []);

  // acceptOrderId prop o'zgarganda pendingAcceptId ni yangilash
  useEffect(() => {
    if (acceptOrderId && acceptOrderId !== processedAcceptId.current) {
      setPendingAcceptId(acceptOrderId);
    }
  }, [acceptOrderId]);

  // Deep link: oilataxidriver://accept?orderId=xxx
  useEffect(() => {
    function extractOrderId(url: string | null) {
      if (!url) return;
      try {
        const parsed = Linking.parse(url);
        const id = parsed.queryParams?.orderId;
        if (typeof id === 'string' && id.length > 0 && id !== processedAcceptId.current) {
          console.log('Deep link accept:', id);
          setPendingAcceptId(id);
        }
      } catch (e) {
        console.warn('Deep link parse xato:', e);
      }
    }
    Linking.getInitialURL().then(extractOrderId);
    const sub = Linking.addEventListener('url', (e) => extractOrderId(e.url));
    return () => sub.remove();
  }, []);

  // Zaxira: JS event
  useEffect(() => {
    const acceptSub = DeviceEventEmitter.addListener(
      'OrderOverlayAccept',
      (event: { orderId: string }) => {
        if (event?.orderId && event.orderId !== processedAcceptId.current) {
          console.log('DeviceEvent accept:', event.orderId);
          setPendingAcceptId(event.orderId);
        }
      }
    );
    const declineSub = DeviceEventEmitter.addListener(
      'OrderOverlayDecline',
      (event: { orderId: string }) => {
        if (event?.orderId) setSkippedOrderIds((p) => new Set(p).add(event.orderId));
      }
    );
    return () => { acceptSub.remove(); declineSub.remove(); };
  }, []);

  // pendingAcceptId + location tayyor bo'lganda buyurtmani qabul qilish
  // (Firestore ga native tomonda allaqachon yozilgan bo'ladi, bu yerda
  // faqat UI ni yangilaymiz)
  useEffect(() => {
    if (!pendingAcceptId || !location) return;
    // MUHIM: tugallanmagan safar tiklanayotgan bo'lsa kutamiz — aks
    // holda tiklanayotgan safar ustiga yangi buyurtma tushib qolardi
    // (quyidagi tripStageRef tekshiruvi hali null ko'rgan bo'lardi).
    if (restoringTrip) return;
    if (processedAcceptId.current === pendingAcceptId) return;

    processedAcceptId.current = pendingAcceptId;
    const orderId = pendingAcceptId;

    (async () => {
      try {
        const doc = await firestore().collection('orders').doc(orderId).get();
        const data = doc.data();
        if (!data) { console.warn('Buyurtma topilmadi:', orderId); return; }

        // MUHIM (band haydovchiga ikkinchi buyurtma): dispatch funksiyasi
        // "band" haydovchini o'tkazib yuborishi kerak, lekin native overlay
        // orqali ham, qo'lda "Ochiq buyurtmalar"dan ham nazariy jihatdan
        // ikkinchi buyurtma qabul qilinishi mumkin — bu holda joriy faol
        // safar Firestore'da hech qachon yakunlanmay "osilib" qoladi. Shu
        // sabab bu yerda ham qayta tekshiramiz: agar haydovchi ALLAQACHON
        // faol safar ustida bo'lsa, yangisini balans tekshiruvidagi kabi
        // darhol bekor qilamiz.
        if (tripStageRef.current) {
          await revertOrderAcceptance(orderId).catch(() => {});
          setPendingAcceptId(null);
          processedAcceptId.current = null;
          console.warn('Haydovchi allaqachon faol safarda — yangi buyurtma bekor qilindi:', orderId);
          return;
        }

        // MUHIM: native overlay Firestore'ga "accepted" deb ALLAQACHON
        // yozib bo'lgan bo'ladi (shu funksiya faqat UI'ni sozlaydi) —
        // shuning uchun balans yetarli emasligini bu yerda bilib olsak,
        // OLDINI OLISH kechikkan bo'ladi, faqat DARHOL BEKOR QILAMIZ:
        // buyurtma qayta "pending" holatiga qaytariladi (haydovchisiz),
        // shunda boshqa haydovchilarga ko'rinadi, bu esa hisob-kitobsiz
        // ishlashda davom etmaydi.
        if ((driver?.balance || 0) <= 0) {
          await revertOrderAcceptance(orderId).catch(() => {});
          setPendingAcceptId(null);
          processedAcceptId.current = null;
          Alert.alert(
            'Balans yetarli emas',
            'Buyurtma qabul qilish uchun hisobingizni to\'ldiring. Buyurtma boshqa haydovchiga qaytarildi.'
          );
          return;
        }

        const fo: FirestoreOrder = {
          id: orderId,
          status: 'accepted',
          driverId,
          customerName: data.customerName || "Noma'lum mijoz",
          customerPhone: data.customerPhone || '',
          fromAddress: data.fromAddress || '',
          toAddress: data.toAddress || '',
          tariffName: data.tariffName || '',
          price: typeof data.price === 'number' ? data.price : 0,
          distanceKm: typeof data.distanceKm === 'number' ? data.distanceKm : 0,
          perKm: typeof data.perKm === 'number' ? data.perKm : 0,
          minDistance: typeof data.minDistance === 'number' ? data.minDistance : 0,
          minDistancePrice: typeof data.minDistancePrice === 'number' ? data.minDistancePrice : (typeof data.price === 'number' ? data.price : 0),
          tieredPricing: !!data.tieredPricing,
          priceTiers: Array.isArray(data.priceTiers) ? data.priceTiers : undefined,
          note: data.note || '',
          source: data.source || 'dashboard',
          pickupLat: data.pickupLat ?? null,
          pickupLng: data.pickupLng ?? null,
          dropoffLat: data.dropoffLat ?? null,
          dropoffLng: data.dropoffLng ?? null,
          entranceNumber: data.entranceNumber || undefined,
          serviceType: data.serviceType === 'delivery' ? 'delivery' : data.serviceType === 'taxi' ? 'taxi' : undefined,
          toAddress2: data.toAddress2 || undefined,
          dropoff2Lat: typeof data.dropoff2Lat === 'number' ? data.dropoff2Lat : null,
          dropoff2Lng: typeof data.dropoff2Lng === 'number' ? data.dropoff2Lng : null,
          distanceKm2: typeof data.distanceKm2 === 'number' ? data.distanceKm2 : undefined,
          recipientName: data.recipientName || undefined,
          recipientPhone: data.recipientPhone || undefined,
          packageDescription: data.packageDescription || undefined,
        };

        // Zaxira: agar native tomon negadir yozmagan bo'lsa, shu yerda ham urinamiz
        await acceptOrder(orderId, driverId).catch(() => {});

        notifee.cancelAllNotifications().catch(console.warn);

        activeOrderSourceId.current = orderId;
        startWatchingOrderCancellation(orderId);
        const order = firestoreOrderToOrder(fo);
        setActiveOrder(order);
        setActiveLeg(1);
        setIsOnline(true);
        setTripStage('ready_to_start');
        startPan.setValue(0);
        setPendingAcceptId(null);
        // Koordinatasiz buyurtma — xaritada yo'l chizilmaydi. Buni
        // haydovchiga AYTISH shart: aks holda u xarita ishlamayapti deb
        // o'ylaydi. (Avval bunday holatda tasodifiy nuqta o'ylab
        // topilardi va u soxta manzilga haydab ketardi.)
        if (!order.pickupLocation) {
          Alert.alert(
            'Manzil xaritada belgilanmagan',
            `Bu buyurtmada olib ketish nuqtasining koordinatasi yo'q, shuning uchun xaritada yo'l chizilmaydi.\n\nManzil: ${order.fromAddress}\n\nMijozga qo'ng'iroq qilib aniqlashtiring.`
          );
        }
        setDriverBusyStatus(driverId, true).catch(() => {});
        console.log('Buyurtma qabul qilindi, tasdiqlash ekrani ko\'rsatilmoqda');
      } catch (e) {
        console.warn('Qabul qilishda xato:', e);
        processedAcceptId.current = null;
      }
    })();
  }, [pendingAcceptId, location, driverId, restoringTrip]);

  // Pool buyurtmalar — faqat gamburger menyuda, avtomatik taklif YO'Q.
  // MUHIM (filial izolyatsiyasi): faqat haydovchining O'Z filialiga
  // tegishli ochiq buyurtmalar tinglanadi (driver.branch).
  useEffect(() => {
    if (!isOnline) { setPoolOrders([]); return; }
    return listenToPoolOrders(
      driver?.branch,
      (orders) => setPoolOrders(orders),
      (error) => console.warn('Pool xato:', error)
    );
  }, [isOnline, driver?.branch]);

  useEffect(() => {
    if (!isOnline) {
      saveDriverPushToken(driverId, null).catch(console.warn);
      // MUHIM: foreground service ATAYLAB ilova yopilganda ham tirik
      // qoladi (killServiceOnDestroy: false) — safar o'rtasida kuzatuv
      // uzilib qolmasligi uchun. Lekin buning teskari tomoni bor:
      // ilova butunlay o'ldirilsa (Android xotira uchun yopdi,
      // haydovchi ro'yxatdan surib tashladi, yoki ilova quladi) xizmat
      // O'ZI QOLIB KETADI — doimiy bildirishnoma turaveradi va
      // joylashuv yozilaveradi.
      //
      // Ilova qayta ochilganda `isOnline` HAR DOIM false'dan boshlanadi,
      // uni to'xtatadigan esa hech kim yo'q edi: quyidagi cleanup faqat
      // effektning onlayn shoxi BIR MARTA ishlagan bo'lsagina
      // chaqiriladi, yangi ishga tushishda esa u umuman ishlamagan.
      // Natijada haydovchi o'chirib bo'lmaydigan bildirishnoma bilan
      // qolardi, dispetcher panelida esa "oflayn, lekin harakatlanyapti"
      // degan g'alati holat ko'rinardi.
      //
      // Endi oflayn holatining O'ZI xizmatni to'xtatadi — demak ilova
      // ochilishi bilan qolib ketgan xizmat yig'ishtiriladi. Haydovchi
      // haqiqatan safarda bo'lsa, safar tiklanishi `isOnline`ni true
      // qiladi va kuzatuv darhol qaytadan boshlanadi.
      stopDriverLocationTracking();
      return;
    }
    registerForPushNotifications().then((token) => {
      if (token) saveDriverPushToken(driverId, token).catch(console.warn);
    });
    ensureOverlayPermission();

    // MUHIM: avval bu yerda oddiy setInterval har 10 soniyada joylashuvni
    // Firestore'ga yozardi. setInterval — JS taymeri: ilova ekrandan
    // yo'qolishi bilan (boshqa ilovaga o'tildi, ekran o'chdi) u to'xtardi,
    // shu sababli dispetcher panelida haydovchi eski joyda qotib qolardi.
    // Undan ham yomoni — ilovani "faol ishlayapti" deb ko'rsatadigan hech
    // narsa yo'q edi, shuning uchun Android xotira kerak bo'lganda uni
    // bemalol o'ldirardi (safar o'rtasida ilovadan chiqib ketishning
    // asosiy sababi). Endi kuzatuv foreground service orqali ketadi:
    // doimiy bildirishnoma turgan ekan tizim ilovaga tegmaydi.
    //
    // MUHIM: fon rejimidagi joylashuv uchun Google Play ilova ichida
    // ALOHIDA tushuntirish ko'rsatishni va aniq rozilik olishni talab
    // qiladi (Prominent Disclosure) — tizimning ruxsat oynasidan OLDIN.
    // Shuning uchun haydovchi hali javob bermagan bo'lsa, avval o'sha
    // oyna ochiladi; kuzatuv javobdan keyin boshlanadi.
    (async () => {
      if ((await getBackgroundLocationConsent()) === null) {
        setBgLocationDisclosureVisible(true);
        return;
      }
      startDriverLocationTracking(driverId);
    })();
    return () => {
      stopDriverLocationTracking();
    };
  }, [isOnline, driverId]);

  // Tushuntirish oynasidagi javob. Ikkala holatda ham kuzatuv
  // boshlanadi — farqi shundaki, rad etilsa `startDriverLocationTracking`
  // tizimdan fon ruxsatini SO'RAMAYDI, ya'ni ilova butunlay yopilganda
  // kuzatuv to'xtaydi.
  async function handleBgLocationDisclosure(accepted: boolean) {
    setBgLocationDisclosureVisible(false);
    await setBackgroundLocationConsent(accepted ? 'granted' : 'declined');
    startDriverLocationTracking(driverId);
  }

  useEffect(() => {
    return listenToForegroundMessages((title, body) => {
      console.log('Push (foreground):', title, body);
    });
  }, []);

  const [routeDistanceKm, setRouteDistanceKm] = useState(0);
  const [routeDurationMin, setRouteDurationMin] = useState(0);
  const lastRouteFetchAt = useRef(0);
  const ROUTE_REFRESH_MS = 15000;

  useEffect(() => {
    const target = computeRouteTarget(activeOrder, tripStage, activeLeg);

    if (!target || !location) {
      setRouteCoords([]); setRouteDistanceKm(0); setRouteDurationMin(0);
      lastRouteFetchAt.current = 0;
      return;
    }
    const now = Date.now();
    if (lastRouteFetchAt.current !== 0 && now - lastRouteFetchAt.current < ROUTE_REFRESH_MS) return;

    let cancelled = false;
    lastRouteFetchAt.current = now;
    getRoute(location, target).then((result) => {
      if (cancelled) return;
      setRouteCoords(result.coordinates);
      if (result.distanceKm > 0) {
        setRouteDistanceKm(result.distanceKm);
        setRouteDurationMin(result.durationMin);
      }
    });
    return () => { cancelled = true; };
  }, [tripStage, activeOrder?.id, activeLeg, location]);

  const isNavigatingRef = useRef(false);
  // Boshlang'ich "fitToCoordinates" dan keyin, necha marta location
  // yangilanganini sanaymiz — birinchi 1-2 yangilanishda hali kamerani
  // "haydash rejimi"ga (heading+pitch) keskin burab yubormaslik uchun,
  // biroz o'tish vaqti beramiz
  const navUpdateCount = useRef(0);

  useEffect(() => {
    if (!activeOrder || !location || !mapRef.current) { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }
    if (tripStage !== 'to_pickup' && tripStage !== 'in_progress') { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }

    const currentDropoffForNav = activeLeg === 2 && activeOrder.dropoff2Location ? activeOrder.dropoff2Location : activeOrder.dropoffLocation;
    const target = tripStage === 'to_pickup' ? activeOrder.pickupLocation : currentDropoffForNav;
    if (!isNavigatingRef.current) {
      // MUHIM: avval butun yo'lni ko'rsatish uchun uzoqdan
      // zumlanardi (fitToCoordinates) — bu manzil uzoq bo'lsa xarita
      // juda uzoqdan ko'rinishiga sabab bo'lardi. Endi darhol yaqin
      // (haydash) zumida boshlanadi.
      mapRef.current.animateCamera(
        { center: location, zoom: 17 },
        { duration: 600 }
      );
      isNavigatingRef.current = true;
      navUpdateCount.current = 0;
    } else {
      navUpdateCount.current += 1;
      // Birinchi yangilanishda hali umumiy ko'rinishda qoldiramiz,
      // keyingi yangilanishlardan boshlab "haydash rejimi"ga o'tamiz:
      // xarita haydovchi yo'nalishiga qarab buriladi va biroz moyil
      // (pitch) bo'ladi — bu navigator ilovalaridagi kabi hissi beradi
      if (navUpdateCount.current >= 2) {
        mapRef.current.animateCamera(
          { center: location, zoom: 17, heading: heading ?? 0, pitch: 45 },
          { duration: 600 }
        );
      } else {
        mapRef.current.animateCamera({ center: location, zoom: 17 }, { duration: 600 });
      }
    }
  }, [tripStage, activeOrder?.id, activeLeg, location, heading]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => pan.setValue(Math.max(0, Math.min(SWIPE_THRESHOLD, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx > SWIPE_THRESHOLD / 2) {
          Animated.timing(pan, { toValue: SWIPE_THRESHOLD, duration: 150, useNativeDriver: false })
            .start(() => { setIsOnline(true); pan.setValue(0); });
        } else {
          Animated.spring(pan, { toValue: 0, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  // "Boshlash" slayderi (ready_to_start bosqichi) — surilgach
  // navigatsiya (to_pickup) boshlanadi
  const startPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_, g) => startPan.setValue(Math.max(0, Math.min(START_SWIPE_THRESHOLD, g.dx))),
      onPanResponderRelease: (_, g) => {
        if (g.dx > START_SWIPE_THRESHOLD / 2) {
          Animated.timing(startPan, { toValue: START_SWIPE_THRESHOLD, duration: 150, useNativeDriver: false })
            .start(() => {
              setTripStage('to_pickup');
              startPan.setValue(0);
            });
        } else {
          Animated.spring(startPan, { toValue: 0, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  function stopWatchingOrderCancellation() {
    orderCancelUnsubscribe.current?.();
    orderCancelUnsubscribe.current = null;
  }
  // Buyurtma qabul qilingan zahoti chaqiriladi — shu buyurtmani
  // dispetcher yoki mijozning o'zi bekor qilib qo'ysa, haydovchiga
  // darhol xabar beradi va ekranni bo'sh holatga qaytaradi.
  function startWatchingOrderCancellation(orderId: string) {
    stopWatchingOrderCancellation();
    orderCancelUnsubscribe.current = listenToOrderCancellation(orderId, (reason, cancelledBy) => {
      const who = cancelledBy === 'customer' ? 'Mijoz' : 'Dispetcher';
      Alert.alert('Buyurtma bekor qilindi', `${who} tomonidan bekor qilindi.\nSabab: ${reason}`);
      stopWatchingOrderCancellation();
      clearTripSnapshot();
      setTripStage(null);
      setActiveOrder(null);
      setActiveLeg(1);
      activeOrderSourceId.current = null;
      processedAcceptId.current = null;
      pan.setValue(0);
      startPan.setValue(0);
      setDriverBusyStatus(driverId, false).catch(() => {});
    });
  }

  function goOffline() {
    setIsOnline(false); setActiveOrder(null); setTripStage(null);
    setActiveLeg(1);
    setSkippedOrderIds(new Set());
    activeOrderSourceId.current = null;
    processedAcceptId.current = null;
    setPendingAcceptId(null);
    stopWatchingOrderCancellation();
    clearTripSnapshot();
    pan.setValue(0);
    startPan.setValue(0);
    setDriverBusyStatus(driverId, false).catch(() => {});
  }

  function openNotifications() {
    setNotifModalVisible(true);
    const now = Date.now();
    lastSeenNotifAtRef.current = now;
    setUnreadNotifCount(0);
    AsyncStorage.setItem(`notif_last_seen_${driverId}`, String(now)).catch(() => {});
  }

  function setDriverMode(mode: 'home' | 'work' | 'nearby') {
    if ((mode === 'home' && !savedLocations.home) || (mode === 'work' && !savedLocations.work)) {
      Alert.alert(
        mode === 'home' ? 'Uy manzili saqlanmagan' : 'Ish manzili saqlanmagan',
        'Avval manzilni sozlamalarda saqlang.',
        [
          { text: 'Bekor qilish', style: 'cancel' },
          { text: 'Sozlash', onPress: () => { setMenuVisible(false); setLocationSettingsVisible(true); } },
        ]
      );
      return;
    }
    if (mode === 'nearby' && activeMode !== 'nearby' && !location) {
      Alert.alert('Joylashuv aniqlanmagan', 'GPS joylashuvi hali aniqlanmadi, birozdan keyin urinib ko\u2018ring.');
      return;
    }
    const newMode = activeMode === mode ? null : mode;
    setActiveMode(newMode);
    const patch: { activeMode: typeof newMode; nearbyAnchor?: { lat: number; lng: number } } = { activeMode: newMode };
    if (newMode === 'nearby' && location) {
      // "Qoziq" mantig'i: tugma bosilgan ANIQ shu paytdagi joylashuv
      // qat'iy markaz sifatida saqlanadi. Qayta bosib o'chirib-yoqmasa,
      // bu nuqta o'zgarmaydi.
      patch.nearbyAnchor = { lat: location.latitude, lng: location.longitude };
    }
    firestore().collection('drivers').doc(driverId).set(
      patch,
      { merge: true }
    ).then(() => {
      if (newMode === 'nearby') {
        Alert.alert(
          'Hudud belgilandi',
          'Joriy joylashuvingiz markaz sifatida saqlandi. Endi shu nuqtadan atrofdagi buyurtmalarni olasiz — qayerga yursangiz ham markaz o\u2018zgarmaydi.'
        );
      }
    }).catch((e) => console.warn('activeMode yozishda xato:', e));
  }

  async function saveCurrentLocationAs(kind: 'home' | 'work') {
    if (!location) return;
    let address = '';
    try {
      const results = await Location.reverseGeocodeAsync(location);
      const r = results?.[0];
      if (r) address = [r.street, r.district || r.city].filter(Boolean).join(', ');
    } catch (e) {
      console.warn('Manzilni aniqlashda xato:', e);
    }
    const point = { lat: location.latitude, lng: location.longitude, address };
    const newSaved = { ...savedLocations, [kind]: point };
    setSavedLocations(newSaved);
    firestore().collection('drivers').doc(driverId).set(
      { savedLocations: newSaved },
      { merge: true }
    ).catch((e) => console.warn('Manzilni saqlashda xato:', e));
  }

  // Bordyur — ko'chadan olingan yo'lovchi uchun, dispetchersiz, haydovchi
  // o'zi to'g'ridan-to'g'ri boshlaydigan safar. Oddiy pool buyurtmadan
  // farqli ravishda "qabul qilish"/"yo'lga chiqish" bosqichlari yo'q —
  // trip boshidanoq 'in_progress' holatida, chunki yo'lovchi allaqachon
  // mashinada. Manzil oldindan noma'lum, narx metr (perKm) bo'yicha
  // hisoblanadi (xuddi tariffPerKm/tariffMinPrice orqali).
  async function handleStartBordur() {
    if (!location) {
      Alert.alert('Joylashuv aniqlanmagan', 'GPS joylashuvi hali aniqlanmadi, birozdan keyin urinib ko‘ring.');
      return;
    }
    try {
      const { orderId, tariff } = await startBordurTrip(driverId, location);
      activeOrderSourceId.current = orderId;
      setActiveOrder({
        id: orderId,
        type: tariff.name,
        distanceKm: 0,
        durationMin: 0,
        price: 0,
        perKm: tariff.perKm,
        minDistance: tariff.minDistance,
        minDistancePrice: tariff.minDistancePrice,
        fromAddress: 'Bordyur',
        toAddress: '',
        pickupCount: 1,
        dropoffCount: 1,
        customer: { name: 'Bordyur mijozi', phone: '', rating: 4.8 },
        pickupLocation: location,
        dropoffLocation: location,
      });
      setTripStage('in_progress');
      setMenuVisible(false);
      // MUHIM: bordyur safari boshlanganda ham haydovchi "band" deb
      // belgilanishi kerak — aks holda dispatch funksiyasi uni hamon
      // bo'sh deb hisoblab, ustiga yangi buyurtma yuborishi mumkin.
      setDriverBusyStatus(driverId, true).catch(() => {});
    } catch (e: any) {
      if (e?.message === 'NO_BORDUR_TARIFF') {
        Alert.alert(
          'Bordyur tarifi topilmadi',
          'Dashboard’da "Maxsus rejimlar" bo‘limida bordyur rejimi yoqilgan, faol tarif yo‘q.'
        );
      } else {
        console.warn('Bordyur safarini boshlashda xato:', e);
        Alert.alert('Xatolik', 'Bordyur safarini boshlab bo‘lmadi. Qayta urinib ko‘ring.');
      }
    }
  }

  function recenterMap() {
    if (location && mapRef.current) {
      mapRef.current.animateToRegion({ ...location, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 500);
    }
  }
  function zoomIn() {
    if (!currentRegion || !mapRef.current) return;
    const n = { ...currentRegion, latitudeDelta: currentRegion.latitudeDelta / 2, longitudeDelta: currentRegion.longitudeDelta / 2 };
    setCurrentRegion(n); mapRef.current.animateToRegion(n, 200);
  }
  function zoomOut() {
    if (!currentRegion || !mapRef.current) return;
    const n = { ...currentRegion, latitudeDelta: currentRegion.latitudeDelta * 2, longitudeDelta: currentRegion.longitudeDelta * 2 };
    setCurrentRegion(n); mapRef.current.animateToRegion(n, 200);
  }

  function handleAcceptOrder() {
    if ((driver?.balance || 0) <= 0) {
      Alert.alert(
        'Balans yetarli emas',
        'Buyurtma qabul qilish uchun hisobingizni to\'ldiring.'
      );
      return;
    }
    const id = activeOrderSourceId.current;
    if (id) acceptOrder(id, driverId).catch(console.warn);
    setTripStage('to_pickup');
    setDriverBusyStatus(driverId, true).catch(() => {});
  }
  function handleSkipOrder() {
    const id = activeOrderSourceId.current;
    if (id) setSkippedOrderIds((p) => new Set(p).add(id));
    setActiveOrder(null);
    activeOrderSourceId.current = null;
  }
  function handleArrivedAtPickup() {
    const id = activeOrderSourceId.current;
    if (id) updateOrderStatus(id, 'arrived').catch(console.warn);
    setTripStage('waiting');
  }
  function handleStartTrip() {
    const id = activeOrderSourceId.current;
    if (id) updateOrderStatus(id, 'in_progress').catch(console.warn);
    notifyTripStart();
    // Safar boshlanish nuqtasidan hisoblagichni nolga tushiramiz
    tripDistanceRef.current = 0;
    lastTripPointRef.current = location;
    setLiveTripDistanceKm(0);
    setActiveLeg(1);
    setTripStage('in_progress');
  }
  // Ikkinchi manzilli buyurtmada 1-manzilga yetib kelgach chaqiriladi —
  // buyurtma holati hali "in_progress"ligicha qoladi (mijoz hali
  // mashinada, xolos yo'nalish 2-manzilga almashadi), shuning uchun
  // Firestore holatini o'zgartirmaymiz, faqat mahalliy "oyoq"ni almashtiramiz.
  function handleReachedStop1() {
    setActiveLeg(2);
    lastRouteFetchAt.current = 0;
    setRouteCoords([]);
  }
  // "Safarni yakunlash" bosilganda darhol buyurtmani tugatmaymiz —
  // avval xulosa ko'rsatiladi. "Davom etish" bossa, GPS kuzatuvi
  // (va narx hisoblash) hech narsa buzilmasdan davom etadi (tripStage
  // hali ham "in_progress" bo'lib qoladi).
  function openTripSummary() {
    setShowTripSummary(true);
  }
  function closeTripSummary() {
    setShowTripSummary(false);
  }
  function confirmFinishTrip() {
    const id = activeOrderSourceId.current;
    if (id) {
      // MUHIM (poyga holati): avval bu ikkala yozuv mustaqil, tartibsiz
      // yuborilardi — agar "completed" yozuvi tezroq yetib borsa,
      // komissiya/bonus Cloud Function'lari hali ESKI (buyurtma
      // yaratilgandagi taxminiy) narxni o'qib ulgurib, "bajarildi"
      // bayrog'ini qo'yib qo'yardi — haqiqiy metrланган narx (pastda)
      // keyin kelsa ham, komissiya/bonus qayta hisoblanmasdi. Endi avval
      // yakuniy narx yoziladi (kutiladi), FAQAT SHUNDAN KEYIN holat
      // "completed"ga o'tkaziladi — Cloud Function har doim eng so'nggi
      // narxni ko'radi.
      (async () => {
        try {
          // Yakuniy narx — jonli hisoblangan (va yaxlitlangan) summa,
          // oldindan taxmin qilingan (statik) narx emas
          await finalizeOrderPrice(id, livePrice, tripDistanceRef.current);
        } catch (e) {
          console.warn(e);
        }
        updateOrderStatus(id, 'completed').catch(console.warn);
      })();
    }
    notifyTripEnd();
    stopWatchingOrderCancellation();
    clearTripSnapshot();
    setShowTripSummary(false);
    setTripStage(null); setActiveOrder(null);
    setActiveLeg(1);
    activeOrderSourceId.current = null;
    processedAcceptId.current = null;
    setDriverBusyStatus(driverId, false).catch(() => {});
  }
  // Buyurtma qabul qilingandan keyin (ready_to_start/to_pickup/waiting
  // bosqichlarida) haydovchi bekor qilsa — sababi bilan birga
  // Firestore'ga yoziladi, shunda dispetcher panelida ko'rinadi.
  // in_progress bosqichida (mijoz allaqachon mashinada) bu tugma
  // umuman ko'rsatilmaydi.
  function handleCancelOrder(reason: string) {
    const id = activeOrderSourceId.current;
    if (id) cancelOrder(id, reason).catch(console.warn);
    stopWatchingOrderCancellation();
    clearTripSnapshot();
    setCancelModalVisible(false);
    setTripStage(null);
    setActiveOrder(null);
    setActiveLeg(1);
    activeOrderSourceId.current = null;
    processedAcceptId.current = null;
    startPan.setValue(0);
    setDriverBusyStatus(driverId, false).catch(() => {});
  }
  async function handleTakePoolOrder(order: Order) {
    if ((driver?.balance || 0) <= 0) {
      Alert.alert(
        'Balans yetarli emas',
        'Buyurtma qabul qilish uchun hisobingizni to\'ldiring.'
      );
      return;
    }
    // MUHIM: endi tranzaksiya orqali qabul qilinadi — agar boshqa
    // haydovchi shu buyurtmani bir zumda oldin olib ulgurgan bo'lsa,
    // OrderAlreadyTakenError tashlanadi va biz LOKAL holatni
    // o'zgartirmaymiz (avval bu tekshiruv yo'q edi, ikkala haydovchi
    // ham "oldim" deb o'ylab qolishi mumkin edi).
    try {
      await acceptOrder(order.id, driverId);
    } catch (error) {
      if (error instanceof OrderAlreadyTakenError) {
        Alert.alert('Kechikdingiz', 'Bu buyurtmani boshqa haydovchi allaqachon oldi.');
      } else {
        console.warn(error);
      }
      return;
    }
    activeOrderSourceId.current = order.id;
    startWatchingOrderCancellation(order.id);
    processedAcceptId.current = order.id;
    setPoolVisible(false);
    setActiveOrder(order);
    setActiveLeg(1);
    setTripStage('ready_to_start');
    startPan.setValue(0);
    setDriverBusyStatus(driverId, true).catch(() => {});
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={COLORS.primary} />
        <Text style={styles.loadingText}>Joylashuv aniqlanmoqda...</Text>
      </View>
    );
  }
  if (errorMsg || !location) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{errorMsg || 'Joylashuvni aniqlab bo\u02bblmadi'}</Text>
      </View>
    );
  }

  const hasSecondStop = !!(activeOrder?.toAddress2 && activeOrder?.dropoff2Location);
  const routeTarget = computeRouteTarget(activeOrder, tripStage, activeLeg);
  const fallbackDistanceKm = routeTarget ? getDistanceKm(location, routeTarget) : 0;
  const liveDistanceKm = routeDistanceKm > 0 ? routeDistanceKm : fallbackDistanceKm;
  const liveDurationMin = routeDurationMin > 0 ? routeDurationMin : estimateDurationMin(fallbackDistanceKm);

  // Jonli narx — safar (in_progress) boshlangandan buyon bosib
  // o'tilgan haqiqiy masofaga asoslanadi, tarifning minimal narxi +
  // minimal masofadan oshgan har bir km uchun qo'shimcha stavka.
  // Yaxlitlash: navbatdagi 1000 so'mlikka YUQORIGA qarab yaxlitlanadi
  // (masalan 18432 -> 19000, 19424 -> 20000). Shu tufayli ekranda
  // ko'rsatilgan "Joriy narx" va safar yakunida yozib qo'yiladigan
  // yakuniy narx doim bir xil, dumaloq summa bo'ladi.
  const tariffMinPrice = activeOrder?.minDistancePrice ?? activeOrder?.price ?? 0;
  const tariffMinDistance = activeOrder?.minDistance ?? 0;
  const tariffPerKm = activeOrder?.perKm ?? 0;
  const distanceBeyondMin = Math.max(0, liveTripDistanceKm - tariffMinDistance);
  const distanceSurcharge = activeOrder?.tieredPricing
    ? computeTieredDistanceSurcharge(distanceBeyondMin, activeOrder?.priceTiers)
    : distanceBeyondMin * tariffPerKm;
  const rawLivePrice = tariffMinPrice + distanceSurcharge;
  const livePrice = Math.ceil(rawLivePrice / 1000) * 1000;
  // MUHIM: `livePrice` — sof tarif/masofa asosidagi (xom) summa, mijoz
  // ishlatgan bonus/qo'shimcha xizmatni hisobga olmaydi. Ekranda haydovchiga
  // ko'rsatiladigan summa esa finalizeOrderPrice() safar oxirida Firestore'ga
  // yozadigan `finalPrice` bilan mos kelishi shart — aks holda haydovchi
  // bonus qo'llanmagandek, undan yuqoriroq (noto'g'ri) summa ko'radi.
  const displayPrice = Math.max(0, livePrice + (activeOrder?.extrasTotal || 0) - (activeOrder?.bonusUsed || 0));

  const bottomSafeOffset = TAB_BAR_HEIGHT + insets.bottom;
  const textOpacity = pan.interpolate({ inputRange: [0, SWIPE_THRESHOLD], outputRange: [1, 0], extrapolate: 'clamp' });

  return (
    <View style={styles.flex}>
      <MapView
        ref={mapRef}
        style={styles.flex}
        initialRegion={currentRegion ?? { ...location, latitudeDelta: 0.05, longitudeDelta: 0.05 }}
        onRegionChangeComplete={setCurrentRegion}
        showsUserLocation
      >
        {!tripStage && MOCK_HEAT_POINTS.map((p, i) => (
          <Circle key={i} center={{ latitude: p.latitude, longitude: p.longitude }} radius={p.radius}
            fillColor={getHeatColor(p.intensity)} strokeColor="transparent" />
        ))}
        <Marker coordinate={location} title="Siz shu yerdasiz" />
        {routeTarget && (
          <>
            <Polyline coordinates={routeCoords.length > 1 ? routeCoords : [location, routeTarget]}
              strokeColor={COLORS.primary} strokeWidth={5} />
            <Marker coordinate={routeTarget} pinColor={
              tripStage === 'to_pickup' ? COLORS.success : (hasSecondStop && activeLeg === 1 ? COLORS.warning : COLORS.danger)
            } />
          </>
        )}
        {tripStage === 'waiting' && activeOrder?.pickupLocation && (
          <Marker coordinate={activeOrder.pickupLocation} pinColor={COLORS.success} />
        )}
      </MapView>

      <SafeAreaView style={styles.topBar} pointerEvents="box-none">
        <View style={styles.topBarRow}>
          <View style={styles.glassWrap}>
            <GlassPanel style={[styles.brandPill, styles.glassLight]}>
              <Text style={styles.brandText}>Sevimli Go</Text>
            </GlassPanel>
          </View>
        </View>
      </SafeAreaView>

      {(tripStage === 'to_pickup' || tripStage === 'in_progress') && (
        <View style={[styles.speedBadge, { top: insets.top + 70 }]}>
          <Text style={styles.speedValue}>{Math.round(speedKmh)}</Text>
          <Text style={styles.speedUnit}>km/h</Text>
        </View>
      )}

      <View style={[styles.rightColumn, { bottom: bottomSafeOffset + 120 }]}>
        <TouchableOpacity activeOpacity={0.8} onPress={openNotifications}>
          <GlassPanel style={[styles.sideBtnSingle, styles.glassLight]}>
            <Ionicons name="notifications" size={22} color={COLORS.dark} />
          </GlassPanel>
          {unreadNotifCount > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{unreadNotifCount > 9 ? '9+' : unreadNotifCount}</Text></View>
          )}
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} onPress={() => setPoolVisible(true)}>
          <GlassPanel style={[styles.sideBtnSingle, styles.glassLight]}>
            <Ionicons name="menu" size={24} color={COLORS.dark} />
          </GlassPanel>
          {poolOrders.length > 0 && (
            <View style={styles.badge}><Text style={styles.badgeText}>{poolOrders.length}</Text></View>
          )}
        </TouchableOpacity>

        <GlassPanel style={[styles.sideBtnGroup, styles.glassLight]}>
          <TouchableOpacity style={styles.sideBtn} onPress={zoomIn}>
            <Ionicons name="add" size={26} color={COLORS.dark} />
          </TouchableOpacity>
          <View style={styles.sideDivider} />
          <TouchableOpacity style={styles.sideBtn} onPress={zoomOut}>
            <Ionicons name="remove" size={26} color={COLORS.dark} />
          </TouchableOpacity>
        </GlassPanel>

        <TouchableOpacity activeOpacity={0.8} onPress={() => setMenuVisible(true)}>
          <GlassPanel style={[styles.sideBtnSingle, styles.glassLight]}>
            <View style={styles.midLeftIcons}>
              <Ionicons name="menu" size={20} color={COLORS.dark} />
              <Ionicons name="search" size={18} color={COLORS.dark} style={styles.midLeftSearchIcon} />
            </View>
          </GlassPanel>
        </TouchableOpacity>

        <TouchableOpacity activeOpacity={0.8} onPress={recenterMap}>
          <GlassPanel style={[styles.sideBtnSingle, styles.glassLight]}>
            <Ionicons name="navigate" size={26} color={COLORS.primary} />
          </GlassPanel>
        </TouchableOpacity>
      </View>

      {isOnline && !tripStage && (
        <TouchableOpacity activeOpacity={0.8} style={styles.powerBtnWrap} onPress={goOffline}>
          <GlassPanel style={styles.powerBtn} intensity={75} tintColor="#16A34A">
            <Ionicons name="power" size={26} color={COLORS.white} />
          </GlassPanel>
        </TouchableOpacity>
      )}

      {!isOnline && !pendingAcceptId && (
        <View style={[styles.bottomArea, { bottom: bottomSafeOffset + 24 }]}>
          <View style={[styles.track, styles.trackOff]} {...panResponder.panHandlers}>
            <Animated.View pointerEvents="none" style={[styles.trackOffTextWrap, { opacity: textOpacity }]}>
              <Text style={styles.trackOffLabel}>Oflayn</Text>
              <Text style={styles.trackOffTitle}>Onlaynga chiqish</Text>
            </Animated.View>
            <Animated.View style={[styles.knob, { transform: [{ translateX: pan }] }]}>
              <Ionicons name="arrow-forward" size={28} color={COLORS.dark} />
            </Animated.View>
          </View>
        </View>
      )}

      {isOnline && activeOrder && !tripStage && !pendingAcceptId && (
        <View style={[styles.orderOverlay, { bottom: bottomSafeOffset }]}>
          <OrderCard order={activeOrder} onAccept={handleAcceptOrder} onSkip={handleSkipOrder} />
        </View>
      )}
      {tripStage === 'ready_to_start' && activeOrder && (
        <View style={[styles.orderOverlay, { bottom: bottomSafeOffset }]}>
          <View style={styles.readyCard}>
            <View style={styles.readyTopRow}>
              <Text style={styles.readyStageLabel}>Buyurtma tasdiqlandi</Text>
              <TouchableOpacity onPress={() => setCancelModalVisible(true)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.readyCancelLink}>Bekor qilish</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.readyHeaderRow}>
              <Text style={styles.readyPrice}>{activeOrder.price.toLocaleString()} so'm</Text>
              <View style={styles.readyTariffPill}>
                <Text style={styles.readyTariffText}>{activeOrder.type}</Text>
              </View>
            </View>

            <View style={styles.readyDivider} />

            <View style={styles.readyRouteRow}>
              <View style={styles.readyRouteIcons}>
                <View style={[styles.readyRouteDot, { backgroundColor: COLORS.success }]} />
                <View style={styles.readyRouteLine} />
                <View style={[styles.readyRouteDot, { backgroundColor: COLORS.danger }]} />
              </View>
              <View style={styles.readyRouteTexts}>
                <Text style={styles.readyRouteAddress} numberOfLines={2}>
                  {activeOrder.fromAddress || "Manzil ko'rsatilmagan"}
                </Text>
                <View style={styles.readyRouteGap} />
                <Text style={styles.readyRouteAddress} numberOfLines={2}>
                  {activeOrder.toAddress || "Manzil ko'rsatilmagan"}
                </Text>
                {!!activeOrder.toAddress2 && (
                  <>
                    <View style={styles.readyRouteGap} />
                    <Text style={styles.readyRouteAddress} numberOfLines={2}>
                      {activeOrder.toAddress2}
                    </Text>
                  </>
                )}
              </View>
            </View>

            {!!activeOrder.packageDescription && (
              <Text style={styles.readyPackageText} numberOfLines={2}>📦 {activeOrder.packageDescription}</Text>
            )}

            <View style={styles.readyDivider} />

            <View style={styles.readyCustomerRow}>
              <View style={styles.readyCustomerAvatar}>
                <Ionicons name="person" size={20} color={COLORS.white} />
              </View>
              <View style={styles.readyCustomerInfo}>
                <Text style={styles.readyCustomerName}>{activeOrder.customer.name}</Text>
                <Text style={styles.readyDistanceText}>
                  {activeOrder.distanceKm.toFixed(1)} km • {activeOrder.durationMin} min
                </Text>
              </View>
              {!!activeOrder.customer.phone && (
                <TouchableOpacity
                  style={styles.readyCallBtn}
                  onPress={() => RNLinking.openURL(`tel:${activeOrder.customer.phone}`)}
                >
                  <Ionicons name="call" size={20} color={COLORS.white} />
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.startTrack} {...startPanResponder.panHandlers}>
              <Animated.View pointerEvents="none" style={[styles.startTrackTextWrap, {
                opacity: startPan.interpolate({ inputRange: [0, START_SWIPE_THRESHOLD], outputRange: [1, 0], extrapolate: 'clamp' }),
              }]}>
                <Text style={styles.startTrackTitle}>Boshlash</Text>
              </Animated.View>
              <Animated.View style={[styles.startKnob, { transform: [{ translateX: startPan }] }]}>
                <Ionicons name="arrow-forward" size={28} color={COLORS.dark} />
              </Animated.View>
            </View>
          </View>
        </View>
      )}
      {tripStage === 'to_pickup' && activeOrder && (
        <View style={[styles.orderOverlay, { bottom: bottomSafeOffset }]}>
          <TripCard order={activeOrder} stage="to_pickup" distanceKm={liveDistanceKm}
            durationMin={liveDurationMin} onPrimaryAction={handleArrivedAtPickup}
            onCancel={() => setCancelModalVisible(true)} />
        </View>
      )}
      {tripStage === 'waiting' && activeOrder && (
        <View style={[styles.orderOverlay, { bottom: bottomSafeOffset }]}>
          <WaitingCard order={activeOrder} onStartTrip={handleStartTrip} onRecenterMap={recenterMap}
            onCancel={() => setCancelModalVisible(true)} />
        </View>
      )}
      {tripStage === 'in_progress' && activeOrder && (
        <View style={[styles.orderOverlay, { bottom: bottomSafeOffset }]}>
          <TripCard
            order={
              hasSecondStop && activeLeg === 2
                // 2-oyoqda: "qayerdan" endi 1-manzil bo'ladi, "qayerga"
                // esa haqiqiy 2-manzil — shu tariqa karta ikkinchi
                // yo'nalishni ko'rsatadi.
                ? { ...activeOrder, fromAddress: activeOrder.toAddress || activeOrder.fromAddress, toAddress: activeOrder.toAddress2 || '' }
                : activeOrder
            }
            stage="in_progress" distanceKm={liveDistanceKm}
            durationMin={liveDurationMin} price={displayPrice}
            stageNote={hasSecondStop ? (activeLeg === 1 ? '1/2-manzil' : '2/2-manzil') : undefined}
            primaryLabel={hasSecondStop && activeLeg === 1 ? '1-manzilga yetdim, davom etamiz' : undefined}
            recipientName={activeOrder.serviceType === 'delivery' && (activeLeg === 2 || !hasSecondStop) ? activeOrder.recipientName : undefined}
            recipientPhone={activeOrder.serviceType === 'delivery' && (activeLeg === 2 || !hasSecondStop) ? activeOrder.recipientPhone : undefined}
            packageDescription={activeOrder.serviceType === 'delivery' ? activeOrder.packageDescription : undefined}
            onPrimaryAction={hasSecondStop && activeLeg === 1 ? handleReachedStop1 : openTripSummary} />
        </View>
      )}

      <Modal visible={poolVisible} animationType="slide" transparent onRequestClose={() => setPoolVisible(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setPoolVisible(false)} />
          <GlassPanel style={[styles.poolSheet, { paddingBottom: 30 + insets.bottom }]} intensity={95}>
            <View style={styles.sheetHandle} />
            <Text style={styles.poolTitle}>Ochiq buyurtmalar</Text>
            <Text style={styles.poolSubtitle}>Boshqa haydovchilar olmagan buyurtmalar shu yerda</Text>
            {poolOrders.length === 0 ? (
              <View style={styles.poolEmpty}>
                <Ionicons name="checkmark-circle" size={40} color={COLORS.success} />
                <Text style={styles.poolEmptyText}>Hozircha ochiq buyurtma yo'q</Text>
              </View>
            ) : (
              <FlatList data={poolOrders} keyExtractor={(i) => i.id} style={styles.poolList}
                renderItem={({ item }) => {
                  const order = firestoreOrderToOrder(item);
                  return <PoolOrderItem order={order} onTake={() => handleTakePoolOrder(order)} />;
                }} />
            )}
          </GlassPanel>
        </View>
      </Modal>

      <Modal visible={menuVisible} animationType="slide" transparent onRequestClose={() => setMenuVisible(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setMenuVisible(false)} />
          <GlassPanel style={[styles.sheet, { paddingBottom: 36 + insets.bottom }]} intensity={95}>
            <View style={styles.sheetHandle} />
            <View style={styles.searchRow}>
              <Ionicons name="search" size={20} color={COLORS.textMuted} />
              <TextInput style={styles.searchInput} placeholder="Adres yoki joy" placeholderTextColor={COLORS.textMuted} />
            </View>
            <View style={styles.grid}>
              {[
                { icon: 'home', label: 'Domoy', mode: 'home' as const },
                { icon: 'briefcase', label: 'Ish', mode: 'work' as const },
                { icon: 'locate', label: 'Mening hududim', mode: 'nearby' as const },
                { icon: 'trail-sign', label: 'Bordyur', mode: null },
              ].map((g) => {
                const isActive = g.mode != null && activeMode === g.mode;
                return (
                  <GlassPanel
                    key={g.label}
                    style={[styles.gridItem, styles.glassLight, isActive && styles.gridItemActive]}
                    intensity={70}
                  >
                    <TouchableOpacity
                      style={styles.gridItemTouchable}
                      onPress={() => {
                        if (g.mode) setDriverMode(g.mode);
                        else handleStartBordur();
                      }}
                    >
                      <Ionicons name={g.icon as any} size={24} color={isActive ? COLORS.primary : COLORS.dark} />
                      <Text style={[styles.gridLabel, isActive && { color: COLORS.primary }]}>{g.label}</Text>
                    </TouchableOpacity>
                  </GlassPanel>
                );
              })}
            </View>
            <TouchableOpacity
              style={styles.locationSettingsLink}
              onPress={() => { setMenuVisible(false); setLocationSettingsVisible(true); }}
            >
              <Ionicons name="settings-outline" size={14} color={COLORS.textMuted} />
              <Text style={styles.locationSettingsLinkText}>Uy va ish manzilini sozlash</Text>
            </TouchableOpacity>
          </GlassPanel>
        </View>
      </Modal>

      <Modal visible={showTripSummary} animationType="fade" transparent onRequestClose={closeTripSummary}>
        <View style={styles.summaryOverlay}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryTitle}>Safar xulosasi</Text>
            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Masofa</Text>
              <Text style={styles.summaryValue}>{liveTripDistanceKm.toFixed(1)} km</Text>
            </View>
            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Kutish narxi</Text>
              <Text style={styles.summaryValue}>0 so'm</Text>
            </View>
            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Qo'shimcha xizmat</Text>
              <Text style={styles.summaryValue}>{(activeOrder?.extrasTotal || 0).toLocaleString()} so'm</Text>
            </View>
            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Yo'l narxi</Text>
              <Text style={styles.summaryValue}>{livePrice.toLocaleString()} so'm</Text>
            </View>
            <View style={styles.summaryDivider} />

            {!!activeOrder?.bonusUsed && (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>Mijoz bonusi</Text>
                  <Text style={styles.summaryValue}>−{activeOrder.bonusUsed.toLocaleString()} so'm</Text>
                </View>
                <View style={styles.summaryDivider} />
              </>
            )}

            <Text style={styles.summaryTotalLabel}>Safar narxi</Text>
            <Text style={styles.summaryTotalValue}>{displayPrice.toLocaleString()} so'm</Text>

            <View style={styles.summaryBtnRow}>
              <TouchableOpacity style={styles.summaryBtnLight} onPress={closeTripSummary}>
                <Text style={styles.summaryBtnLightText}>Davom etish</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.summaryBtnPrimary} onPress={confirmFinishTrip}>
                <Text style={styles.summaryBtnPrimaryText}>Yakunlash</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={notifModalVisible} animationType="slide" transparent onRequestClose={() => setNotifModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setNotifModalVisible(false)} />
          <GlassPanel style={[styles.poolSheet, { paddingBottom: 30 + insets.bottom }]} intensity={95}>
            <View style={styles.sheetHandle} />
            <Text style={styles.poolTitle}>Bildirishnomalar</Text>
            <Text style={styles.poolSubtitle}>Dispetcher tomonidan yuborilgan xabarlar</Text>
            {notifications.length === 0 ? (
              <View style={styles.poolEmpty}>
                <Ionicons name="notifications-off" size={40} color={COLORS.textMuted} />
                <Text style={styles.poolEmptyText}>Hozircha xabar yo'q</Text>
              </View>
            ) : (
              <FlatList data={notifications} keyExtractor={(i) => i.id} style={styles.poolList}
                renderItem={({ item }) => (
                  <View style={styles.notifItem}>
                    <Text style={styles.notifItemTitle}>{item.title}</Text>
                    {!!item.image && (
                      <Image source={{ uri: item.image }} style={styles.notifItemImage} resizeMode="cover" />
                    )}
                    <Text style={styles.notifItemText}>{item.text}</Text>
                    <Text style={styles.notifItemTime}>{new Date(item.createdAtMillis).toLocaleString('uz-UZ')}</Text>
                  </View>
                )} />
            )}
          </GlassPanel>
        </View>
      </Modal>

      <Modal visible={locationSettingsVisible} animationType="slide" transparent onRequestClose={() => setLocationSettingsVisible(false)}>
        <View style={styles.modalOverlay}>
          <TouchableOpacity style={styles.modalBackdrop} onPress={() => setLocationSettingsVisible(false)} />
          <GlassPanel style={[styles.sheet, { paddingBottom: 30 + insets.bottom }]} intensity={95}>
            <View style={styles.sheetHandle} />
            <Text style={styles.poolTitle}>Manzillarni sozlash</Text>
            <Text style={styles.poolSubtitle}>Hozirgi joylashuvingizni uy yoki ish manzili sifatida saqlang</Text>

            <View style={[styles.locSettingRow, { marginTop: 16 }]}>
              <Text style={styles.locSettingLabel}>🏠 Uy manzili</Text>
              <Text style={styles.locSettingAddress}>
                {savedLocations.home?.address || (savedLocations.home ? 'Saqlangan (manzil nomisiz)' : 'Hali saqlanmagan')}
              </Text>
              <TouchableOpacity style={styles.locSettingBtn} onPress={() => saveCurrentLocationAs('home')}>
                <Text style={styles.locSettingBtnText}>Joriy joylashuvni Uy sifatida saqlash</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.locSettingRow}>
              <Text style={styles.locSettingLabel}>💼 Ish manzili</Text>
              <Text style={styles.locSettingAddress}>
                {savedLocations.work?.address || (savedLocations.work ? 'Saqlangan (manzil nomisiz)' : 'Hali saqlanmagan')}
              </Text>
              <TouchableOpacity style={styles.locSettingBtn} onPress={() => saveCurrentLocationAs('work')}>
                <Text style={styles.locSettingBtnText}>Joriy joylashuvni Ish sifatida saqlash</Text>
              </TouchableOpacity>
            </View>
          </GlassPanel>
        </View>
      </Modal>

      <CancelOrderModal
        visible={cancelModalVisible}
        onClose={() => setCancelModalVisible(false)}
        onConfirm={handleCancelOrder}
      />

      <BackgroundLocationDisclosure
        visible={bgLocationDisclosureVisible}
        onAccept={() => handleBgLocationDisclosure(true)}
        onDecline={() => handleBgLocationDisclosure(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bg },
  loadingText: { marginTop: 12, color: COLORS.textMuted, fontWeight: '600' },
  errorText: { color: COLORS.danger, fontWeight: '600', paddingHorizontal: 24, textAlign: 'center' },
  glassWrap: { borderRadius: 24, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 14, elevation: 8 },
  glassLight: { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', backgroundColor: 'rgba(140,142,148,0.22)' },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  topBarRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8 },
  brandPill: { paddingHorizontal: 16, paddingVertical: 10 },
  brandText: { fontSize: 17, fontWeight: '800', color: COLORS.primary },
  rightColumn: { position: 'absolute', right: 16, alignItems: 'center', gap: 14 },
  sideBtnGroup: { width: SIDE_BTN_SIZE, borderRadius: 28, overflow: 'hidden', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  sideBtnSingle: { width: SIDE_BTN_SIZE, height: SIDE_BTN_SIZE, borderRadius: 28, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  sideBtn: { width: SIDE_BTN_SIZE, height: SIDE_BTN_SIZE, alignItems: 'center', justifyContent: 'center' },
  sideDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.7)' },
  midLeftIcons: { alignItems: 'center', justifyContent: 'center' },
  midLeftSearchIcon: { marginTop: 1 },
  badge: { position: 'absolute', top: -4, right: -4, minWidth: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderWidth: 2, borderColor: COLORS.white },
  badgeText: { color: COLORS.white, fontSize: 11, fontWeight: '800' },
  powerBtnWrap: { position: 'absolute', top: 130, left: 20, borderRadius: 32, overflow: 'hidden', borderWidth: 1.5, borderColor: 'rgba(255,90,44,0.6)', shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.5, shadowRadius: 12, elevation: 8 },
  powerBtn: { width: 64, height: 64, backgroundColor: 'rgba(255,90,44,0.55)', alignItems: 'center', justifyContent: 'center' },
  bottomArea: { position: 'absolute', left: TRACK_PADDING, right: TRACK_PADDING },
  track: { height: 78, borderRadius: 39, justifyContent: 'center', shadowColor: COLORS.primary, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 16, elevation: 10, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' },
  trackOff: { backgroundColor: COLORS.primary, borderColor: COLORS.primaryDark },
  knob: { position: 'absolute', left: 5, width: KNOB_SIZE, height: KNOB_SIZE, borderRadius: KNOB_SIZE / 2, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 6, elevation: 8, borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)' },
  trackOffTextWrap: { position: 'absolute', left: KNOB_SIZE + 18, right: 16 },
  trackOffLabel: { fontSize: 12, color: 'rgba(255,255,255,0.85)', fontWeight: '700', letterSpacing: 0.3 },
  trackOffTitle: { fontSize: 19, color: COLORS.white, fontWeight: '800', marginTop: 1 },
  orderOverlay: { position: 'absolute', left: 0, right: 0 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, overflow: 'hidden', borderTopWidth: 1.5, borderLeftWidth: 1.5, borderRightWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(22,24,29,0.2)', alignSelf: 'center', marginBottom: 16 },
  searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginBottom: 20, gap: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },
  searchInput: { flex: 1, fontSize: 16, color: COLORS.dark },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  gridItem: { width: '48%', borderRadius: 16, marginBottom: 12, overflow: 'hidden' },
  gridItemTouchable: { paddingVertical: 18, alignItems: 'center', gap: 8 },
  gridLabel: { fontSize: 13, fontWeight: '700', color: COLORS.dark },
  gridItemActive: { borderWidth: 1.5, borderColor: COLORS.primary },
  locationSettingsLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 4, paddingVertical: 8 },
  locationSettingsLinkText: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600' },
  locSettingRow: { backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)' },
  locSettingLabel: { fontSize: 13, fontWeight: '800', color: COLORS.dark, marginBottom: 4 },
  locSettingAddress: { fontSize: 12, color: COLORS.textMuted, marginBottom: 10 },
  locSettingBtn: { backgroundColor: COLORS.primary, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  locSettingBtnText: { fontSize: 13, fontWeight: '700', color: COLORS.white },
  poolSheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, maxHeight: '70%', overflow: 'hidden', borderTopWidth: 1.5, borderLeftWidth: 1.5, borderRightWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)' },
  poolTitle: { fontSize: 22, fontWeight: '800', color: COLORS.dark },
  poolSubtitle: { fontSize: 13, color: COLORS.textMuted, marginTop: 4, marginBottom: 8 },
  poolList: { marginTop: 8 },
  poolEmpty: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  poolEmptyText: { fontSize: 14, color: COLORS.textMuted, fontWeight: '600' },
  readyCard: { backgroundColor: COLORS.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: READY_CARD_PADDING, paddingBottom: 36 },
  readyTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  readyStageLabel: { fontSize: 13, color: COLORS.textMuted, fontWeight: '600' },
  readyCancelLink: { fontSize: 13, color: COLORS.danger, fontWeight: '700' },
  readyHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  readyPrice: { fontSize: 26, fontWeight: '900', color: COLORS.dark },
  readyTariffPill: { backgroundColor: COLORS.gray, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10 },
  readyTariffText: { fontSize: 12, fontWeight: '700', color: COLORS.dark },
  readyDivider: { height: 1, backgroundColor: COLORS.border, marginVertical: 14 },
  readyRouteRow: { flexDirection: 'row', gap: 12 },
  readyRouteIcons: { alignItems: 'center', paddingTop: 4 },
  readyRouteDot: { width: 10, height: 10, borderRadius: 5 },
  readyRouteLine: { width: 2, flex: 1, minHeight: 20, backgroundColor: COLORS.border, marginVertical: 4 },
  readyRouteTexts: { flex: 1 },
  readyRouteAddress: { fontSize: 15, fontWeight: '600', color: COLORS.dark },
  readyRouteGap: { height: 16 },
  readyPackageText: { fontSize: 13, color: COLORS.dark, fontWeight: '600', marginTop: 12 },
  readyCustomerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  readyCustomerAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  readyCustomerInfo: { flex: 1 },
  readyCustomerName: { fontSize: 15, fontWeight: '700', color: COLORS.dark },
  readyDistanceText: { fontSize: 12, color: COLORS.textMuted, fontWeight: '600', marginTop: 2 },
  readyCallBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.success, alignItems: 'center', justifyContent: 'center' },
  startTrack: { height: 64, borderRadius: 32, justifyContent: 'center', backgroundColor: COLORS.primary, marginTop: 18, overflow: 'hidden' },
  startTrackTextWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  startTrackTitle: { fontSize: 17, color: COLORS.white, fontWeight: '800' },
  startKnob: { position: 'absolute', left: 5, width: START_KNOB_SIZE, height: START_KNOB_SIZE, borderRadius: START_KNOB_SIZE / 2, backgroundColor: COLORS.white, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 5, elevation: 6 },
  speedBadge: { position: 'absolute', left: 16, width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 },
  speedValue: { fontSize: 20, fontWeight: '800', color: COLORS.dark },
  speedUnit: { fontSize: 10, fontWeight: '700', color: COLORS.textMuted, marginTop: -2 },
  summaryOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  summaryCard: { width: '100%', maxWidth: 420, backgroundColor: COLORS.white, borderRadius: 24, padding: 24 },
  summaryTitle: { fontSize: 22, fontWeight: '900', color: COLORS.dark, textAlign: 'center', marginBottom: 14 },
  summaryDivider: { height: 1, backgroundColor: COLORS.border, marginVertical: 10 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  summaryLabel: { fontSize: 15, color: COLORS.textMuted, fontWeight: '600' },
  summaryValue: { fontSize: 17, color: COLORS.dark, fontWeight: '700' },
  summaryTotalLabel: { fontSize: 14, color: COLORS.textMuted, fontWeight: '600', marginTop: 6, textAlign: 'center' },
  summaryTotalValue: { fontSize: 36, color: COLORS.primary, fontWeight: '900', textAlign: 'center', marginTop: 4, marginBottom: 22 },
  summaryBtnRow: { flexDirection: 'row', gap: 12 },
  summaryBtnLight: { flex: 1, backgroundColor: '#F4F4F6', borderRadius: 16, paddingVertical: 16, alignItems: 'center', borderWidth: 1, borderColor: '#E8E8EC' },
  summaryBtnLightText: { fontSize: 15, fontWeight: '800', color: COLORS.dark },
  summaryBtnPrimary: { flex: 1, backgroundColor: COLORS.success, borderRadius: 16, paddingVertical: 16, alignItems: 'center' },
  summaryBtnPrimaryText: { fontSize: 15, fontWeight: '800', color: COLORS.white },
  notifItem: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  notifItemTitle: { fontSize: 15, fontWeight: '800', color: COLORS.dark, marginBottom: 4 },
  notifItemImage: { width: '100%', height: 140, borderRadius: 12, marginBottom: 8, backgroundColor: '#F4F4F6' },
  notifItemText: { fontSize: 13, color: COLORS.dark, lineHeight: 19, marginBottom: 6 },
  notifItemTime: { fontSize: 11, color: COLORS.textMuted, fontWeight: '600' },
});