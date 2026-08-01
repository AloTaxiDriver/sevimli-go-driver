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
  DispatcherNotification, FirestoreOrder, acceptOrder, cancelOrder, ensureOverlayPermission, finalizeOrderPrice, firestoreOrderToOrder,
  listenToDriverNotifications, listenToForegroundMessages, listenToOrderCancellation, listenToPoolOrders, registerForPushNotifications,
  saveDriverPushToken, setDriverBusyStatus, startBordurTrip,
  updateOrderStatus
} from './utils/firebase';
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
  const lastSeenNotifAtRef = useRef(0);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [tripStage, setTripStage] = useState<TripStage>(null);
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
    return () => { orderCancelUnsubscribe.current?.(); };
  }, []);

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Joylashuvga ruxsat berilmadi');
        setLoading(false);
        return;
      }
      const current = await Location.getCurrentPositionAsync({});
      const initial = { latitude: current.coords.latitude, longitude: current.coords.longitude };
      setLocation(initial);
      setCurrentRegion({ ...initial, latitudeDelta: 0.05, longitudeDelta: 0.05 });
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
    if (processedAcceptId.current === pendingAcceptId) return;

    processedAcceptId.current = pendingAcceptId;
    const orderId = pendingAcceptId;

    (async () => {
      try {
        const doc = await firestore().collection('orders').doc(orderId).get();
        const data = doc.data();
        if (!data) { console.warn('Buyurtma topilmadi:', orderId); return; }

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
          note: data.note || '',
          source: data.source || 'dashboard',
          pickupLat: data.pickupLat ?? null,
          pickupLng: data.pickupLng ?? null,
          dropoffLat: data.dropoffLat ?? null,
          dropoffLng: data.dropoffLng ?? null,
        };

        // Zaxira: agar native tomon negadir yozmagan bo'lsa, shu yerda ham urinamiz
        await acceptOrder(orderId, driverId).catch(() => {});

        notifee.cancelAllNotifications().catch(console.warn);

        activeOrderSourceId.current = orderId;
        startWatchingOrderCancellation(orderId);
        setActiveOrder(firestoreOrderToOrder(fo, location));
        setIsOnline(true);
        setTripStage('ready_to_start');
        startPan.setValue(0);
        setPendingAcceptId(null);
        setDriverBusyStatus(driverId, true).catch(() => {});
        console.log('Buyurtma qabul qilindi, tasdiqlash ekrani ko\'rsatilmoqda');
      } catch (e) {
        console.warn('Qabul qilishda xato:', e);
        processedAcceptId.current = null;
      }
    })();
  }, [pendingAcceptId, location, driverId]);

  // Pool buyurtmalar — faqat gamburger menyuda, avtomatik taklif YO'Q
  useEffect(() => {
    if (!isOnline) { setPoolOrders([]); return; }
    return listenToPoolOrders(
      (orders) => setPoolOrders(orders),
      (error) => console.warn('Pool xato:', error)
    );
  }, [isOnline]);

  useEffect(() => {
    if (!isOnline) {
      saveDriverPushToken(driverId, null).catch(console.warn);
      return;
    }
    registerForPushNotifications().then((token) => {
      if (token) saveDriverPushToken(driverId, token).catch(console.warn);
    });
    ensureOverlayPermission();

    const iv = setInterval(async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        await firestore().collection('drivers').doc(driverId).set({
          lat: loc.coords.latitude,
          lng: loc.coords.longitude,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        console.warn('GPS xatosi:', e);
      }
    }, 10000);
    return () => clearInterval(iv);
  }, [isOnline, driverId]);

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
    const target = activeOrder && activeOrder.toAddress !== '' && (tripStage === 'to_pickup' || tripStage === 'in_progress')
      ? (tripStage === 'to_pickup' ? activeOrder.pickupLocation : activeOrder.dropoffLocation)
      : null;

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
  }, [tripStage, activeOrder?.id, location]);

  const isNavigatingRef = useRef(false);
  // Boshlang'ich "fitToCoordinates" dan keyin, necha marta location
  // yangilanganini sanaymiz — birinchi 1-2 yangilanishda hali kamerani
  // "haydash rejimi"ga (heading+pitch) keskin burab yubormaslik uchun,
  // biroz o'tish vaqti beramiz
  const navUpdateCount = useRef(0);

  useEffect(() => {
    if (!activeOrder || !location || !mapRef.current) { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }
    if (tripStage !== 'to_pickup' && tripStage !== 'in_progress') { isNavigatingRef.current = false; navUpdateCount.current = 0; return; }

    const target = tripStage === 'to_pickup' ? activeOrder.pickupLocation : activeOrder.dropoffLocation;
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
  }, [tripStage, activeOrder?.id, location, heading]);

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
  // dispetcher bekor qilib qo'ysa, haydovchiga darhol xabar beradi va
  // ekranni bo'sh holatga qaytaradi.
  function startWatchingOrderCancellation(orderId: string) {
    stopWatchingOrderCancellation();
    orderCancelUnsubscribe.current = listenToOrderCancellation(orderId, (reason) => {
      Alert.alert('Buyurtma bekor qilindi', `Dispetcher tomonidan bekor qilindi.\nSabab: ${reason}`);
      stopWatchingOrderCancellation();
      setTripStage(null);
      setActiveOrder(null);
      activeOrderSourceId.current = null;
      processedAcceptId.current = null;
      pan.setValue(0);
      startPan.setValue(0);
      setDriverBusyStatus(driverId, false).catch(() => {});
    });
  }

  function goOffline() {
    setIsOnline(false); setActiveOrder(null); setTripStage(null);
    setSkippedOrderIds(new Set());
    activeOrderSourceId.current = null;
    processedAcceptId.current = null;
    setPendingAcceptId(null);
    stopWatchingOrderCancellation();
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
    setTripStage('in_progress');
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
      updateOrderStatus(id, 'completed').catch(console.warn);
      // Yakuniy narx — jonli hisoblangan (va yaxlitlangan) summa,
      // oldindan taxmin qilingan (statik) narx emas
      finalizeOrderPrice(id, livePrice, tripDistanceRef.current).catch(console.warn);
    }
    notifyTripEnd();
    stopWatchingOrderCancellation();
    setShowTripSummary(false);
    setTripStage(null); setActiveOrder(null);
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
    setCancelModalVisible(false);
    setTripStage(null);
    setActiveOrder(null);
    activeOrderSourceId.current = null;
    processedAcceptId.current = null;
    startPan.setValue(0);
    setDriverBusyStatus(driverId, false).catch(() => {});
  }
  function handleTakePoolOrder(order: Order) {
    acceptOrder(order.id, driverId).catch(console.warn);
    activeOrderSourceId.current = order.id;
    startWatchingOrderCancellation(order.id);
    processedAcceptId.current = order.id;
    setPoolVisible(false);
    setActiveOrder(order);
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

  const routeTarget = activeOrder && activeOrder.toAddress !== '' && (tripStage === 'to_pickup' || tripStage === 'in_progress')
    ? (tripStage === 'to_pickup' ? activeOrder.pickupLocation : activeOrder.dropoffLocation)
    : null;
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
  const rawLivePrice =
    tariffMinPrice + Math.max(0, liveTripDistanceKm - tariffMinDistance) * tariffPerKm;
  const livePrice = Math.ceil(rawLivePrice / 1000) * 1000;

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
            <Marker coordinate={routeTarget} pinColor={tripStage === 'to_pickup' ? COLORS.success : COLORS.danger} />
          </>
        )}
        {tripStage === 'waiting' && activeOrder && (
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
              </View>
            </View>

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
          <TripCard order={activeOrder} stage="in_progress" distanceKm={liveDistanceKm}
            durationMin={liveDurationMin} price={livePrice} onPrimaryAction={openTripSummary} />
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
                  const order = firestoreOrderToOrder(item, location);
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
              <Text style={styles.summaryValue}>0 so'm</Text>
            </View>
            <View style={styles.summaryDivider} />

            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Yo'l narxi</Text>
              <Text style={styles.summaryValue}>{livePrice.toLocaleString()} so'm</Text>
            </View>
            <View style={styles.summaryDivider} />

            <Text style={styles.summaryTotalLabel}>Safar narxi</Text>
            <Text style={styles.summaryTotalValue}>{livePrice.toLocaleString()} so'm</Text>

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