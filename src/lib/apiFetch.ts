/**
 * Thrown when the ADS API rejects a worker's token (401). The bot middleware
 * in setup.ts catches it, drops the stored session and asks for a re-login.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super('ADS API token rejected (401)');
    this.name = 'SessionExpiredError';
  }
}

/**
 * fetch() against the ADS API with the worker's bearer token attached.
 * Throws SessionExpiredError on 401; every other response is returned as-is.
 */
export async function apiFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new SessionExpiredError();
  return response;
}
