// src/utils/firebase.ts
import notifee, { AndroidCategory, AndroidImportance } from '@notifee/react-native';
import firestore, {
  FirebaseFirestoreTypes,
} from '@react-native-firebase/firestore';
import messaging from '@react-native-firebase/messaging';
import { NativeModules } from 'react-native';

const { OverlayModule } = NativeModules;

export async function testFirebaseConnection(): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const testDoc = firestore().collection('connection_test').doc('ping');
    await testDoc.set({
      message: 'Salom Firebase!',
      timestamp: firestore.FieldValue.serverTimestamp(),
    });
    const snapshot = await testDoc.get();
    if (snapshot.exists()) {
      return { success: true, message: "Firebase muvaffaqiyatli ulandi!" };
    } else {
      return { success: false, message: "Yozildi, lekin o'qib bo'lmadi." };
    }
  } catch (error: any) {
    return { success: false, message: 'Xato: ' + (error?.message || String(error)) };
  }
}

// ============================================================
// BUYURTMALAR (ORDERS)
// ============================================================

export type FirestoreOrder = {
  id: string;
  status: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  driverId: string | null;
  customerName: string;
  customerPhone: string;
  fromAddress: string;
  toAddress: string;
  tariffName: string;
  price: number;
  distanceKm: number;
  note: string;
  source: 'dashboard' | 'customer_app';
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  perKm?: number;
  minDistance?: number;
  minDistancePrice?: number;
  createdAtMillis?: number;
  cancelReason?: string;
  cancelledBy?: 'driver' | 'dispatcher';
};

export function mapDocToOrder(
  doc: FirebaseFirestoreTypes.QueryDocumentSnapshot
): FirestoreOrder {
  const data = doc.data() || {};
  return {
    id: doc.id,
    status: data.status || 'pending',
    driverId: data.driverId ?? null,
    customerName: data.customerName || "Noma'lum mijoz",
    customerPhone: data.customerPhone || '',
    fromAddress: data.fromAddress || '',
    toAddress: data.toAddress || '',
    tariffName: data.tariffName || '',
    price: typeof data.price === 'number' ? data.price : 0,
    distanceKm: typeof data.distanceKm === 'number' ? data.distanceKm : 0,
    note: data.note || '',
    source: data.source || 'dashboard',
    pickupLat: data.pickupLat ?? null,
    pickupLng: data.pickupLng ?? null,
    dropoffLat: data.dropoffLat ?? null,
    dropoffLng: data.dropoffLng ?? null,
    perKm: typeof data.perKm === 'number' ? data.perKm : 0,
    minDistance: typeof data.minDistance === 'number' ? data.minDistance : 0,
    minDistancePrice:
      typeof data.minDistancePrice === 'number'
        ? data.minDistancePrice
        : typeof data.price === 'number'
        ? data.price
        : 0,
    createdAtMillis: data.createdAt?.toMillis
      ? data.createdAt.toMillis()
      : data.createdAt?.seconds
      ? data.createdAt.seconds * 1000
      : 0,
    cancelReason: data.cancelReason || undefined,
    cancelledBy: data.cancelledBy || undefined,
  };
}

export function listenToPoolOrders(
  onChange: (orders: FirestoreOrder[]) => void,
  onError?: (error: Error) => void
): () => void {
  const unsubscribe = firestore()
    .collection('orders')
    .where('status', '==', 'pending')
    .where('driverId', '==', null)
    .onSnapshot(
      (snapshot) => { onChange(snapshot.docs.map(mapDocToOrder)); },
      (error) => {
        console.warn('Pool buyurtmalarini tinglashda xato:', error);
        onError?.(error);
      }
    );
  return unsubscribe;
}

export function listenToDirectOrdersForDriver(
  driverId: string,
  onChange: (orders: FirestoreOrder[]) => void,
  onError?: (error: Error) => void
): () => void {
  const unsubscribe = firestore()
    .collection('orders')
    .where('status', '==', 'pending')
    .where('driverId', '==', driverId)
    .onSnapshot(
      (snapshot) => { onChange(snapshot.docs.map(mapDocToOrder)); },
      (error) => {
        console.warn('Shaxsiy buyurtmalarni tinglashda xato:', error);
        onError?.(error);
      }
    );
  return unsubscribe;
}

export function listenToActiveOrderForDriver(
  driverId: string,
  onChange: (order: FirestoreOrder | null) => void,
): () => void {
  return firestore()
    .collection('orders')
    .where('driverId', '==', driverId)
    .where('status', 'in', ['accepted', 'in_progress'])
    .limit(1)
    .onSnapshot(
      (snapshot) => {
        if (snapshot.empty) {
          onChange(null);
        } else {
          onChange(mapDocToOrder(snapshot.docs[0]));
        }
      },
      () => onChange(null)
    );
}

export function listenToAcceptedOrderForDriver(
  driverId: string,
  onAccepted: (order: FirestoreOrder) => void
): () => void {
  return firestore()
    .collection('orders')
    .where('driverId', '==', driverId)
    .where('status', '==', 'accepted')
    .limit(1)
    .onSnapshot((snapshot) => {
      if (snapshot.empty) return;
      const order = mapDocToOrder(snapshot.docs[0]);
      onAccepted(order);
    });
}

export function listenToOrderHistory(
  driverId: string,
  onChange: (orders: FirestoreOrder[]) => void,
  onError?: (error: Error) => void
): () => void {
  const unsubscribe = firestore()
    .collection('orders')
    .where('driverId', '==', driverId)
    .onSnapshot(
      (snapshot) => {
        const finished = snapshot.docs
          .map(mapDocToOrder)
          .filter((o) => o.status === 'completed' || o.status === 'cancelled')
          .sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0));
        onChange(finished);
      },
      (error) => {
        console.warn('Tarixni tinglashda xato:', error);
        onError?.(error);
      }
    );
  return unsubscribe;
}

export async function acceptOrder(
  orderId: string,
  driverId: string
): Promise<void> {
  await firestore().collection('orders').doc(orderId).update({
    status: 'accepted',
    driverId,
    acceptedAt: firestore.FieldValue.serverTimestamp(),
  });
}

export async function declineDirectOrder(orderId: string): Promise<void> {
  await firestore().collection('orders').doc(orderId).update({ status: 'cancelled' });
}

export async function updateOrderStatus(
  orderId: string,
  status: FirestoreOrder['status']
): Promise<void> {
  await firestore().collection('orders').doc(orderId).update({ status });
}

export async function cancelOrder(
  orderId: string,
  reason: string
): Promise<void> {
  await firestore().collection('orders').doc(orderId).update({
    status: 'cancelled',
    cancelReason: reason,
    cancelledBy: 'driver',
    cancelledAt: firestore.FieldValue.serverTimestamp(),
  });
}

export function listenToOrderCancellation(
  orderId: string,
  onCancelledByDispatcher: (reason: string) => void
): () => void {
  return firestore()
    .collection('orders')
    .doc(orderId)
    .onSnapshot(
      (doc) => {
        const data = doc.data();
        if (data && data.status === 'cancelled' && data.cancelledBy === 'dispatcher') {
          onCancelledByDispatcher(data.cancelReason || "Dispetcher tomonidan bekor qilindi");
        }
      },
      (error) => {
        console.warn('Buyurtma holatini tinglashda xato:', error);
      }
    );
}

export async function finalizeOrderPrice(
  orderId: string,
  finalPrice: number,
  actualDistanceKm: number
): Promise<void> {
  await firestore().collection('orders').doc(orderId).update({
    price: Math.round(finalPrice),
    actualDistanceKm: Math.round(actualDistanceKm * 10) / 10,
  });
}

// ============================================================
// FirestoreOrder -> Order
// ============================================================

function randomNearbyPoint(center: { latitude: number; longitude: number }) {
  const radiusKm = 1 + Math.random() * 3;
  const angle = Math.random() * 2 * Math.PI;
  const deltaLat = (radiusKm / 111) * Math.cos(angle);
  const deltaLng =
    (radiusKm / (111 * Math.cos((center.latitude * Math.PI) / 180))) *
    Math.sin(angle);
  return {
    latitude: center.latitude + deltaLat,
    longitude: center.longitude + deltaLng,
  };
}

export function firestoreOrderToOrder(
  fo: FirestoreOrder,
  driverLocation: { latitude: number; longitude: number }
) {
  const pickupLocation =
    fo.pickupLat != null && fo.pickupLng != null
      ? { latitude: fo.pickupLat, longitude: fo.pickupLng }
      : randomNearbyPoint(driverLocation);

  const dropoffLocation =
    fo.dropoffLat != null && fo.dropoffLng != null
      ? { latitude: fo.dropoffLat, longitude: fo.dropoffLng }
      : randomNearbyPoint(driverLocation);

  return {
    id: fo.id,
    type: fo.tariffName || "Yo'lovchi",
    distanceKm: fo.distanceKm,
    durationMin: Math.max(3, Math.round(fo.distanceKm * 2.2)),
    price: fo.price,
    perKm: fo.perKm || 0,
    minDistance: fo.minDistance || 0,
    minDistancePrice: fo.minDistancePrice || fo.price,
    fromAddress: fo.fromAddress,
    toAddress: fo.toAddress,
    pickupCount: 1,
    dropoffCount: 1,
    customer: {
      name: fo.customerName,
      phone: fo.customerPhone,
      rating: 4.8,
    },
    pickupLocation,
    dropoffLocation,
  };
}

// ============================================================
// DISPETCHER BILDIRISHNOMALARI
// ============================================================

export type DispatcherNotification = {
  id: string;
  title: string;
  text: string;
  type: string;
  target: string;
  image: string | null;
  createdAtMillis: number;
};

// Haydovchiga tegishli bildirishnomalarni (barcha/bo'sh/band
// haydovchilar yoki aynan shu haydovchi uchun) real vaqtda tinglaydi.
// Qo'ng'iroqcha belgisidagi ro'yxat va son (badge) shu orqali
// yangilanadi.
export function listenToDriverNotifications(
  driverId: string,
  onChange: (items: DispatcherNotification[]) => void
): () => void {
  return firestore()
    .collection('notifications')
    .where('target', 'in', ['all_drivers', 'free_drivers', 'busy_drivers', 'all', driverId])
    .onSnapshot(
      (snapshot) => {
        const items: DispatcherNotification[] = snapshot.docs
          .map((doc) => {
            const data = doc.data();
            return {
              id: doc.id,
              title: data.title || '',
              text: data.text || '',
              type: data.type || 'info',
              target: data.target || 'all_drivers',
              image: data.image || null,
              createdAtMillis: data.createdAt?.toMillis
                ? data.createdAt.toMillis()
                : data.createdAt?.seconds
                ? data.createdAt.seconds * 1000
                : Date.now(),
            };
          })
          .sort((a, b) => b.createdAtMillis - a.createdAtMillis)
          .slice(0, 50);
        onChange(items);
      },
      (error) => {
        console.warn('Bildirishnomalarni tinglashda xato:', error);
      }
    );
}

// Dispetcher xabari kelganda — oddiy (overlay emas) tizim
// bildirishnomasi ko'rsatiladi, ilova ochiq yoki fonda bo'lishidan
// qat'iy nazar ishlaydi.
export async function displayDispatcherNotification(
  data: Record<string, string | undefined>
): Promise<void> {
  try {
    await notifee.createChannel({
      id: 'dispatcher',
      name: 'Dispetcher xabarlari',
      importance: AndroidImportance.HIGH,
      sound: 'default',
      vibration: true,
    });
    await notifee.displayNotification({
      title: data.title || 'Yangi xabar',
      body: data.body || '',
      android: {
        channelId: 'dispatcher',
        importance: AndroidImportance.HIGH,
        pressAction: { id: 'default' },
        autoCancel: true,
      },
    });
  } catch (error) {
    console.warn("Dispetcher bildirishnomasini ko'rsatishda xato:", error);
  }
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================

export async function ensureOverlayPermission(): Promise<void> {
  try {
    if (!OverlayModule) {
      console.warn("OverlayModule topilmadi.");
      return;
    }
    const canDraw: boolean = await OverlayModule.canDrawOverlays();
    if (!canDraw) {
      await OverlayModule.requestOverlayPermission();
    }
  } catch (error) {
    console.warn("Overlay ruxsatini tekshirishda xato:", error);
  }
}

export async function createOrdersNotificationChannel(): Promise<void> {
  try {
    await notifee.createChannel({
      id: 'orders',
      name: 'Yangi buyurtmalar',
      importance: AndroidImportance.HIGH,
      sound: 'asosiy_ovoz',
      vibration: true,
    });
  } catch (error) {
    console.warn('Notification channel yaratishda xato:', error);
  }
}

export async function registerForPushNotifications(): Promise<string | null> {
  try {
    await createOrdersNotificationChannel();
    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;
    if (!enabled) {
      console.warn('Push notification ruxsati berilmadi');
      return null;
    }
    return await messaging().getToken();
  } catch (error) {
    console.warn('Push notification token olishda xato:', error);
    return null;
  }
}

export async function saveDriverPushToken(
  driverId: string,
  token: string | null
): Promise<void> {
  try {
    await firestore()
      .collection('drivers')
      .doc(driverId)
      .set(
        {
          pushToken: token,
          isOnline: token !== null,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
  } catch (error) {
    console.warn('Push token saqlashda xato:', error);
  }
}

export async function setDriverBusyStatus(
  driverId: string,
  busy: boolean
): Promise<void> {
  try {
    await firestore()
      .collection('drivers')
      .doc(driverId)
      .set(
        { busy, updatedAt: firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
  } catch (error) {
    console.warn('Band holatini yangilashda xato:', error);
  }
}

export function listenToForegroundMessages(
  onMessage: (title: string, body: string) => void
): () => void {
  return messaging().onMessage(async (remoteMessage) => {
    if (remoteMessage.data?.type === 'new_order') {
      await displayFullScreenOrderNotification(
        remoteMessage.data as Record<string, string>
      );
    } else if (remoteMessage.data?.type === 'dispatcher_notification') {
      await displayDispatcherNotification(
        remoteMessage.data as Record<string, string>
      );
    }
    const title = remoteMessage.data?.title?.toString() || 'Yangi buyurtma';
    const body = remoteMessage.data?.body?.toString() || '';
    onMessage(title, body);
  });
}

// ============================================================
// FULL-SCREEN NOTIFICATION
// ============================================================
export async function displayFullScreenOrderNotification(
  data: Record<string, string | undefined>
): Promise<void> {
  try {
    if (OverlayModule) {
      const canDraw: boolean = await OverlayModule.canDrawOverlays();
      if (canDraw) {
        await OverlayModule.showOrderOverlay({
          orderId: data.orderId ?? '',
          price: data.price ?? '0',
          fromAddress: data.fromAddress ?? '',
          toAddress: data.toAddress ?? '',
          distanceKm: data.distanceKm ?? '0',
          tariffName: data.tariffName ?? '',
          customerName: data.customerName ?? '',
          customerPhone: data.customerPhone ?? '',
        });
        return;
      }
    }

    await createOrdersNotificationChannel();

    const safeData: Record<string, string> = {};
    Object.keys(data).forEach((key) => { safeData[key] = data[key] ?? ''; });

    await notifee.displayNotification({
      title: 'Yangi buyurtma!',
      body: `${data.fromAddress || ''} • ${
        data.price ? Number(data.price).toLocaleString() + " so'm" : ''
      }`,
      data: safeData,
      android: {
        channelId: 'orders',
        importance: AndroidImportance.HIGH,
        category: AndroidCategory.CALL,
        pressAction: { id: 'incoming-order' },
        autoCancel: true,
        ongoing: false,
      },
    });
  } catch (error) {
    console.warn("Full-screen notification ko'rsatishda xato:", error);
  }
}