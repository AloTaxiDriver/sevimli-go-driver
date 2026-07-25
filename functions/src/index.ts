import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import * as logger from "firebase-functions/logger";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

function getDistanceMeters(
  lat1: number, lng1: number, lat2: number, lng2: number
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getDispatchSettings(): Promise<{
  radiusMeters: number;
  timeoutSeconds: number;
}> {
  try {
    const doc = await db.collection("settings").doc("dispatch").get();
    const data = doc.data();
    return {
      radiusMeters: typeof data?.radiusMeters === "number" ? data.radiusMeters : 1500,
      timeoutSeconds: typeof data?.timeoutSeconds === "number" ? data.timeoutSeconds : 20,
    };
  } catch {
    return { radiusMeters: 1500, timeoutSeconds: 20 };
  }
}

async function isOrderStillPending(orderId: string): Promise<boolean> {
  try {
    const doc = await db.collection("orders").doc(orderId).get();
    return doc.data()?.status === "pending";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendPushToToken(
  token: string,
  orderId: string,
  dataPayload: Record<string, string>
): Promise<void> {
  try {
    await messaging.send({
      token,
      data: dataPayload,
      android: { priority: "high" },
    });
    logger.info(`Push yuborildi — buyurtma: ${orderId}`);
  } catch (error) {
    logger.warn(`Push yuborishda xato (buyurtma: ${orderId}):`, error);
  }
}

export const onNewOrderNotifyDrivers = onDocumentCreated(
  {
    document: "orders/{orderId}",
    timeoutSeconds: 540,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.warn("Hujjat ma'lumotlari topilmadi");
      return;
    }

    const order = snapshot.data();
    const orderId = event.params.orderId;

    if (order.status !== "pending") {
      logger.info(`Buyurtma ${orderId} pending emas (${order.status}), o'tkazib yuborildi`);
      return;
    }

    const dataPayload: Record<string, string> = {
      orderId,
      type: "new_order",
      title: "Yangi buyurtma!",
      body: `${order.fromAddress || "Manzil ko'rsatilmagan"} • ${
        order.price ? String(order.price) + " so'm" : ""
      }`,
      fromAddress: order.fromAddress || "",
      toAddress: order.toAddress || "",
      price: order.price != null ? String(order.price) : "0",
      distanceKm: order.distanceKm != null ? String(order.distanceKm) : "0",
      tariffName: order.tariffName || "",
      customerName: order.customerName || "Noma'lum mijoz",
      customerPhone: order.customerPhone || "",
    };

    // ── TO'G'RIDAN-TO'G'RI BUYURTMA ──────────────────────────
    if (order.driverId) {
      try {
        const driverDoc = await db.collection("drivers").doc(order.driverId).get();
        const token = driverDoc.data()?.pushToken;
        if (token) {
          await sendPushToToken(token, orderId, dataPayload);
        } else {
          logger.warn(`Haydovchi ${order.driverId} uchun pushToken topilmadi`);
        }
      } catch (error) {
        logger.error("To'g'ridan-to'g'ri buyurtma dispatch xatosi:", error);
      }
      return;
    }

    // ── POOL BUYURTMA — KETMA-KET DISPATCH ───────────────────
    const settings = await getDispatchSettings();
    logger.info(
      `Dispatch sozlamalari — radius: ${settings.radiusMeters}m, timeout: ${settings.timeoutSeconds}s`
    );

    let driversSnapshot;
    try {
      driversSnapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Haydovchilarni olishda xato:", error);
      return;
    }

    type DriverInfo = { id: string; token: string; distance: number };

    const nearbyDrivers: DriverInfo[] = [];
    // MUHIM: allDrivers endi id+token juftligi bilan saqlanadi,
    // shunda broadcast bosqichida nearbyDrivers'da bo'lganlarni
    // chiqarib tashlashimiz mumkin (ular allaqachon push oldi)
    const allDrivers: { id: string; token: string }[] = [];

    const pickupLat: number | undefined = order.pickupLat;
    const pickupLng: number | undefined = order.pickupLng;

    driversSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.pushToken) return;

      allDrivers.push({ id: doc.id, token: data.pushToken });

      if (pickupLat != null && pickupLng != null && data.lat != null && data.lng != null) {
        const dist = getDistanceMeters(pickupLat, pickupLng, data.lat, data.lng);
        if (dist <= settings.radiusMeters) {
          nearbyDrivers.push({ id: doc.id, token: data.pushToken, distance: dist });
        }
      }
    });

    nearbyDrivers.sort((a, b) => a.distance - b.distance);

    logger.info(
      `Buyurtma ${orderId}: ${nearbyDrivers.length} ta yaqin haydovchi, ` +
        `${allDrivers.length} ta jami online haydovchi`
    );

    // ── RADIUS ICHIDAGI HAYDOVCHILAR YO'Q ────────────────────
    if (nearbyDrivers.length === 0) {
      logger.info(`Radius ichida haydovchi yo'q — barcha onlaynlarga broadcast`);
      const tokens = allDrivers.map((d) => d.token);
      if (tokens.length > 0) {
        try {
          const response = await messaging.sendEachForMulticast({
            tokens,
            data: dataPayload,
            android: { priority: "high" },
          });
          logger.info(
            `Broadcast: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
          );
        } catch (error) {
          logger.error("Broadcast xatosi:", error);
        }
      }
      return;
    }

    // ── KETMA-KET DISPATCH ────────────────────────────────────
    // MUHIM: har bir haydovchidan keyin, KEYINGISIGA o'tishdan
    // OLDIN sleep qilamiz (oldingi versiyada bu shart faqat
    // "oxirgi bo'lmagan" holatlar uchun edi, va OXIRGI haydovchidan
    // keyin QOSHIMCHA sleep + BROADCAST bo'lardi — bu esa
    // ORTIQCHA push'ga sabab bo'lardi, chunki broadcast ro'yxatida
    // ALLAQACHON push olgan haydovchilar ham bor edi).
    const notifiedDriverIds = new Set<string>();

    for (let i = 0; i < nearbyDrivers.length; i++) {
      const driver = nearbyDrivers[i];

      const stillPending = await isOrderStillPending(orderId);
      if (!stillPending) {
        logger.info(`Buyurtma ${orderId} qabul qilindi yoki bekor qilindi (${i}. haydovchida)`);
        return;
      }

      logger.info(
        `Buyurtma ${orderId} → haydovchi ${driver.id} ` +
          `(masofa: ${Math.round(driver.distance)}m, navbat: ${i + 1}/${nearbyDrivers.length})`
      );

      await sendPushToToken(driver.token, orderId, dataPayload);
      notifiedDriverIds.add(driver.id);

      // Har doim (oxirgisi bo'lsa ham) navbatdagi tekshiruv/broadcast'dan
      // oldin kutamiz — shu bilan haydovchiga qabul qilish uchun
      // yetarli vaqt beriladi.
      await sleep(settings.timeoutSeconds * 1000);
    }

    // ── BARCHA YAQIN HAYDOVCHILAR TUGADI ─────────────────────
    const stillPendingAfterAll = await isOrderStillPending(orderId);
    if (!stillPendingAfterAll) {
      logger.info(`Buyurtma ${orderId} yaqin haydovchilar tugashidan oldin qabul qilindi`);
      return;
    }

    // MUHIM TUZATISH: broadcast faqat ALLAQACHON PUSH OLMAGAN
    // haydovchilarga yuboriladi — shu bilan bir xil haydovchiga
    // ikkinchi marta (overlay qayta chiqishiga sabab bo'ladigan)
    // push yuborilishining oldi olinadi.
    const remainingTokens = allDrivers
      .filter((d) => !notifiedDriverIds.has(d.id))
      .map((d) => d.token);

    logger.info(
      `Buyurtma ${orderId}: barcha yaqin haydovchilar rad etdi — ` +
        `${remainingTokens.length} ta qolgan online haydovchiga broadcast`
    );

    if (remainingTokens.length > 0) {
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: remainingTokens,
          data: dataPayload,
          android: { priority: "high" },
        });
        logger.info(
          `Broadcast natija: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
        );
      } catch (error) {
        logger.error("Broadcast xatosi:", error);
      }
    } else {
      logger.info(`Buyurtma ${orderId}: broadcast qilinadigan qolgan haydovchi yo'q`);
    }
  }
);

// ============================================================
// KUN.UZ YANGILIKLAR TASMASI — dashboard'dagi "begavaya dorojka"
// uchun. Brauzer to'g'ridan-to'g'ri kun.uz'ga so'rov yubora olmaydi
// (CORS cheklovi), shuning uchun bu funksiya oraliq (proxy)
// vazifasini bajaradi: server tomonda RSS'ni o'qiydi, JSON qilib
// qaytaradi.
// ============================================================

const KUN_UZ_RSS_URL = "https://kun.uz/news/rss";

type NewsItem = { title: string; link: string };

// Xotirada keshlash — har bir dispetcher sahifani ochganda kun.uz'ga
// qayta so'rov yubormaslik uchun. 5 daqiqa amal qiladi.
let newsCache: { items: NewsItem[]; fetchedAt: number } = {
  items: [],
  fetchedAt: 0,
};
const NEWS_CACHE_TTL_MS = 5 * 60 * 1000;

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return "";
  let val = match[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return val
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

async function fetchKunUzNews(): Promise<NewsItem[]> {
  const now = Date.now();
  if (now - newsCache.fetchedAt < NEWS_CACHE_TTL_MS && newsCache.items.length > 0) {
    return newsCache.items;
  }
  const res = await fetch(KUN_UZ_RSS_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (ZuvzuvTaxiDashboard)" },
  });
  const xml = await res.text();
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const items: NewsItem[] = itemBlocks
    .slice(0, 15)
    .map((block) => ({
      title: extractTag(block, "title"),
      link: extractTag(block, "link"),
    }))
    .filter((item) => item.title && item.link);

  if (items.length > 0) {
    newsCache = { items, fetchedAt: now };
  }
  return newsCache.items;
}

export const getKunUzNews = onRequest(
  { region: "asia-south1", cors: true },
  async (req, res) => {
    try {
      const items = await fetchKunUzNews();
      res.set("Cache-Control", "public, max-age=180");
      res.status(200).json({ items });
    } catch (error) {
      logger.error("Kun.uz yangiliklarini olishda xato:", error);
      res.status(200).json({ items: [] });
    }
  }
);

// ============================================================
// DISPETCHER BILDIRISHNOMALARI — dashboard'dagi "Bildirishnoma"
// bo'limidan yuborilgan xabarni tegishli haydovchilarga push
// sifatida yetkazadi.
// ============================================================

export const onNewNotificationSendPush = onDocumentCreated(
  {
    document: "notifications/{notificationId}",
    timeoutSeconds: 60,
    memory: "256MiB",
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const notif = snapshot.data();
    const notificationId = event.params.notificationId;
    const target: string = notif.target || "all_drivers";

    let driversSnapshot;
    try {
      driversSnapshot = await db.collection("drivers").where("isOnline", "==", true).get();
    } catch (error) {
      logger.error("Bildirishnoma uchun haydovchilarni olishda xato:", error);
      return;
    }

    const tokens: string[] = [];
    driversSnapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.pushToken) return;
      const busy = !!data.busy;
      if (target === "all_drivers" || target === "all") tokens.push(data.pushToken);
      else if (target === "free_drivers" && !busy) tokens.push(data.pushToken);
      else if (target === "busy_drivers" && busy) tokens.push(data.pushToken);
      else if (target === doc.id) tokens.push(data.pushToken);
    });

    if (tokens.length === 0) {
      logger.info(`Bildirishnoma ${notificationId}: yuboriladigan haydovchi topilmadi (target: ${target})`);
      return;
    }

    try {
      const response = await messaging.sendEachForMulticast({
        tokens,
        data: {
          type: "dispatcher_notification",
          notificationId,
          title: notif.title || "Yangi xabar",
          body: notif.text || "",
        },
        android: { priority: "high" },
      });
      logger.info(
        `Bildirishnoma ${notificationId}: ${response.successCount} ta yuborildi, ${response.failureCount} ta xato`
      );
    } catch (error) {
      logger.error("Bildirishnoma push xatosi:", error);
    }
  }
);