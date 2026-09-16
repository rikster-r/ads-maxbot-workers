import type { RequestRecord } from './requestsApi.js';

type HouseField = RequestRecord['house'];

export function getShortHouseAddress(house: HouseField): string {
  if (typeof house === 'string') return house;
  if (!house || !house.full_address) return 'Адрес не указан';

  const cityPattern = new RegExp(`^г\\s*${house.city ?? ''},\\s*`, 'i');
  return house.full_address.replace(cityPattern, '');
}

export function getFullHouseAddress(request: RequestRecord): string {
  if (!request.house) return 'Адрес не указан';

  const short = getShortHouseAddress(request.house);
  return `${short}${request.apartment ? `, кв. ${request.apartment}` : ''}`;
}
