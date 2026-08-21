// src/utils/waitCharge.ts
//
// KUTISH HAQI
// ============================================================
// Mijoz do'konga kirib ketdi, haydovchi kutib turibdi. Masofa
// hisoblagichi bunday paytda hech narsa qo'shmaydi (mashina qimirlamaydi),
// ya'ni kutish VAQTI alohida hisoblanmasa, u butunlay bepul bo'lardi —
// aynan shunday edi ham: ilova kutish taymerini ko'rsatardi, summani
// ekranga chiqarardi, lekin u hech qayerga qo'shilmasdi.
//
// Narxlar TARIFDAN keladi (dispetcher paneldan sozlaydi):
//   minWaitMin   — necha daqiqa bepul kutiladi
//   waitMinPrice — undan keyingi har bir daqiqa narxi
//
// MUHIM: `waitPerMin` 0 yoki berilmagan bo'lsa, kutish BEPUL bo'lib
// qoladi. Bu ataylab: tarifda kutish narxi sozlanmagan bo'lsa yoki
// buyurtma bu maydonlar qo'shilishidan oldin yaratilgan bo'lsa, mijozdan
// kutilmaganda pul olinmasligi kerak.

/** To'liq daqiqalar bo'yicha hisoblanadi: boshlangan daqiqa —
 * to'langan daqiqa (taksida hamma joyda shunday). */
export function computeWaitCharge(
  totalWaitSeconds: number,
  freeWaitMinutes: number,
  pricePerMinute: number
): number {
  if (!(pricePerMinute > 0)) return 0;
  const freeSeconds = Math.max(0, freeWaitMinutes || 0) * 60;
  const paidSeconds = Math.max(0, (totalWaitSeconds || 0) - freeSeconds);
  if (paidSeconds <= 0) return 0;
  return Math.ceil(paidSeconds / 60) * pricePerMinute;
}

/** Buyurtmaga yoziladigan kutish daqiqalari — bir xil yaxlitlash
 * qoidasi bilan, shunda panelda ko'rsatilgan daqiqa va olingan pul
 * bir-biriga mos keladi. */
export function billableWaitMinutes(
  totalWaitSeconds: number,
  freeWaitMinutes: number
): number {
  const freeSeconds = Math.max(0, freeWaitMinutes || 0) * 60;
  const paidSeconds = Math.max(0, (totalWaitSeconds || 0) - freeSeconds);
  return paidSeconds <= 0 ? 0 : Math.ceil(paidSeconds / 60);
}
