// src/utils/routing.ts
type Coords = { latitude: number; longitude: number };

export type ManeuverType =
  | 'straight' | 'turn-left' | 'turn-right'
  | 'slight-left' | 'slight-right'
  | 'sharp-left' | 'sharp-right'
  | 'uturn' | 'roundabout' | 'arrive' | 'depart';

export type RouteStep = {
  instruction: string;
  streetName: string;
  maneuver: ManeuverType;
  distanceM: number;
  durationS: number;
  coords: Coords;
};

export type RouteResult = {
  coordinates: Coords[];
  distanceKm: number;
  durationMin: number;
  steps: RouteStep[];
};

function parseManeuver(type: string, modifier: string): ManeuverType {
  if (type === 'arrive') return 'arrive';
  if (type === 'depart') return 'depart';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout';
  if (modifier === 'uturn') return 'uturn';
  if (modifier === 'sharp left') return 'sharp-left';
  if (modifier === 'sharp right') return 'sharp-right';
  if (modifier === 'slight left') return 'slight-left';
  if (modifier === 'slight right') return 'slight-right';
  if (modifier === 'left') return 'turn-left';
  if (modifier === 'right') return 'turn-right';
  return 'straight';
}

function buildInstruction(maneuver: ManeuverType): string {
  switch (maneuver) {
    case 'turn-left':    return "Chapga buring";
    case 'turn-right':   return "O'ngga buring";
    case 'slight-left':  return "Biroz chapga";
    case 'slight-right': return "Biroz o'ngga";
    case 'sharp-left':   return "Keskin chapga";
    case 'sharp-right':  return "Keskin o'ngga";
    case 'uturn':        return "Orqaga qaytib buring";
    case 'roundabout':   return "Aylanmaga kiring";
    case 'arrive':       return "Manzilga yetib keldingiz";
    case 'depart':       return "Yo'lga chiqing";
    default:             return "To'g'ri davom eting";
  }
}

export async function getRoute(from: Coords, to: Coords): Promise<RouteResult> {
  const empty: RouteResult = { coordinates: [from, to], distanceKm: 0, durationMin: 0, steps: [] };
  try {
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${from.longitude},${from.latitude};${to.longitude},${to.latitude}` +
      `?overview=full&geometries=geojson&steps=true`;

    const res = await fetch(url);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) return empty;

    const route = data.routes[0];
    const coordinates: Coords[] = route.geometry.coordinates.map(
      ([lon, lat]: [number, number]) => ({ latitude: lat, longitude: lon })
    );

    const steps: RouteStep[] = [];
    for (const leg of route.legs ?? []) {
      for (const step of leg.steps ?? []) {
        const m = step.maneuver ?? {};
        const maneuver = parseManeuver(m.type ?? '', m.modifier ?? '');
        const [lon, lat] = m.location ?? [0, 0];
        steps.push({
          instruction: buildInstruction(maneuver),
          streetName: step.name ?? '',
          maneuver,
          distanceM: step.distance ?? 0,
          durationS: step.duration ?? 0,
          coords: { latitude: lat, longitude: lon },
        });
      }
    }

    return {
      coordinates,
      distanceKm: Math.round((route.distance / 1000) * 10) / 10,
      durationMin: Math.round(route.duration / 60),
      steps,
    };
  } catch (e) {
    console.warn('Marshrut xatosi:', e);
    return empty;
  }
}

// Joriy pozitsiyaga eng yaqin step indeksini topadi
export function findCurrentStepIndex(steps: RouteStep[], pos: Coords): number {
  if (!steps.length) return 0;
  let minDist = Infinity, minIdx = 0;
  for (let i = 0; i < steps.length; i++) {
    const dx = steps[i].coords.latitude - pos.latitude;
    const dy = steps[i].coords.longitude - pos.longitude;
    const d = dx * dx + dy * dy;
    if (d < minDist) { minDist = d; minIdx = i; }
  }
  return minIdx;
}

// Qolgan masofa va vaqt
export function getRemainingInfo(steps: RouteStep[], fromIdx: number) {
  let m = 0, s = 0;
  for (let i = fromIdx; i < steps.length; i++) { m += steps[i].distanceM; s += steps[i].durationS; }
  return { distanceKm: Math.round((m / 1000) * 10) / 10, durationMin: Math.round(s / 60) };
}

// Masofani formatlash
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}