import { logger } from '../logger.js';

export interface RequestFile {
  id: number;
  name: string;
  format: string;
  url: string;
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'avi']);

// `format` is a MIME type (e.g. "image/jpeg", "video/mp4"), not a bare
// extension — `name` (e.g. "image-<timestamp>-0") never carries one either.
export function getFileKind(file: RequestFile): 'image' | 'video' | 'other' {
  const format = file.format?.toLowerCase() ?? '';
  if (format.startsWith('image/')) return 'image';
  if (format.startsWith('video/')) return 'video';

  const nameExt = file.name.split('.').pop()?.toLowerCase();
  if (nameExt && IMAGE_EXTENSIONS.has(nameExt)) return 'image';
  if (nameExt && VIDEO_EXTENSIONS.has(nameExt)) return 'video';
  return 'other';
}

export interface RequestRecord {
  id: number;
  created_at: string;
  arrival_time: string;
  complete_time: string;
  exist_time: string;
  is_copy: boolean;
  applicant: string | null;
  applicant_phone: string | null;
  customer: string | null;
  customer_phone: string | null;
  category: string | null;
  priority: string;
  users: string[];
  status: string;
  house: { city?: string; full_address?: string; commercial?: boolean } | string | null;
  organization: string | null;
  entrance: number | null;
  floor: number | null;
  apartment: number | null;
  intercom_code: string | null;
  note: string | null;
  paid: boolean;
  problem: string | { id: number; name: string } | null;
  problem_customer: string | null;
  work_done: string | null;
  files: RequestFile[];
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export async function getUserRequests(
  token: string,
  adsUserId: number,
): Promise<RequestRecord[] | null> {
  try {
    const response = await fetch(`${process.env.API_URL}/users/${adsUserId}/requests`, {
      headers: authHeaders(token),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'API getUserRequests error');
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.error({ err: error }, 'Error fetching user requests');
    return null;
  }
}

export async function getRequestDetail(
  token: string,
  requestId: number,
): Promise<RequestRecord | null> {
  try {
    const response = await fetch(`${process.env.API_URL}/requests/${requestId}`, {
      headers: authHeaders(token),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'API getRequestDetail error');
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.error({ err: error }, 'Error fetching request detail');
    return null;
  }
}

export async function changeRequestStatus(
  token: string,
  requestId: number,
  status: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${process.env.API_URL}/requests/${requestId}/status`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return response.ok;
  } catch (error) {
    logger.error({ err: error }, 'Error changing request status');
    return false;
  }
}

export async function addComment(
  token: string,
  requestId: number,
  comment: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${process.env.API_URL}/requests/${requestId}/comment`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    });
    return response.ok;
  } catch (error) {
    logger.error({ err: error }, 'Error adding comment');
    return false;
  }
}

export interface MediaFile {
  data: Buffer;
  filename: string;
  mimeType: string;
}

export async function uploadRequestMedia(
  token: string,
  requestId: number,
  files: MediaFile[],
): Promise<boolean> {
  try {
    const formData = new FormData();
    for (const file of files) {
      formData.append(
        'files[]',
        new Blob([Uint8Array.from(file.data)], { type: file.mimeType }),
        file.filename,
      );
    }

    // Do NOT set Content-Type manually — fetch/undici generates the
    // multipart boundary itself; a hardcoded header breaks parsing server-side.
    const response = await fetch(`${process.env.API_URL}/requests/${requestId}/media`, {
      method: 'POST',
      headers: authHeaders(token),
      body: formData,
    });
    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text() },
        'Error uploading request media',
      );
    }
    return response.ok;
  } catch (error) {
    logger.error({ err: error }, 'Error uploading request media');
    return false;
  }
}

export async function deleteRequestFile(token: string, fileId: number): Promise<boolean> {
  try {
    const response = await fetch(`${process.env.API_URL}/files/${fileId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    return response.ok || response.status === 204;
  } catch (error) {
    logger.error({ err: error }, 'Error deleting request file');
    return false;
  }
}

// file.url points at this app's own protected download endpoint (requires
// the same bearer token as every other request here) — not a public/MAX
// CDN url, so it can't just be handed to MAX to fetch on its own.
export async function downloadRequestFile(token: string, url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status} ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}
