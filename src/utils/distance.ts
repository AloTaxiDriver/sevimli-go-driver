// src/utils/distance.ts
// Ikki GPS nuqtasi orasidagi masofa va taxminiy vaqtni hisoblash.

type Coords = { latitude: number; longitude: number };

// Haversine formulasi: Yer yuzasidagi ikki nuqta orasidagi masofa (km)
export function getDistanceKm(from: Coords, to: Coords): number {
  const R = 6371; // Yer radiusi, km
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Taxminiy vaqt (minutda), shahar ichi o'rtacha tezlik ~25 km/soat deb olamiz
export function estimateDurationMin(distanceKm: number): number {
  const avgSpeedKmh = 25;
  const hours = distanceKm / avgSpeedKmh;
  return Math.max(1, Math.round(hours * 60));
}