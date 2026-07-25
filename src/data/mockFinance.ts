// src/data/mockFinance.ts
// Pul/daromad uchun mock (sinov) ma'lumotlar.

export type DayEarning = {
  day: number; // oy kuni, masalan 14, 15, 16...
  label: string; // qisqa nom (Du, Se, Ch...)
  amount: number; // shu kungi daromad (so'mda)
  tripsCount: number;
};

export const MOCK_WEEK_EARNINGS: DayEarning[] = [
  { day: 14, label: 'Du', amount: 85000, tripsCount: 4 },
  { day: 15, label: 'Se', amount: 120000, tripsCount: 6 },
  { day: 16, label: 'Ch', amount: 95000, tripsCount: 5 },
  { day: 17, label: 'Pa', amount: 0, tripsCount: 0 },
  { day: 18, label: 'Ju', amount: 145000, tripsCount: 7 },
  { day: 19, label: 'Sh', amount: 178000, tripsCount: 9 },
  { day: 20, label: 'Ya', amount: 11148, tripsCount: 1 },
];

export const MOCK_BALANCE = {
  total: 11148,
  limit: -10000,
  parkName: 'Qulay taxi',
};

export function getMaxEarning(): number {
  return Math.max(...MOCK_WEEK_EARNINGS.map((d) => d.amount), 1);
}