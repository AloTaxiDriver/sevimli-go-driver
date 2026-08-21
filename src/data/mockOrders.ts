// src/data/mockOrders.ts
// Buyurtmalar uchun mock (sinov) ma'lumotlar.

export type Customer = {
  name: string;
  phone: string;
  rating: number;
};

export type Order = {
  id: string;
  type: string;
  distanceKm: number;
  durationMin: number;
  price: number;
  // Faqat "bordur" (ko'chadan olingan, dispetchersiz) va Firestore
  // tarif hujjatidan kelgan buyurtmalarda to'ldiriladi — real vaqtda
  // metr bo'yicha narx hisoblash uchun (tariffPerKm/tariffMinPrice).
  perKm?: number;
  minDistance?: number;
  minDistancePrice?: number;
  // Bosqichli (pog'onali) km-narxlash yoqilgan tariflar uchun — mavjud
  // bo'lsa jonli narx shu bosqichlar asosida, aks holda flat perKm
  // bo'yicha hisoblanadi (MapScreen.tsx'dagi livePrice).
  tieredPricing?: boolean;
  priceTiers?: { km?: number; pricePerKm: number }[];
  // KUTISH HAQI — tarifdan keladi (dispetcher paneldan sozlaydi).
  // `waitPerMin` 0 yoki berilmagan bo'lsa kutish bepul: eski
  // buyurtmalardan kutilmaganda pul olinib qolmasligi uchun.
  freeWaitMin?: number;
  waitPerMin?: number;
  // Safar DAVOMIDAGI kutishni kim boshqaradi. Filial sozlamasi
  // ("Kutish vaqti statusi" tugmasi) shu maydonga tushadi:
  //   'manual'    — haydovchi "Kutish" tugmasini o'zi bosadi
  //   'automatic' — mashina to'xtab qolsa taymer o'zi yoqiladi
  // Mijozni olib ketish nuqtasida kutish esa HAR DOIM avtomatik —
  // haydovchi "Yetib keldim" deganda boshlanadi.
  waitingMode?: 'manual' | 'automatic';
  // Mijoz bonus/qo'shimcha xizmat ishlatgan bo'lsa — `price` maydoni
  // (yuqorida) allaqachon shularni hisobga olgan yakuniy summa. Safar
  // davomida MapScreen'da GPS bo'yicha jonli hisoblanadigan narxni ham
  // xuddi shu tarzda tuzatish uchun bu ikkisi alohida saqlanadi (aks
  // holda "Yo'l narxi" ekranda bonusni hisobga olmagan, mijoz
  // bonusidan ancha yuqori summa ko'rsatib qo'yadi).
  bonusUsed?: number;
  extrasTotal?: number;
  // "taxi" (standart) yoki "delivery" (Dostavka) — mijoz ilovasidan
  // kelgan buyurtmalar uchun (E:\sevimli-go-customer dagi NewOrderInput
  // bilan bir xil). Dashboard'dan yaratilgan buyurtmalarda yo'q.
  serviceType?: 'taxi' | 'delivery';
  // Ikkinchi manzil (bitta buyurtma ichida, xuddi shu haydovchi bilan
  // davom etadi) — mavjud bo'lsa MapScreen'da ikkinchi "oyoq" sifatida
  // ishlatiladi (birinchi manzilga yetgach, haydovchi shu manzilga davom etadi).
  toAddress2?: string;
  dropoff2Location?: { latitude: number; longitude: number };
  distanceKm2?: number;
  // Faqat serviceType === 'delivery' bo'lganda to'ldiriladi.
  recipientName?: string;
  recipientPhone?: string;
  packageDescription?: string;
  fromAddress: string;
  // B nuqtasi (qayerga boriladi). Mock buyurtmalarda har doim
  // mavjud bo'lgani uchun ixtiyoriy emas, lekin Firestore'dan
  // kelgan eski hujjatlar uchun moslashuvchanlik kerak bo'lsa,
  // kerakli joyda "" standart qiymat ishlatiladi.
  toAddress: string;
  pickupCount: number;
  dropoffCount: number;
  customer: Customer;
  // MUHIM: `null` bo'lishi MUMKIN — buyurtmada koordinata berilmagan
  // bo'lsa (dispetcher manzilni qo'lda yozgan, xaritadan tanlamagan).
  // Bunday holatda xaritada yo'l chizilmaydi va marker qo'yilmaydi;
  // tasodifiy nuqta o'ylab topish ATAYLAB olib tashlangan (qarang:
  // src/utils/firebase.ts, firestoreOrderToOrder).
  pickupLocation: { latitude: number; longitude: number } | null;
  dropoffLocation: { latitude: number; longitude: number } | null;
};

export const FREE_WAIT_SECONDS = 180; // 3 daqiqa bepul kutish
export const WAIT_PRICE_PER_MIN = 500; // pullik kutish: 500 so'm/daqiqa

export const MOCK_ORDERS: Order[] = [
  {
    id: 'o1',
    type: 'Yetkazib berish',
    distanceKm: 1.9,
    durationMin: 7,
    price: 14500,
    fromAddress: "Mahalliy fuqarolar yig'ini Sabzavot, TXAY Yokasi ko'chasi, 1",
    toAddress: "Yunusobod tumani, 15-mavze",
    pickupCount: 1,
    dropoffCount: 1,
    customer: {
      name: 'Aziz Karimov',
      phone: '+998901112233',
      rating: 4.8,
    },
    pickupLocation: { latitude: 41.3111, longitude: 69.2797 },
    dropoffLocation: { latitude: 41.3275, longitude: 69.2817 },
  },
  {
    id: 'o2',
    type: "Yo'lovchi",
    distanceKm: 3.4,
    durationMin: 12,
    price: 22000,
    fromAddress: "Chilonzor ko'chasi, 45-uy",
    toAddress: "Toshkent Shahar Markazi",
    pickupCount: 1,
    dropoffCount: 1,
    customer: {
      name: 'Madina Yusupova',
      phone: '+998935556677',
      rating: 4.95,
    },
    pickupLocation: { latitude: 41.2856, longitude: 69.2034 },
    dropoffLocation: { latitude: 41.3111, longitude: 69.2797 },
  },
];

export function getRandomOrder(): Order {
  const i = Math.floor(Math.random() * MOCK_ORDERS.length);
  return MOCK_ORDERS[i];
}

export const MOCK_POOL_ORDERS: Order[] = [
  {
    id: 'p1',
    type: "Yo'lovchi",
    distanceKm: 2.1,
    durationMin: 8,
    price: 18000,
    fromAddress: "Yunusobod tumani, 12-mavze",
    toAddress: "Mirzo Ulug'bek tumani",
    pickupCount: 1,
    dropoffCount: 1,
    customer: { name: 'Sherzod Tashkentov', phone: '+998901234567', rating: 4.6 },
    pickupLocation: { latitude: 41.3422, longitude: 69.3334 },
    dropoffLocation: { latitude: 41.3275, longitude: 69.2817 },
  },
  {
    id: 'p2',
    type: 'Yetkazib berish',
    distanceKm: 4.7,
    durationMin: 15,
    price: 26000,
    fromAddress: "Sergeli tumani, Bunyodkor ko'chasi",
    toAddress: "Chilonzor tumani",
    pickupCount: 1,
    dropoffCount: 2,
    customer: { name: 'Nodira Egamova', phone: '+998909876543', rating: 4.9 },
    pickupLocation: { latitude: 41.2697, longitude: 69.2167 },
    dropoffLocation: { latitude: 41.2856, longitude: 69.2034 },
  },
  {
    id: 'p3',
    type: "Yo'lovchi",
    distanceKm: 1.3,
    durationMin: 5,
    price: 12000,
    fromAddress: "Mirzo Ulug'bek tumani",
    toAddress: "Yunusobod tumani",
    pickupCount: 1,
    dropoffCount: 1,
    customer: { name: 'Jasur Rahimov', phone: '+998904445566', rating: 4.7 },
    pickupLocation: { latitude: 41.3111, longitude: 69.2797 },
    dropoffLocation: { latitude: 41.3422, longitude: 69.3334 },
  },
];