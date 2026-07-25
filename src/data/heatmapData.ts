// src/data/heatmapData.ts
// Talab zichligi uchun mock (sinov) ma'lumotlar.
// Har bir nuqta: markaz koordinatasi, radius (metr) va intensivlik (0-1).
// Kelajakda bu backend'dan real vaqtda kelishi mumkin.

export type HeatPoint = {
  latitude: number;
  longitude: number;
  radius: number; // metrlarda
  intensity: number; // 0 (past talab) dan 1 (yuqori talab) gacha
};

// Toshkent markazi atrofida bir nechta mock issiq nuqta
export const MOCK_HEAT_POINTS: HeatPoint[] = [
  { latitude: 41.3111, longitude: 69.2797, radius: 1800, intensity: 0.9 }, // markaz
  { latitude: 41.3275, longitude: 69.2817, radius: 1400, intensity: 0.7 }, // Yunusobod
  { latitude: 41.2856, longitude: 69.2034, radius: 1600, intensity: 0.8 }, // Chilonzor
  { latitude: 41.3422, longitude: 69.3334, radius: 1200, intensity: 0.5 }, // Salar
  { latitude: 41.2697, longitude: 69.2167, radius: 1300, intensity: 0.6 }, // Sergeli
];

// Intensivlikka qarab rang qaytaradi (yashildan qizilgacha)
export function getHeatColor(intensity: number): string {
  if (intensity >= 0.8) return 'rgba(168, 50, 196, 0.35)'; // binafsha-qizil (eng yuqori)
  if (intensity >= 0.6) return 'rgba(147, 51, 234, 0.3)'; // binafsha
  if (intensity >= 0.4) return 'rgba(99, 102, 241, 0.25)'; // ko'k-binafsha
  return 'rgba(59, 130, 246, 0.2)'; // ko'k (past)
}