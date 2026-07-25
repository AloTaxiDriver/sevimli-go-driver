// app/data/mockData.ts
// Vaqtinchalik (mock) ma'lumotlar. Keyinchalik bu yerni backend API
// chaqiruvlariga almashtiramiz — boshqa fayllarni o'zgartirmaymiz.

export type Driver = {
  id: string;
  firstName: string;
  lastName: string;
  phone: string;
  password: string;
  branch: string;
  carBrand: string;
  carModel: string;
  color: string;
  plateRegion: string;
  plateBody: string;
  rating: number;
  balance: number;
  photo: string | null;
};

export const MOCK_DRIVERS: Driver[] = [
  {
    id: 'd1',
    firstName: 'Bekzod',
    lastName: 'Karimov',
    phone: '+998901234567',
    password: '1234', // demo uchun, productionda hash bo'lishi kerak
    branch: 'Toshkent — Chilonzor',
    carBrand: 'Chevrolet',
    carModel: 'Lacetti',
    color: 'Kumush',
    plateRegion: '01',
    plateBody: '434ZA',
    rating: 4.97,
    balance: 11148,
    photo: null,
  },
];

export function findDriverByPhone(phone: string): Driver | null {
  return MOCK_DRIVERS.find((d) => d.phone === phone) || null;
}

export function checkPassword(driver: Driver | null, password: string): boolean {
  return !!driver && driver.password === password;
}