import { logger } from '../logger.js';
import { apiFetch, SessionExpiredError } from './apiFetch.js';

export interface HouseAddressType {
  id: number;
  name: string;
  alias: string;
}

// Embedded on RequestRecord.house (GET /users/{id}/requests, GET /requests/{id}).
// Has full_address + resolved address_type — GET /houses/{id} does NOT.
export interface HouseSummary {
  id: number;
  city: string | null;
  street: string | null;
  number: string | null;
  frame: string | null;
  building: string | null;
  count_entrance: number | null;
  count_floor: number | null;
  count_apartment: number | null;
  intercom_code: string | null;
  key_location: string | null;
  organization_id: number | null;
  complex: string | null;
  address_type_id: number | null;
  address_type: HouseAddressType | null;
  commercial: boolean;
  note: string | null;
  full_address: string | null;
  area: string | null;
  region: string | null;
}

export interface HouseFile {
  id: number;
  name: string;
  format: string;
  mime_type: string;
  size: number;
  file: string; // full URL — field is `file`, not `url` like RequestFile
}

// GET /houses/{id} — per the OpenAPI schema. Does NOT include full_address
// or a resolved address_type name (only address_type_id). Adds equipment +
// facility fields and files, none of which are on HouseSummary.
export interface HouseDetail {
  id: number;
  city: string | null;
  complex: string | null;
  commercial: boolean;
  address_type_id: number | null;
  street: string | null;
  number: string | null;
  frame: string | null;
  building: string | null;
  count_entrance: number | null;
  count_floor: number | null;
  count_apartment: number | null;
  intercom_code: string | null;
  key_location: string | null;
  organization_id: number | null;
  note: string | null;
  barrier: boolean;
  basement: boolean;
  technical_floor: boolean;
  vru: string | null;
  dhw: string | null;
  cws: string | null;
  heating_unit: string | null;
  pump: string | null;
  files: HouseFile[];
}

export async function getHouseDetail(token: string, houseId: number): Promise<HouseDetail | null> {
  try {
    const response = await apiFetch(token, `${process.env.API_URL}/houses/${houseId}`);
    if (!response.ok) {
      logger.error({ status: response.status }, 'API getHouseDetail error');
      return null;
    }
    return await response.json();
  } catch (error) {
    if (error instanceof SessionExpiredError) throw error;
    logger.error({ err: error }, 'Error fetching house detail');
    return null;
  }
}

export function getHouseFileKind(file: HouseFile): 'image' | 'video' | 'other' {
  const mime = file.mime_type?.toLowerCase() ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'other';
}

// Same defensive posture as requestsApi.ts's downloadRequestFile: always send
// the bearer token, since omitting a required header breaks downloads
// outright while sending an unneeded one is harmless.
export async function downloadHouseFile(token: string, url: string): Promise<Buffer> {
  const response = await apiFetch(token, url);
  if (!response.ok) {
    throw new Error(`Failed to download house file: ${response.status} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
