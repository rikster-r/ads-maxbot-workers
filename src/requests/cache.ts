import { getUserRequests, RequestRecord } from '../lib/requestsApi.js';

const TTL_MS = 30_000;

interface CacheEntry {
  data: RequestRecord[];
  fetchedAt: number;
}

const cache = new Map<number, CacheEntry>();

export async function getCachedUserRequests(
  token: string,
  adsUserId: number,
): Promise<RequestRecord[] | null> {
  const entry = cache.get(adsUserId);
  if (entry && Date.now() - entry.fetchedAt < TTL_MS) {
    return entry.data;
  }

  const data = await getUserRequests(token, adsUserId);
  if (!data) return null;

  cache.set(adsUserId, { data, fetchedAt: Date.now() });
  return data;
}

export function invalidate(adsUserId: number): void {
  cache.delete(adsUserId);
}
