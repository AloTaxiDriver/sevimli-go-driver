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
import { blockedMessage, useAuth } from './context/AuthContext';
import { MOCK_HEAT_POINTS, getHeatColor } from './data/heatmapData';
import { Order } from './data/mockOrders';
import { COLORS } from './theme/colors';
import { estimateDurationMin, getDistanceKm } from './utils/distance';
import {
  ACTIVE_ORDER_STATUSES,
  DispatcherNotification, FirestoreOrder, OrderAlreadyTakenError, acceptOrder, cancelOrder, computeTieredDistanceSurcharge, ensureOverlayPermission, fetchActiveOrderForDriver, fetchOrderById, fetchTariffWaitRates, finalizeOrderPrice, firestoreOrderToOrder, mapDocToOrder,
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
import { activeTripStorageKey } from './utils/sessionKeys';
import { addTripPoint, resumeTripMeter, startTripMeter } from './utils/tripMeter';
import { billableWaitMinutes, computeWaitCharge } from './utils/waitCharge';

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

// AVTOMATIK KUTISH chegaralari. Mashina shu tezlikdan sekin bo'lsa
// "to'xtagan" deb hisoblanadi, lekin taymer DARHOL yonmaydi — 60
// soniya kutiladi. Aks holda har svetofor, har chorraha kutish deb
// yozilib, mijoz tirbandlik uchun pul to'lardi.
//
// Yonish va o'chish chegaralari ATAYLAB har xil (3 va 5 km/soat):
// bitta chegara bo'lsa, GPS shovqini tufayli taymer sekin
// harakatda yonib-o'chib turardi.
const AUTO_WAIT_AFTER_MS = 60 * 1000;
const AUTO_WAIT_STOP_KMH = 3;
const AUTO_WAIT_MOVE_KMH = 5;

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
  /** Yig'ilgan kutish (soniya) — taymer o'chirilgan oraliqlar. */
  waitAccumSec?: number;
  /** Taymer YONIQ bo'lsa — qachon yoqilgani (ms). Soniyalab sanash
   * o'rniga vaqt belgisi saqlanadi: ekran o'chsa ham, ilova yopilsa
   * ham hisob buzilmaydi. */
  waitStartedAt?: number | null;
  /** Snapshot qachon yozilgani. Ilova yopiq turgan vaqtda dispetcher
   * buyurtmani orqaga qaytargan bo'lishi mumkin — juda eski snapshot
   * o'sha o'zgarishni bosib ketmasligi uchun kerak. */
  savedAt?: number;
};

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

// Tarmoq bir lahzaga uzilgani uchun jonli safarni yo'qotmaslik kerak:
// Firestore so'rovi o'tmasa qayta uriniladi (2s, keyin 4s kutib).
const TRIP_RESTORE_ATTEMPTS = 3;
const TRIP_RESTORE_RETRY_MS = 2000;

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
//
// `ready_to_start` ham olib ketish nuqtasini ko'rsatadi. Avval u
// ro'yxatda yo'q edi: buyurtma qabul qilingandan keyin, haydovchi
// "Yo'lga chiqdim"ni surmaguncha xaritada MIJOZ UMUMAN KO'RINMASDI —
// na yo'l chizig'i, na belgi. Ya'ni haydovchi qayerga borishini
// bilmasdan turib surishga majbur edi (yoki buyurtmani bekor
// qilardi). Holbuki bu bosqichda nuqta allaqachon ma'lum.
function computeRouteTarget(
  order: Order | null,
  stage: TripStage,
  leg: 1 | 2
): Coords | null {
  if (!order) return null;
  if (stage === 'ready_to_start' || stage === 'to_pickup') return order.pickupLocation ?? null;
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
  // "Fon rejimida joylashuv" tushuntirish oynasi ochiq turgan vaqt
  // ichida (haydovchi o'qiyapti — bu bir necha soniya) haydovchi
  // "Ishni tugatish"ni bosgan bo'lishi mumkin. Javob ishlovchisi esa
  // `isOnline`ni O'Z RENDERIDAGI qiymatidan o'qiydi, ya'ni oyna
  // ochilgan paytdagi eski qiymatdan — va oflayn haydovchida kuzatuv
  // xizmatini yoqib yuborardi. Ref har doim eng oxirgi qiymatni
  // ko'rsatadi.
  const isOnlineRef = useRef(false);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);
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
  // Firestore javob bermagani uchun "safar bormi yo'qmi" savoli
  // JAVOBSIZ qolgan holat. Bunda hech narsa o'chirilmaydi (yozuv
  // qurilmada qoladi), lekin YANGI buyurtma ham olinmaydi — aks holda
  // haydovchida bir vaqtda ikkita tugallanmagan safar bo'lib qolardi.
  const [tripStateUnknown, setTripStateUnknown] = useState(false);
  // Tiklashni qayta urinish uchun hisoblagich (o'zgarganda tiklash
  // effekti qaytadan ishga tushadi).
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  const [showTripSummary, setShowTripSummary] = useState(false);
  // Safarni yakunlash yozuvi ketayotgan payt — tugma bloklanadi,
  // aks holda haydovchi bir necha marta bosib, bir nechta yozuv
  // yuborishi mumkin.
  const [finishingTrip, setFinishingTrip] = useState(false);
  // "Haydash rejimi" uchun: joriy tezlik (km/h) va yo'nalish (heading,
  // 0-360°) — GPS orqali watchPositionAsync ichida yangilanadi
  const [speedKmh, setSpeedKmh] = useState(0);
  const [heading, setHeading] = useState<number | undefined>(undefined);
  // Safar (in_progress) davomida bosib o'tilgan haqiqiy masofa — narxni
  // jonli hisoblash uchun. tripStageRef watchPositionAsync ichidagi
  // "qotib qolgan" closure muammosini oldini olish uchun kerak (u
  // effekt faqat bir marta, bo'sh deps bilan ishga tushadi).
  //
  // MUHIM: masofaning O'ZI endi bu yerda hisoblanmaydi — u
  // `utils/tripMeter` da, chunki fon rejimidagi joylashuv vazifasi ham
  // aynan shu hisoblagichga nuqta beradi (ekran o'chganda yo'l
  // yo'qolmasligi uchun). Bu yerdagilar — faqat ko'rsatish uchun nusxa.
  const [liveTripDistanceKm, setLiveTripDistanceKm] = useState(0);
  const tripStageRef = useRef<TripStage>(null);
  const tripDistanceRef = useRef(0);
  // Safar holati tiklanguncha (yoki tiklanadigan safar yo'qligi
  // aniqlanguncha) true — shu vaqt ichida yangi buyurtmani qabul qilish
  // effekti kutib turadi, aks holda tiklanayotgan safar ustiga yangi
  // buyurtma tushib qolishi mumkin.
  // KUTISH HISOBI. Jami = `waitAccumSec` + (taymer yoniq bo'lsa
  // hozirgacha o'tgan vaqt). Ref'lar GPS callback'i uchun — u bo'sh
  // deps bilan bir marta yaratiladi va holatni ko'ra olmaydi.
  const [waitAccumSec, setWaitAccumSec] = useState(0);
  const [waitStartedAt, setWaitStartedAt] = useState<number | null>(null);
  const waitAccumRef = useRef(0);
  const waitStartedAtRef = useRef<number | null>(null);
  // Avtomatik rejimda: mashina qachondan beri to'xtab turibdi.
  const stoppedSinceRef = useRef<number | null>(null);
  const waitingModeRef = useRef<'manual' | 'automatic'>('manual');
  // Taymer yonib turganda ekrandagi raqam har soniyada yangilanishi
  // uchun. Taymer o'chiq bo'lsa umuman ishlamaydi.
  const [waitTick, setWaitTick] = useState(() => Date.now());
  // Buyurtmada kutish narxi yo'q bo'lsa (mijoz ilovasidan kelgan yoki
  // eski buyurtma) — tarifdan o'qiladi.
  const [tariffWait, setTariffWait] = useState<{ freeWaitMin: number; waitPerMin: number } | null>(
    null
  );
  const [restoringTrip, setRestoringTrip] = useState(true);
  const tripRestoreStartedRef = useRef<number | null>(null);
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
  //
  // MUHIM: ref RENDER PAYTIDA emas, effekt ichida yangilanadi. Render
  // funksiyasi "sof" bo'lishi kerak — React uni bekor qilishi yoki
  // ekranga chiqarmasdan qayta chaqirishi mumkin, va o'shanda ref
  // ko'rsatilmagan holatga ishora qilib qolardi. Hozircha zararsiz,
  // lekin bu — jimgina buziladigan turdagi xato.
  // GPS callback'i bo'sh deps bilan BIR MARTA yaratiladi, ya'ni u
  // render paytidagi funksiyalarni ko'ra olmaydi (ular har renderda
  // yangidan tug'iladi). Shuning uchun avtomatik kutish shu tutqich
  // orqali chaqiriladi — .current har renderda yangilanadi.
  const waitControl = useRef({ begin: () => {}, end: () => {} });
  // ADMIN BLOKLAGANDA. AuthContext haydovchi hujjatini jonli
  // tinglaydi, ya'ni blok telefonga DARHOL yetib keladi — haydovchi
  // ilovani qayta ochishini kutish shart emas.
  //
  // Joriy safar ATAYLAB to'xtatilmaydi: mijoz mashinada bo'lishi
  // mumkin va uni yo'lda qoldirib bo'lmaydi. Yangi buyurtma esa
  // kelmaydi — onlayn holat va push tokeni o'chiriladi.
  const blockNoticeShown = useRef(false);
  const writeTripSnapshot = useRef(() => {});
  useEffect(() => {
    waitControl.current = { begin: beginWaiting, end: endWaiting };
  });
  useEffect(() => {
    waitingModeRef.current =
      activeOrder?.waitingMode === 'automatic' ? 'automatic' : 'manual';
  }, [activeOrder]);
  // Taymer yonganda: ekrandagi raqamni har soniyada yangilaymiz va
  // holatni qurilmaga yozib turamiz.
  //
  // MUHIM: kutish davomida mashina qimirlamaydi, ya'ni GPS callback'i
  // snapshotni YOZMAYDI (u faqat masofa o'zgarganda yozadi). Shu
  // sababli yozuvni aynan shu yerdan qilamiz — aks holda ilova
  // yopilib qolsa, kutish qayerdan uzilganini bilmay qolardik.
  useEffect(() => {
    if (waitStartedAt == null) return;
    const iv = setInterval(() => {
      setWaitTick(Date.now());
      if (Date.now() - lastTripPersistAtRef.current > 10000) {
        lastTripPersistAtRef.current = Date.now();
        writeTripSnapshot.current();
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [waitStartedAt]);
  useEffect(() => {
    writeTripSnapshot.current = () => {
      const orderId = activeOrderSourceId.current;
      const stage = tripStageRef.current;
      if (!orderId || !stage) return;
      const snapshot: ActiveTripSnapshot = {
        orderId,
        tripStage: stage,
        activeLeg: activeLegRef.current,
        tripDistanceKm: tripDistanceRef.current,
        waitAccumSec: waitAccumRef.current,
        waitStartedAt: waitStartedAtRef.current,
        savedAt: Date.now(),
      };
      AsyncStorage.setItem(activeTripStorageKey(driverId), JSON.stringify(snapshot)).catch(() => {});
    };
  });

  function clearTripSnapshot() {
    resetWaiting();
    lastTripPersistAtRef.current = 0;
    // MUHIM: yozuvchi AYNAN shu ikki ref'ga qarab ishlaydi va u React
    // render siklidan MUSTAQIL — GPS callback'idan chaqiriladi. Ularni
    // shu yerda tozalamasak, o'chirishdan keyin kelgan birinchi GPS
    // signali snapshotni QAYTA yozib qo'yardi.
    //
    // Yuqoridagi `lastTripPersistAtRef = 0` buni yanada ehtimolli
    // qiladi: u "oxirgi yozuvdan 10 soniya o'tdi" degan shartni darhol
    // bajarib qo'yadi, ya'ni keyingi signal KUTMASDAN yozadi.
    //
    // Oqibati: safar tugagan yoki bekor qilingan bo'lsa ham qurilmada
    // uning snapshoti qolib ketardi va ilova keyingi ochilishida
    // allaqachon yopilgan safarni tiklashga urinardi.
    //
    // Chaqiruvchi joylarda bu ref'lar baribir tozalanadi, lekin uchtasida
    // KEYINROQ — oradagi bo'shliq esa aynan shu poygani ochib berardi.
    // Shuning uchun tozalash shu yerda, o'chirish bilan BIRGA.
    activeOrderSourceId.current = null;
    tripStageRef.current = null;
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
    // MUHIM: `tripRestoreStartedRef` avval oddiy "bir marta" bayrog'i
    // edi. Endi u QAYSI urinish bajarilganini saqlaydi — tarmoq
    // tiklanganda tiklashni qaytadan urinib ko'rish uchun.
    if (tripRestoreStartedRef.current === restoreAttempt) return;
    tripRestoreStartedRef.current = restoreAttempt;

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
        //
        // MUHIM: so'rov MUVAFFAQIYATSIZ tugagani ("bilmadim") va safar
        // haqiqatan yo'qligi ("yo'q") — ikki boshqa javob. Avval ikkalasi
        // ham `null` bo'lib kelardi, va pastdagi blok ikkinchisi deb
        // o'ylab qurilmadagi safar yozuvini o'chirib tashlardi. Ya'ni
        // ilova ochilgan lahzada internet uzuq bo'lsa (metroda, lift
        // ichida, tarmoq almashayotganda) JONLI SAFAR YO'QOLARDI:
        // "Safarni yakunlash" hech narsa qilmasdi, buyurtma dispetcherda
        // "qabul qilingan" bo'lib osilib qolardi, haydovchi esa puliga
        // ham, komissiyasiga ham hisob berolmasdi.
        //
        // Endi so'rov o'tmasa BIR NECHA MARTA qayta uriniladi (tarmoq
        // odatda bir necha soniyada qaytadi), va baribir o'tmasa —
        // HECH NARSAGA TEGILMAYDI. Yozuv qurilmada qoladi, ilova
        // keyingi ochilishida safar tiklanadi.
        let fo: FirestoreOrder | null = null;
        let lookupFailed = false;
        for (let attempt = 1; attempt <= TRIP_RESTORE_ATTEMPTS; attempt++) {
          lookupFailed = false;
          if (snapshot?.orderId) {
            const byId = await fetchOrderById(snapshot.orderId);
            if (byId.failed) lookupFailed = true;
            fo = byId.order;
            // Snapshot eskirgan bo'lishi mumkin: buyurtma allaqachon
            // yakunlangan/bekor qilingan yoki boshqa haydovchiga o'tgan.
            if (fo && (fo.driverId !== driverId || !ACTIVE_ORDER_STATUSES.includes(fo.status))) {
              fo = null;
            }
          }
          if (!fo) {
            const byDriver = await fetchActiveOrderForDriver(driverId);
            if (byDriver.failed) lookupFailed = true;
            fo = byDriver.order;
          }
          if (fo || !lookupFailed) break;
          console.warn(
            `Safarni tiklash: ${attempt}-urinish o'tmadi (tarmoq) — qayta urinamiz`
          );
          await new Promise((r) => setTimeout(r, TRIP_RESTORE_RETRY_MS * attempt));
        }
        // Boshqa buyurtma topilgan bo'lsa, snapshotdagi mahalliy
        // tafsilotlar (masofa, oyoq) unga tegishli emas.
        if (fo && snapshot && fo.id !== snapshot.orderId) snapshot = null;

        if (!fo && lookupFailed) {
          console.warn(
            'Safarni tiklash: Firestore javob bermadi — qurilmadagi safar ' +
              'yozuviga TEGILMADI, 30 soniyadan keyin qayta uriniladi'
          );
          // MUHIM: `restoringTrip` pastdagi `finally` da baribir false
          // bo'ladi (aks holda haydovchi umuman ishlay olmasdi), lekin
          // `tripStageRef` null bo'lib qolgani uchun "ikkinchi buyurtma"
          // qo'riqchilari o'tib ketardi: haydovchi yangi buyurtma olsa,
          // eskisi Firestore'da abadiy "accepted" bo'lib osilib qolardi.
          // Shuning uchun holat ANIQLANGUNCHA yangi buyurtma olinmaydi.
          setTripStateUnknown(true);
          return;
        }
        setTripStateUnknown(false);

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

        // MUHIM: tiklash cho'zilib ketgan bo'lishi mumkin (sekin tarmoq,
        // qayta urinishlar). 20 soniyalik zaxira chegara esa shu orada
        // `restoringTrip`ni false qilib, haydovchiga YANGI buyurtma
        // qabul qilishga yo'l ochib qo'yadi. Kech qaytgan tiklash o'sha
        // yangi buyurtmani ekranda bosib ketardi: haydovchi qabul qilgan
        // buyurtma yo'qolib, o'rniga eskisi paydo bo'lardi.
        //
        // Shu sababli qo'llashdan oldin oxirgi marta tekshiramiz: ekranda
        // allaqachon BOSHQA safar bormi.
        if (activeOrderSourceId.current && activeOrderSourceId.current !== fo.id) {
          console.warn(
            `Safarni tiklash kech qaytdi: ekranda allaqachon ${activeOrderSourceId.current} ` +
              `buyurtmasi bor — ${fo.id} qo'llanmadi`
          );
          return;
        }

        activeOrderSourceId.current = fo.id;
        // Aks holda o'sha buyurtma push/overlay orqali qayta "qabul
        // qilinishi" mumkin edi.
        processedAcceptId.current = fo.id;
        startWatchingOrderCancellation(fo.id);
        const restoredOrder = firestoreOrderToOrder(fo);
        setActiveOrder(restoredOrder);
        setActiveLeg(snapshot?.activeLeg === 2 ? 2 : 1);
        setIsOnline(true);
        setTripStage(stage);
        startPan.setValue(0);
        // Mijoz allaqachon mashinada bo'lsa (in_progress), olib ketish
        // nuqtasi haqida ogohlantirishning ma'nosi yo'q.
        if (stage !== 'in_progress') warnIfPickupHasNoCoordinates(restoredOrder);

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

        // Kutish hisobini tiklaymiz.
        //
        // MUHIM: taymer YONIQ holatda ilova o'lgan bo'lsa, uni yoniq
        // holda tiklamaymiz. Oraliq faqat snapshot oxirgi marta
        // yozilgan paytgacha yopiladi — ya'ni biz FAQAT ilova tirik
        // ekanini bilgan vaqtimiz uchun pul olamiz. Ilova qancha
        // yopiq turganini bilmaymiz va uni mijozga yozib qo'yish
        // to'g'ri bo'lmasdi. Haydovchi hali ham kutayotgan bo'lsa,
        // tugmani qayta bosadi (avtomatik rejimda o'zi yonadi).
        const savedAccum =
          typeof snapshot?.waitAccumSec === 'number' ? snapshot.waitAccumSec : 0;
        const savedStarted =
          typeof snapshot?.waitStartedAt === 'number' ? snapshot.waitStartedAt : null;
        const knownUntil =
          typeof snapshot?.savedAt === 'number' ? snapshot.savedAt : savedStarted;
        const restoredWait =
          savedStarted != null && knownUntil != null
            ? savedAccum + Math.max(0, (knownUntil - savedStarted) / 1000)
            : savedAccum;
        waitAccumRef.current = restoredWait;
        waitStartedAtRef.current = null;
        stoppedSinceRef.current = null;
        setWaitAccumSec(restoredWait);
        setWaitStartedAt(null);

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
          // Hisoblagichning o'z yozuvi snapshot'dan ishonchliroq:
          // snapshot har 10 soniyada bir yozilardi, hisoblagich esa har
          // bir qabul qilingan nuqtada (fon vazifasidan kelgani ham).
          // Ikkalasining kattarog'i olinadi.
          const meterKm = await resumeTripMeter(fo.id, restoredKm);
          tripDistanceRef.current = meterKm;
          setLiveTripDistanceKm(meterKm);
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
  }, [driverId, restoreAttempt]);

  // Holat noma'lum bo'lsa — har 30 soniyada qayta urinamiz. Tarmoq
  // odatda tez qaytadi, va haydovchi hech narsa qilmasdan ishlay
  // boshlaydi.
  useEffect(() => {
    if (!tripStateUnknown) return;
    const iv = setInterval(() => setRestoreAttempt((n) => n + 1), 30000);
    return () => clearInterval(iv);
  }, [tripStateUnknown]);

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
      // MUHIM: keshdagi nuqta DARHOL qo'llaniladi. Avval u shunchaki
      // o'zgaruvchiga solib qo'yilardi, ekran esa `getCurrentPositionAsync`
      // TUGAGUNCHA kutardi — o'sha chaqiruvda esa vaqt chegarasi YO'Q.
      // Yerto'lada yoki "sovuq" GPS bilan u 20-40 soniya osilib turadi
      // va shu vaqt ichida:
      //   * haydovchi "Joylashuv aniqlanmoqda" ekranida qotib qoladi
      //     (xaritani ham ko'rmaydi);
      //   * buyurtmani qabul qilish effekti `location`ni kutgani uchun
      //     Firestore'ga YOZILMAYDI — ya'ni haydovchi overlay'dagi
      //     "Qabul qilish"ni bosgan bo'lsa ham, taklif navbati undan
      //     o'tib ketib, buyurtma boshqasiga berilishi mumkin.
      // Ya'ni izohda yozilgan "DARHOL qaytadi" niyati kodda amalga
      // oshmagan edi. Endi keshdagi nuqta bilan ekran shu zahoti
      // ochiladi, aniqrog'i esa kelganda o'rnini egallaydi.
      let initial: { latitude: number; longitude: number } | null = null;
      try {
        const known = await Location.getLastKnownPositionAsync();
        if (known) {
          initial = { latitude: known.coords.latitude, longitude: known.coords.longitude };
          setLocation(initial);
          setCurrentRegion({ ...initial, latitudeDelta: 0.05, longitudeDelta: 0.05 });
          setLoading(false);
        }
      } catch {
        // Keshda nuqta yo'q — muammo emas, pastda aniqrog'ini olamiz.
      }
      try {
        const current = await Location.getCurrentPositionAsync({});
        const fresh = { latitude: current.coords.latitude, longitude: current.coords.longitude };
        initial = fresh;
        setLocation(fresh);
        // Kamerani faqat BIRINCHI nuqtada joylashtiramiz — keshdagi
        // nuqta allaqachon qo'llangan bo'lsa, xaritani sakratmaymiz.
        setCurrentRegion((prev) =>
          prev ? prev : { ...fresh, latitudeDelta: 0.05, longitudeDelta: 0.05 }
        );
      } catch (e) {
        console.warn('Joriy joylashuvni aniqlab bo\'lmadi:', e);
      }

      if (!initial) {
        setErrorMsg('Joylashuv aniqlanmadi — GPS yoqilganini tekshiring');
        setRestoringTrip(false);
      }
      setLoading(false);

      locationSubscription.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 10 },
        (update) => {
          const newCoord = { latitude: update.coords.latitude, longitude: update.coords.longitude };
          // GPS ishlay boshladi — boshlanishdagi "aniqlanmadi" xabari
          // endi yolg'on. Bo'sh bo'lsa tegilmaydi (behuda qayta chizish
          // bo'lmasin uchun).
          setErrorMsg((prev) => (prev ? '' : prev));
          // MUHIM: har GPS signalida uchala holat SO'ZSIZ yangilanardi
          // va MapScreen — ilovaning eng katta komponenti — butunlay
          // qayta chizilardi. Signal esa qimirlamay turganda ham
          // keladi, ya'ni ekran bir xil raqamlar bilan behuda qayta
          // chizilib turardi (batareya va issiqlik).
          //
          // Endi holat FAQAT haqiqatan o'zgarganda yoziladi. Bir xil
          // qiymatda avvalgi obyektning O'ZI qaytariladi — React buni
          // "o'zgarish yo'q" deb tushunib, qayta chizishni butunlay
          // o'tkazib yuboradi.
          setLocation((prev) =>
            prev && prev.latitude === newCoord.latitude && prev.longitude === newCoord.longitude
              ? prev
              : newCoord
          );
          // speed m/s da keladi, ba'zan noma'lum bo'lsa -1/null bo'lishi
          // mumkin — shunday holatda 0 deb olamiz. Ekranda u butun son
          // bo'lib ko'rsatiladi, shuning uchun solishtirish ham
          // yaxlitlangan qiymat bo'yicha.
          const speedMs = update.coords.speed;
          const nextSpeed = speedMs != null && speedMs > 0 ? speedMs * 3.6 : 0;
          setSpeedKmh((prev) => (Math.round(prev) === Math.round(nextSpeed) ? prev : nextSpeed));
          const hdg = update.coords.heading;
          const nextHeading = hdg != null && hdg >= 0 ? hdg : undefined;
          setHeading((prev) =>
            (prev === undefined && nextHeading === undefined) ||
            (prev !== undefined && nextHeading !== undefined && Math.round(prev) === Math.round(nextHeading))
              ? prev
              : nextHeading
          );

          // AVTOMATIK KUTISH — mashina to'xtab qolsa taymer o'zi yonadi.
          // Faqat dispetcher filialda shu rejimni tanlagan bo'lsa.
          if (tripStageRef.current === 'in_progress' && waitingModeRef.current === 'automatic') {
            if (nextSpeed < AUTO_WAIT_STOP_KMH) {
              if (stoppedSinceRef.current == null) {
                stoppedSinceRef.current = Date.now();
              } else if (Date.now() - stoppedSinceRef.current >= AUTO_WAIT_AFTER_MS) {
                waitControl.current.begin();
              }
            } else if (nextSpeed >= AUTO_WAIT_MOVE_KMH) {
              stoppedSinceRef.current = null;
              waitControl.current.end();
            }
          }

          // Faqat "in_progress" bosqichida (mijoz mashinada, safar
          // boshlangan) masofani yig'amiz.
          //
          // MUHIM: shovqin filtri AVVAL shu yerda edi va u yo'lning
          // katta qismini yeb qo'yardi:
          //
          //     if (deltaKm > 0.02 && deltaKm < 1.5) { ...qo'shamiz... }
          //     lastTripPointRef.current = newCoord;   // <-- HAR DOIM
          //
          // 20 metrdan kichik bo'lak hisobga olinmas, lekin langar
          // BARIBIR ko'chirilardi. GPS har 3 soniyada keladi: shahar
          // tezligida (15–20 km/soat) bu 12–17 metr, ya'ni deyarli
          // HAR BIR bo'lak chegaradan pastda qolar va jimgina
          // yo'qolardi. Haydovchi 3 km yursa ham narx minimal tarifda
          // qotib turardi.
          //
          // Endi hisob `utils/tripMeter` da: chegaradan kichik bo'lakda
          // langar QOLDIRILADI va harakat to'planib boradi.
          if (tripStageRef.current === 'in_progress') {
            // `update.timestamp` ATAYLAB uzatiladi: fon vazifasi ham
            // nuqtaning GPS o'lchagan vaqtini beradi, ikkala oqim bir
            // xil vaqt o'lchoviga tayanishi kerak. Aks holda bittasi
            // "yetkazilgan payt", ikkinchisi "o'lchangan payt" bilan
            // ishlab, nuqtalar bir-birini eskirgan deb rad etardi.
            addTripPoint(
              newCoord.latitude,
              newCoord.longitude,
              update.coords.accuracy,
              update.timestamp
            )
              .then((km) => {
                // `null` — faol safar yo'q (masalan safar aynan shu
                // lahzada tiklanayapti). O'shanda ekrandagi masofaga
                // TEGILMAYDI, aks holda u bir zumga nolga tushardi.
                if (km == null || km === tripDistanceRef.current) return;
                tripDistanceRef.current = km;
                setLiveTripDistanceKm(km);
                // Bosib o'tilgan masofani vaqti-vaqti bilan qurilmaga
                // yozib boramiz (har 10 soniyada, ortiqcha yozuvni
                // oldini olish uchun) — ilova to'satdan yopilsa, safar
                // qayta ochilganda shu joydan davom etadi.
                const now = Date.now();
                if (now - lastTripPersistAtRef.current > 10000) {
                  lastTripPersistAtRef.current = now;
                  writeTripSnapshot.current();
                }
              })
              .catch(() => {});
          }
        }
      );
    })();
    return () => { locationSubscription.current?.remove(); };
  }, []);

  useEffect(() => {
    if (!driver?.blocked) {
      blockNoticeShown.current = false;
      return;
    }
    setIsOnline(false);
    setPoolVisible(false);
    setPendingAcceptId(null);
    // MUHIM: safar ustida bo'lsa kuzatuv TO'XTATILMAYDI. Aks holda
    // haydovchi safarni yakunlaguncha joylashuv yuborilmay, masofa
    // o'lchanmay qolardi va narx eng past tarifga qulardi — ya'ni
    // bloklash mijozga chegirma bo'lib chiqardi.
    if (tripStageRef.current === null) {
      stopDriverLocationTracking();
    }
    // `isOnline: false` + push tokenini o'chirish — panelda ham
    // oflayn ko'rinadi va telefonga yangi buyurtma bildirishnomasi
    // kelmaydi.
    saveDriverPushToken(driverId, null).catch(() => {});
    if (!blockNoticeShown.current) {
      blockNoticeShown.current = true;
      Alert.alert('Bloklandingiz', blockedMessage(driver.blockedReason));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driver?.blocked, driver?.blockedReason, driverId]);

  useEffect(() => {
    setTariffWait(null);
    const tariffId = activeOrder?.tariffId;
    // Buyurtmada narx BOR (hatto 0 bo'lsa ham) — o'shani ishlatamiz.
    // Safar boshlangandagi shartlar keyin o'zgarmasligi kerak.
    if (activeOrder?.waitPerMin != null || !tariffId) return;
    let alive = true;
    fetchTariffWaitRates(tariffId)
      .then((rates) => {
        if (alive && rates) setTariffWait(rates);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [activeOrder?.id, activeOrder?.tariffId, activeOrder?.waitPerMin]);

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
    // Oldingi safar bor-yo'qligi hali noma'lum — yangi buyurtma
    // olinmaydi (yuqoridagi `tripStateUnknown` izohiga qarang).
    if (tripStateUnknown) {
      Alert.alert(
        'Aloqa yo\'q',
        "Oldingi safaringiz holatini tekshirib bo'lmadi. Internet tiklangach avtomatik davom etadi."
      );
      setPendingAcceptId(null);
      return;
    }

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
          await revertOrderAcceptance(orderId, driverId).catch(() => {});
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
          await revertOrderAcceptance(orderId, driverId).catch(() => {});
          setPendingAcceptId(null);
          processedAcceptId.current = null;
          Alert.alert(
            'Balans yetarli emas',
            'Buyurtma qabul qilish uchun hisobingizni to\'ldiring. Buyurtma boshqa haydovchiga qaytarildi.'
          );
          return;
        }

        // MUHIM: buyurtma obyekti QO'LDA yig'ilardi va uchta maydon
        // tushib qolgan edi: `finalPrice`, `bonusUsed`, `extrasTotal`.
        // Ular aynan MIJOZ NAQD PULDA QANCHA TO'LASHINI belgilaydi.
        // Oqibati: mijoz ilovada 10 000 bonus ishlatgan bo'lsa,
        // haydovchi ekranida chegirmasiz narx turardi va u mijozdan
        // 10 000 KO'P so'rardi; qo'shimcha xizmatli buyurtmada esa
        // aksincha — KAM olardi. "Ochiq buyurtmalar"dan olingan
        // buyurtmalarda esa hammasi to'g'ri ko'rinardi (u yo'l
        // `mapDocToOrder` ishlatadi), shuning uchun farq tasodifiy
        // bo'lib tuyulardi.
        //
        // Endi shu bitta funksiya ishlatiladi — maydon qo'shilsa,
        // uchala yo'l ham uni birdaniga oladi.
        const fo: FirestoreOrder = { ...mapDocToOrder(doc), status: 'accepted', driverId };

        // ============================================================
        // BUYURTMANI QABUL QILISH — YAGONA YOZUV
        // ============================================================
        // MUHIM: avval bu qator `.catch(() => {})` bilan edi va izohda
        // "native overlay allaqachon yozib bo'lgan" deyilardi. Bu
        // NOTO'G'RI: native tomonda (plugins/overlay-native) Firestore
        // kodi umuman yo'q — u faqat ilovani deep-link bilan ochadi.
        // Ya'ni SHU qator yagona yozuv, va uning xatosi yutib
        // yuborilardi.
        //
        // Oqibati eng yomon holatda: taklif navbati shu haydovchidan
        // o'tib ketgan va buyurtmani BOSHQA haydovchi olgan bo'lsa,
        // `OrderAlreadyTakenError` jimgina yo'qolar, pastdagi kod esa
        // safarni baribir boshlab yuborardi. Ikki haydovchi bir mijozga
        // yo'l olardi; birinchisi "Yakunlash"ni bosganda esa
        // IKKINCHISINING buyurtmasi narxini qayta yozib, uni
        // yakunlangan qilib qo'yardi.
        try {
          await acceptOrder(orderId, driverId);
        } catch (error) {
          setPendingAcceptId(null);
          processedAcceptId.current = null;
          if (error instanceof OrderAlreadyTakenError) {
            Alert.alert('Kechikdingiz', 'Bu buyurtmani boshqa haydovchi allaqachon oldi.');
          } else {
            console.warn('Qabul qilishda xato:', error);
            Alert.alert(
              'Qabul qilinmadi',
              "Buyurtmani qabul qilib bo'lmadi. Internet aloqasini tekshirib, qayta urinib ko'ring."
            );
          }
          return;
        }

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
        warnIfPickupHasNoCoordinates(order);
        setDriverBusyStatus(driverId, true).catch(() => {});
        console.log('Buyurtma qabul qilindi, tasdiqlash ekrani ko\'rsatilmoqda');
      } catch (e) {
        console.warn('Qabul qilishda xato:', e);
        processedAcceptId.current = null;
      }
    })();
  }, [pendingAcceptId, location, driverId, restoringTrip, tripStateUnknown]);

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
    // MUHIM: `isOnline` ilova ochilganda HAR DOIM false'dan boshlanadi,
    // safar tiklanishi esa bir necha soniya davom etadi. Bu shart
    // qo'yilmaganda quyidagi "oflayn" shoxi DARHOL ishlab ketardi va
    // haydovchi hali safarda ekanida:
    //   * `pushToken: null` yozilardi — yangi buyurtma bildirishnomasi
    //     kelmay qolardi (token faqat qaytadan onlayn bo'lgandan keyin
    //     tiklanardi);
    //   * `isOnline: false` yozilardi — dispetcher panelida haydovchi
    //     "oflayn" bo'lib ko'rinardi;
    //   * kuzatuv xizmati to'xtatilardi — safar o'rtasida joylashuv
    //     yozilmay turadigan bo'shliq paydo bo'lardi.
    // Uchalasi ham bir necha soniyadan keyin tiklash tugab, `isOnline`
    // true bo'lgach o'ziga kelardi — lekin bu bo'shliq aynan eng nozik
    // paytga (ilova qulab qayta ochilishiga) to'g'ri kelardi.
    //
    // Tiklash tugamaguncha kutamiz. U har qanday holatda tugaydi:
    // topilsa `isOnline` true bo'ladi, topilmasa `restoringTrip` false
    // bo'lib shu yerdagi tozalash o'z navbatida ishlaydi.
    if (restoringTrip) return;
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
      // Tushuntirish oynasi ochiq qolgan bo'lsa yopamiz — u endi
      // ma'nosiz, va javob kelganda oflayn holatda kuzatuv boshlanib
      // ketishiga sabab bo'lardi.
      setBgLocationDisclosureVisible(false);
      return;
    }
    // MUHIM: token so'rash tarmoq ishi — u bir necha soniya davom
    // etishi mumkin. Shu vaqt ichida haydovchi "Ishni tugatish"ni yoki
    // "Chiqish"ni bosgan bo'lsa, javob KECHIKIB kelib tokenni QAYTA
    // yozib qo'yardi (`saveDriverPushToken` ayni paytda `isOnline: true`
    // ham yozadi). Natijada chiqib ketgan haydovchi panelda yana
    // "onlayn" bo'lib paydo bo'lardi va unga buyurtma bildirishnomalari
    // kelaverardi. `offline` — effekt tozalanganda yoqiladigan bayroq.
    let offline = false;
    registerForPushNotifications().then((token) => {
      if (offline || !isOnlineRef.current) return;
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
      const consent = await getBackgroundLocationConsent();
      // Bu ham kechikib qaytishi mumkin — o'sha vaqtda haydovchi
      // oflayn bo'lgan bo'lsa, na oyna ochiladi, na kuzatuv boshlanadi.
      if (offline || !isOnlineRef.current) return;
      if (consent === null) {
        setBgLocationDisclosureVisible(true);
        return;
      }
      startDriverLocationTracking(driverId);
    })();
    return () => {
      offline = true;
      stopDriverLocationTracking();
    };
  }, [isOnline, driverId, restoringTrip]);

  // Tushuntirish oynasidagi javob. Ikkala holatda ham kuzatuv
  // boshlanadi — farqi shundaki, rad etilsa `startDriverLocationTracking`
  // tizimdan fon ruxsatini SO'RAMAYDI, ya'ni ilova butunlay yopilganda
  // kuzatuv to'xtaydi.
  async function handleBgLocationDisclosure(accepted: boolean) {
    setBgLocationDisclosureVisible(false);

    // MUHIM (Google Play siyosati — 2026-08-19 da ilova aynan shu sabab
    // rad etilgan): tizimning ruxsat oynasi oshkora xabardan keyin
    // DARHOL chiqishi shart. Rad etish matni:
    //   "Запросы на согласие пользователя и динамические разрешения
    //    появляются не сразу после показа сообщения о раскрытии
    //    информации."
    //
    // Avval so'rov shu yerda emas, `beginTracking` ichida edi va unga
    // yetguncha oradan AsyncStorage yozuvi, kuzatuv navbati va yana
    // bitta AsyncStorage o'qishi o'tardi. Undan ham yomoni: beginTracking
    // foreground ruxsati bo'lmasa `return` qilardi, ya'ni tekshiruvchi
    // tushuntirishni qabul qilgani bilan tizim oynasini UMUMAN
    // ko'rmasdi.
    //
    // Shuning uchun so'rov endi shu yerda, boshqa HECH QANDAY await'dan
    // oldin. Foreground ruxsati bo'lmasa Android fon ruxsatini
    // ko'rsatmaydi, shuning uchun avval o'sha so'raladi — u ham tizim
    // oynasi, ya'ni zanjir uzilmaydi.
    if (accepted) {
      const foreground = await Location.getForegroundPermissionsAsync();
      if (!foreground.granted) {
        await Location.requestForegroundPermissionsAsync().catch(() => {});
      }
      await Location.requestBackgroundPermissionsAsync().catch(() => {});
    }

    await setBackgroundLocationConsent(accepted ? 'granted' : 'declined');
    // MUHIM: oyna ochiq turgan vaqt ichida haydovchi oflayn bo'lgan
    // bo'lishi mumkin — javobni o'qib, keyin "Ishni tugatish"ni bosgan
    // bo'lsa. Avval bu yerda shartsiz `startDriverLocationTracking`
    // chaqirilardi va xizmat oflayn holatda yonib ketardi.
    if (isOnlineRef.current) startDriverLocationTracking(driverId);
  }

  useEffect(() => {
    return listenToForegroundMessages((title, body) => {
      console.log('Push (foreground):', title, body);
    });
  }, []);

  const [routeDistanceKm, setRouteDistanceKm] = useState(0);
  const [routeDurationMin, setRouteDurationMin] = useState(0);
  const ROUTE_REFRESH_MS = 15000;
  // Joylashuv kelmagan yoki so'rov muvaffaqiyatsiz bo'lgan holatda
  // qisqaroq kutamiz — 15 soniya birinchi chizish uchun juda uzun.
  const ROUTE_RETRY_MS = 3000;

  // Joriy joylashuv effekt ICHIDA o'qiladi, unga BOG'LANMASDAN — sababi
  // pastdagi izohda. Ref effekt orqali yangilanadi (render paytida
  // emas).
  const routeLocationRef = useRef(location);
  useEffect(() => {
    routeLocationRef.current = location;
  }, [location]);

  // ============================================================
  // YO'L CHIZIG'I
  // ============================================================
  // MUHIM: bu effekt ATAYLAB `location` ga bog'lanmagan.
  //
  // Avval u `[..., location]` bilan ishlardi va ichida 15 soniyalik
  // cheklov bor edi. `location` esa har ~3 soniyada yangilanadi, ya'ni
  // effekt har 3 soniyada QAYTA ishga tushardi va tozalash funksiyasi
  // `cancelled = true` qilib, HALI JAVOB KUTAYOTGAN so'rovni bekor
  // qilardi. Yangi so'rov esa 15 soniyalik cheklov tufayli
  // yuborilmasdi. Natijada:
  //
  //   so'rov 3 soniyadan uzoq davom etsa — u HAR SAFAR bekor qilinadi
  //   va yo'l chizig'i UMUMAN chizilmaydi.
  //
  // Tez internetda so'rov 3 soniyagacha ulgurgani uchun hammasi
  // joyida ko'rinardi; sekin internetda esa xarita hech qachon yo'l
  // ko'rsatmasdi va buning sababi hech qayerda bilinmasdi.
  //
  // Endi so'rov faqat MANZIL o'zgarganda (buyurtma / bosqich / oyoq)
  // yoki ekran yopilganda bekor qilinadi. Haydovchining o'zi bir necha
  // metr siljigani — bekor qilish uchun sabab emas. Yangilanish esa
  // taymer bilan, so'rov TUGAGANIDAN keyin rejalashtiriladi, shuning
  // uchun sekin tarmoqda so'rovlar ustma-ust ham tushmaydi.
  useEffect(() => {
    const target = computeRouteTarget(activeOrder, tripStage, activeLeg);

    if (!target) {
      setRouteCoords([]); setRouteDistanceKm(0); setRouteDurationMin(0);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = setTimeout(fetchOnce, delayMs);
    };

    async function fetchOnce() {
      if (cancelled) return;
      const from = routeLocationRef.current;
      if (!from) {
        // GPS hali tayyor emas — chizishga boshlang'ich nuqta yo'q.
        schedule(ROUTE_RETRY_MS);
        return;
      }
      // getRoute o'zi xatoni yutadi va to'g'ri chiziq qaytaradi
      // (src/utils/routing.ts), lekin har ehtimolga qarshi.
      let result;
      try {
        result = await getRoute(from, target!);
      } catch (e) {
        console.warn("Yo'l chizig'ini olishda xato:", e);
        schedule(ROUTE_RETRY_MS);
        return;
      }
      if (cancelled) return;
      setRouteCoords(result.coordinates);
      if (result.distanceKm > 0) {
        setRouteDistanceKm(result.distanceKm);
        setRouteDurationMin(result.durationMin);
        schedule(ROUTE_REFRESH_MS);
      } else {
        // Marshrut xizmati javob bermadi (to'g'ri chiziq qaytdi) —
        // tezroq qayta urinamiz.
        schedule(ROUTE_RETRY_MS);
      }
    }

    fetchOnce();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripStage, activeOrder?.id, activeLeg]);

  const isNavigatingRef = useRef(false);
  // Boshlang'ich "fitToCoordinates" dan keyin, necha marta location
  // yangilanganini sanaymiz — birinchi 1-2 yangilanishda hali kamerani
  // "haydash rejimi"ga (heading+pitch) keskin burab yubormaslik uchun,
  // biroz o'tish vaqti beramiz
  const navUpdateCount = useRef(0);

  useEffect(() => {
    if (!activeOrder || !location || !mapRef.current) { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }
    if (tripStage !== 'to_pickup' && tripStage !== 'in_progress') { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }

    // (Bu yerda avval `target` hisoblanardi, lekin u hech qayerda
    // ishlatilmasdi — kamera haydovchining O'Z joylashuviga qaraydi.)
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

  // Buyurtma qabul qilingan zahoti xaritani shunday joylashtiramizki,
  // HAYDOVCHI ham, MIJOZ ham bir vaqtda ko'rinsin.
  //
  // Yuqoridagi "haydash rejimi" effekti `ready_to_start` bosqichida
  // ATAYLAB ishlamaydi (haydovchi hali yo'lga chiqmagan), shuning uchun
  // xarita o'sha paytda umuman qimirlamasdi. Mijoz bir necha kilometr
  // narida bo'lsa, uning belgisi ekrandan tashqarida qolib ketardi —
  // ya'ni yo'l chizig'ini qo'shishning o'zi yetarli emas.
  //
  // Bir buyurtma uchun BIR MARTA bajariladi: aks holda har GPS
  // yangilanishida xarita sakrab, haydovchining qo'lda surganini bekor
  // qilib turardi.
  const fittedForOrderRef = useRef<string | null>(null);
  useEffect(() => {
    if (tripStage !== 'ready_to_start') {
      fittedForOrderRef.current = null;
      return;
    }
    const pickup = activeOrder?.pickupLocation;
    if (!pickup || !location || !mapRef.current) return;
    if (fittedForOrderRef.current === activeOrder?.id) return;
    fittedForOrderRef.current = activeOrder?.id ?? null;
    mapRef.current.fitToCoordinates([location, pickup], {
      // Pastdan ko'proq joy — buyurtma kartasi ekranning quyi qismini
      // egallaydi, aks holda belgi shu kartaning ostiga tushib qoladi.
      edgePadding: { top: 140, right: 80, bottom: 340, left: 80 },
      animated: true,
    });
  }, [tripStage, activeOrder?.id, activeOrder?.pickupLocation, location]);

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
    orderCancelUnsubscribe.current = listenToOrderCancellation(orderId, driverId, (reason, cancelledBy) => {
      if (cancelledBy === 'reassigned') {
        Alert.alert('Buyurtma sizdan olindi', reason);
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
        return;
      }
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
    // MUHIM: bu tekshiruv boshqa TO'RTTA qabul qilish yo'lida bor edi,
    // shu yerda esa yo'q edi. Bordyur — dispetchersiz, taqsimlashsiz
    // safar: haydovchi tugmani bosadi va ishlay boshlaydi. Ya'ni
    // balansi tugagan haydovchi uchun bu yagona ochiq eshik bo'lib
    // qolgan edi, komissiya esa har safar balansni yanada minusga
    // tortardi.
    if ((driver?.balance || 0) <= 0) {
      Alert.alert(
        'Balans yetarli emas',
        "Safarni boshlash uchun hisobingizni to'ldiring."
      );
      return;
    }
    if (!location) {
      Alert.alert('Joylashuv aniqlanmagan', 'GPS joylashuvi hali aniqlanmadi, birozdan keyin urinib ko‘ring.');
      return;
    }
    try {
      const { orderId, tariff } = await startBordurTrip(driverId, location);
      // MUHIM: masofa hisoblagichi FAQAT `handleStartTrip` va safarni
      // tiklashda nollanardi — bordyur safarida esa umuman
      // nollanmasdi. Oqibati: 15 km lik safardan keyin ko'chadan
      // yo'lovchi olgan haydovchida hisoblagich 15 km dan boshlanar,
      // mashina hali qimirlamasdan "joriy narx" o'n minglab so'm
      // ko'rsatardi, va safar oxirida AYNAN shu summa buyurtmaga
      // yozilardi. `lastTripPointRef` ham eski nuqtada qolgani uchun
      // birinchi GPS signali yana 1.5 km gacha qo'shib yuborardi.
      // ID ataylab parametr orqali: `activeOrderSourceId` bu yerda
      // hali yozilmagan (keyingi qatorda yoziladi).
      resetTripMeter(orderId);
      // Bordyurda olib ketish nuqtasi yo'q — kutish noldan boshlanadi.
      resetWaiting();
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

  async function handleAcceptOrder() {
    if ((driver?.balance || 0) <= 0) {
      Alert.alert(
        'Balans yetarli emas',
        'Buyurtma qabul qilish uchun hisobingizni to\'ldiring.'
      );
      return;
    }
    const id = activeOrderSourceId.current;
    // MUHIM: natija KUTILADI. Avval bu qator
    // `acceptOrder(...).catch(console.warn)` edi — ya'ni yozuv
    // o'tgan-o'tmagani tekshirilmasdan, pastdagi ikki qator SO'ZSIZ
    // bajarilardi. Buyurtmani shu orada boshqa haydovchi olib
    // ulgurgan bo'lsa, tranzaksiya `OrderAlreadyTakenError` tashlaydi
    // — u esa jurnalga yozilib yo'qolardi va haydovchi ekranida safar
    // BARIBIR boshlanardi: u o'ziniki bo'lmagan mijozning oldiga yo'l
    // olardi. `busy: true` esa uni taqsimlash navbatidan chiqarib
    // qo'yardi, ya'ni boshqa buyurtma ham kelmasdi.
    if (id) {
      try {
        await acceptOrder(id, driverId);
      } catch (error) {
        if (error instanceof OrderAlreadyTakenError) {
          Alert.alert('Kechikdingiz', 'Bu buyurtmani boshqa haydovchi allaqachon oldi.');
        } else {
          console.warn('Qabul qilishda xato:', error);
          Alert.alert(
            'Qabul qilinmadi',
            "Internet aloqasini tekshirib, qayta urinib ko'ring."
          );
        }
        return;
      }
    }
    setTripStage('to_pickup');
    setDriverBusyStatus(driverId, true).catch(() => {});
  }
  // Taymerni yoqish/o'chirish. Ikkalasi ham QAYTA chaqirilishga
  // chidamli: avtomatik rejimda GPS har signalda "yoq" deb chaqiradi.
  function beginWaiting() {
    if (waitStartedAtRef.current != null) return;
    const now = Date.now();
    waitStartedAtRef.current = now;
    setWaitStartedAt(now);
    // Taymer ekranda DARHOL 0:00 dan ketsin — interval birinchi
    // marta faqat bir soniyadan keyin ishlaydi.
    setWaitTick(now);
  }
  function endWaiting() {
    const started = waitStartedAtRef.current;
    if (started == null) return;
    waitAccumRef.current += Math.max(0, (Date.now() - started) / 1000);
    waitStartedAtRef.current = null;
    setWaitAccumSec(waitAccumRef.current);
    setWaitStartedAt(null);
  }
  function resetWaiting() {
    waitAccumRef.current = 0;
    waitStartedAtRef.current = null;
    stoppedSinceRef.current = null;
    setWaitAccumSec(0);
    setWaitStartedAt(null);
  }
  function toggleWaiting() {
    if (waitStartedAtRef.current != null) endWaiting();
    else beginWaiting();
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
    // Olib ketish nuqtasidagi kutish HAR DOIM avtomatik boshlanadi —
    // haydovchi keldi, mijoz hali chiqmadi. Bu taksida hamma joyda
    // shunday va dispetcherning "avtomatik/qo'lda" tanlovi faqat
    // SAFAR DAVOMIDAGI kutishga tegishli.
    resetWaiting();
    beginWaiting();
    setTripStage('waiting');
  }
  // Bosib o'tilgan masofa hisoblagichini nolga tushiradi. AVVAL bu
  // uchta qator faqat `handleStartTrip` ichida yozilgan edi va
  // bordyur safari (`handleStartBordur`) ularni umuman bajarmasdi —
  // ya'ni oldingi safarning kilometrlari yangi mijozga hisoblanardi.
  // Endi bitta joyda, ikkala yo'l ham shuni chaqiradi.
  function resetTripMeter(orderId: string | null) {
    tripDistanceRef.current = 0;
    setLiveTripDistanceKm(0);
    // Buyurtma ID'si SHART: hisoblagich fon vazifasi bilan umumiy va u
    // nuqtani qaysi safarga yozayotganini bilishi kerak.
    if (orderId) startTripMeter(orderId).catch(() => {});
  }

  function handleStartTrip() {
    const id = activeOrderSourceId.current;
    if (id) updateOrderStatus(id, 'in_progress').catch(console.warn);
    notifyTripStart();
    // Mijoz mashinaga o'tirdi — olib ketish nuqtasidagi kutish tugadi.
    // Yig'ilgan soniyalar SAQLANADI: ular ham to'lanadigan kutish.
    endWaiting();
    // Safar boshlanish nuqtasidan hisoblagichni nolga tushiramiz
    resetTripMeter(id);
    setActiveLeg(1);
    setTripStage('in_progress');
  }
  // Ikkinchi manzilli buyurtmada 1-manzilga yetib kelgach chaqiriladi —
  // buyurtma holati hali "in_progress"ligicha qoladi (mijoz hali
  // mashinada, xolos yo'nalish 2-manzilga almashadi), shuning uchun
  // Firestore holatini o'zgartirmaymiz, faqat mahalliy "oyoq"ni almashtiramiz.
  function handleReachedStop1() {
    setActiveLeg(2);
    // `activeLeg` o'zgargani yo'l chizig'i effektini qayta ishga
    // tushiradi va u DARHOL yangi manzilga so'rov yuboradi — shuning
    // uchun alohida "cheklovni nolga tushirish" endi kerak emas.
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
  async function confirmFinishTrip() {
    if (finishingTrip) return;
    const id = activeOrderSourceId.current;
    if (id) {
      // MUHIM (poyga holati): avval bu ikkala yozuv mustaqil, tartibsiz
      // yuborilardi — agar "completed" yozuvi tezroq yetib borsa,
      // komissiya/bonus Cloud Function'lari hali ESKI (buyurtma
      // yaratilgandagi taxminiy) narxni o'qib ulgurib, "bajarildi"
      // bayrog'ini qo'yib qo'yardi — haqiqiy metrlangan narx (pastda)
      // keyin kelsa ham, komissiya/bonus qayta hisoblanmasdi. Endi avval
      // yakuniy narx yoziladi (kutiladi), FAQAT SHUNDAN KEYIN holat
      // "completed"ga o'tkaziladi — Cloud Function har doim eng so'nggi
      // narxni ko'radi.
      // MUHIM: avval bu blok "yubordim va unutdim" edi — pastdagi
      // tozalash (`clearTripSnapshot`, `setTripStage(null)`,
      // `activeOrderSourceId = null`) yozuvlar TASDIQLANISHINI
      // KUTMASDAN darhol bajarilardi.
      //
      // Aloqasiz joyda (yerto'la, garaj) Firestore yozuvi server javob
      // bergunicha resolve BO'LMAYDI. Ilova o'sha holatda o'ldirilsa,
      // narx yozuvi keshdan qayta yuboriladi, lekin uning ketidan
      // keladigan "completed" yozuvi JS bilan birga yo'qoladi. Natijada
      // buyurtma abadiy "in_progress" bo'lib qoladi: komissiya
      // olinmaydi (kompaniya yo'qotadi), safar tarixga tushmaydi,
      // mijozning ilovasida safar tugamagan bo'lib turadi. Qurilmadagi
      // yozuv esa allaqachon o'chirilgani uchun keyingi ochilishda
      // masofa NOLDAN tiklanadi va narx eng past tarifga qulaydi.
      //
      // Endi ikkala yozuv ham kutiladi. O'tmasa — safar ekranda
      // QOLADI va haydovchi qayta urinib ko'ra oladi.
      setFinishingTrip(true);
      // Taymer yoniq qolgan bo'lsa shu yerda to'xtaydi — haydovchi
      // "Tugatdim"ni bosishni unutgan bo'lishi mumkin.
      endWaiting();
      // MUHIM: yakuniy summa ref'lardan QAYTA hisoblanadi, ekrandagi
      // `livePrice` dan olinmaydi. Ekrandagi qiymat React holatiga
      // tayanadi va u bir render orqada qolishi mumkin — o'shanda
      // buyurtmaga yozilgan narx bilan yozilgan masofa/kutish
      // bir-biriga mos kelmay qolardi.
      const finalKm = tripDistanceRef.current;
      const finalWaitSeconds = waitAccumRef.current;
      const finalBeyondMin = Math.max(0, finalKm - tariffMinDistance);
      const finalSurcharge = activeOrder?.tieredPricing
        ? computeTieredDistanceSurcharge(finalBeyondMin, activeOrder?.priceTiers)
        : finalBeyondMin * tariffPerKm;
      const finalWaitCharge = computeWaitCharge(finalWaitSeconds, waitFreeMin, waitPerMinute);
      const finalMetered =
        Math.ceil((tariffMinPrice + finalSurcharge + finalWaitCharge) / 1000) * 1000;
      try {
        // Yakuniy narx — jonli hisoblangan (va yaxlitlangan) summa,
        // oldindan taxmin qilingan (statik) narx emas
        await finalizeOrderPrice(
          id,
          finalMetered,
          finalKm,
          {
            totalSeconds: finalWaitSeconds,
            billedMinutes: billableWaitMinutes(finalWaitSeconds, waitFreeMin),
            charge: finalWaitCharge,
          },
          location
        );
        await updateOrderStatus(id, 'completed');
      } catch (e) {
        console.warn('Safarni yakunlashda xato:', e);
        setFinishingTrip(false);
        Alert.alert(
          "Yakunlab bo'lmadi",
          "Internet aloqasi yo'q ko'rinadi. Safar saqlanib qoldi — aloqa tiklangach «Yakunlash» tugmasini qayta bosing."
        );
        return;
      }
      setFinishingTrip(false);
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
  // Koordinatasiz buyurtma — xaritada yo'l chizilmaydi. Buni haydovchiga
  // AYTISH shart: aks holda u xarita ishlamayapti deb o'ylaydi.
  //
  // MUHIM: avval bu ogohlantirish FAQAT push/deep-link orqali qabul
  // qilishda chiqardi. "Ochiq buyurtmalar" ro'yxatidan olinganda va
  // safar tiklanganda esa jim qolardi — haydovchi bo'sh xaritaga qarab
  // turar, sababini bilmasdi.
  function warnIfPickupHasNoCoordinates(order: Order) {
    if (order.pickupLocation) return;
    Alert.alert(
      'Manzil xaritada belgilanmagan',
      `Bu buyurtmada olib ketish nuqtasining koordinatasi yo'q, shuning uchun xaritada yo'l chizilmaydi.\n\nManzil: ${order.fromAddress}\n\nMijozga qo'ng'iroq qilib aniqlashtiring.`
    );
  }

  async function handleTakePoolOrder(order: Order) {
    // Faol safar ustidagi haydovchi ikkinchi buyurtmani ololmasin —
    // aks holda joriy safar Firestore'da hech qachon yakunlanmay
    // "osilib" qoladi (push orqali qabul qilishda bu tekshiruv
    // allaqachon bor edi, bu yo'lda esa yo'q edi).
    if (tripStageRef.current) {
      Alert.alert(
        'Siz allaqachon safardasiz',
        'Yangi buyurtma olish uchun avval joriy safarni yakunlang.'
      );
      return;
    }
    if (tripStateUnknown) {
      Alert.alert(
        'Aloqa yo\'q',
        "Oldingi safaringiz holatini tekshirib bo'lmadi. Internet tiklangach avtomatik davom etadi."
      );
      return;
    }
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
        // Avval bu shunchaki `console.warn` edi: haydovchi "Olish"ni
        // bosardi va MUTLAQO hech narsa bo'lmasdi — na buyurtma, na
        // xabar.
        console.warn(error);
        Alert.alert(
          'Olib bo\'lmadi',
          "Internet aloqasini tekshirib, qayta urinib ko'ring."
        );
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
    warnIfPickupHasNoCoordinates(order);
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
  // MUHIM: avval shart `errorMsg || !location` edi. `errorMsg` esa BIR
  // MARTA yozilib, hech qachon tozalanmasdi \u2014 ya'ni ilova ochilgan
  // lahzada GPS javob bermagan bo'lsa (ichkarida, sun'iy yo'ldosh hali
  // topilmagan), keyin joylashuv kelib qolsa ham ekran shu xato matnida
  // QOTIB QOLARDI. Haydovchi ilovani butunlay yopib qayta ochmaguncha
  // ishlay olmasdi.
  //
  // Endi joylashuv bor ekan \u2014 xarita ko'rsatiladi (GPS kuzatuvchisi
  // birinchi nuqta kelganda xato matnini o'zi tozalaydi).
  if (!location) {
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
  // KUTISH HAQI. Narxlar buyurtma bilan birga keladi (tarifdan), ya'ni
  // dispetcher ularni paneldan o'zgartira oladi va ilovani qayta
  // yig'ish shart emas. `waitPerMin` 0 bo'lsa kutish bepul.
  const waitFreeMin = activeOrder?.freeWaitMin ?? tariffWait?.freeWaitMin ?? 0;
  const waitPerMinute = activeOrder?.waitPerMin ?? tariffWait?.waitPerMin ?? 0;
  const liveWaitSeconds =
    waitAccumSec +
    (waitStartedAt != null ? Math.max(0, (waitTick - waitStartedAt) / 1000) : 0);
  const waitCharge = computeWaitCharge(liveWaitSeconds, waitFreeMin, waitPerMinute);
  const rawLivePrice = tariffMinPrice + distanceSurcharge + waitCharge;
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
              // Olib ketish nuqtasi — yashil. `ready_to_start` ham shu
              // guruhda: o'sha bosqichda ham nishon MIJOZ, manzil emas.
              tripStage === 'ready_to_start' || tripStage === 'to_pickup'
                ? COLORS.success
                : (hasSecondStop && activeLeg === 1 ? COLORS.warning : COLORS.danger)
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
            onCancel={() => setCancelModalVisible(true)}
            waitSeconds={liveWaitSeconds}
            waitRunning={waitStartedAt != null}
            onToggleWait={toggleWaiting}
            freeWaitMin={waitFreeMin}
            waitPerMin={waitPerMinute}
            waitCharge={waitCharge} />
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
            waitSeconds={liveWaitSeconds}
            waitRunning={waitStartedAt != null}
            waitCharge={waitCharge}
            // Tugma FAQAT qo'lda rejimda. Avtomatik rejimda taymerni
            // mashinaning o'zi yoqadi va haydovchining tugmasi
            // ikkalasi bir-biriga xalaqit berardi.
            onToggleWait={activeOrder.waitingMode === 'automatic' ? undefined : toggleWaiting}
            onPrimaryAction={hasSecondStop && activeLeg === 1 ? handleReachedStop1 : openTripSummary} />
        </View>
      )}

      {/* Balans tugagan \u2014 buyurtma kelmasligining sababi.
          Bloklanganda ko'rsatilmaydi: u yerda boshqa, muhimroq
          xabar bor va ikkitasi ustma-ust tushib qolardi. */}
      {isOnline && !driver?.blocked && (driver?.balance || 0) <= 0 && (
        <View style={[styles.blockBanner, { top: insets.top + 12, backgroundColor: '#B4761F' }]}>
          <Ionicons name="wallet" size={17} color={COLORS.white} />
          <Text style={styles.blockBannerText}>
            {'Balansingiz tugagan \u2014 sizga buyurtma kelmaydi. Hisobni to\u2019ldiring.'}
          </Text>
        </View>
      )}

      {/* Bloklangan, lekin safar ustida — mijozni yo'lda qoldirib
          bo'lmaydi, shuning uchun faqat ogohlantiramiz. */}
      {!!driver?.blocked && tripStage !== null && (
        <View style={[styles.blockBanner, { top: insets.top + 12 }]}>
          <Ionicons name="lock-closed" size={17} color={COLORS.white} />
          <Text style={styles.blockBannerText}>
            {'Siz bloklangansiz \u2014 joriy safarni yakunlang. Yangi buyurtma kelmaydi.'}
          </Text>
        </View>
      )}

      {/* MUHIM: safar tugagach ko'rsatiladigan TO'LIQ EKRAN bu yerda
          EMAS \u2014 u ilova ildizida (app/_layout.tsx). Avval u shu
          yerda, Modal sifatida turardi va faqat XARITA tabini
          qoplardi: haydovchi pastdagi "Tarix" yoki "Hisob" tabiga
          o'tishi bilan xabar yo'qolardi. */}

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
              <TouchableOpacity
                style={styles.summaryBtnPrimary}
                onPress={confirmFinishTrip}
                disabled={finishingTrip}
              >
                <Text style={styles.summaryBtnPrimaryText}>
                  {finishingTrip ? 'Saqlanmoqda...' : 'Yakunlash'}
                </Text>
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
  blockBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: COLORS.danger,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
  },
  blockBannerText: { flex: 1, color: COLORS.white, fontSize: 12.5, fontWeight: '700' },
  blockOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  blockCard: {
    width: '100%',
    backgroundColor: COLORS.white,
    borderRadius: 22,
    padding: 26,
    alignItems: 'center',
    gap: 14,
  },
  blockTitle: { fontSize: 18, fontWeight: '800', color: COLORS.dark, textAlign: 'center' },
  blockText: { fontSize: 14, color: COLORS.textMuted, textAlign: 'center', lineHeight: 20 },
  blockBtn: {
    marginTop: 6,
    alignSelf: 'stretch',
    backgroundColor: COLORS.danger,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  blockBtnText: { color: COLORS.white, fontSize: 15, fontWeight: '800' },
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