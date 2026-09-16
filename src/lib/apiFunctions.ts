import { logger } from '../logger.js';

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: string;
  active: boolean;
}

export async function loginToAPI(
  login: string,
  password: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${process.env.API_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ login, password }),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'API auth error');
      return null;
    }
    const data: { token: string } = await response.json();
    return data.token;
  } catch (error) {
    logger.error({ err: error }, 'Error logging in to API');
    return null;
  }
}

export async function getProfile(token: string): Promise<User | null> {
  try {
    const response = await fetch(`${process.env.API_URL}/auth/profile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'API profile error');
      return null;
    }
    return await response.json();
  } catch (error) {
    logger.error({ err: error }, 'Error getting API profile');
    return null;
  }
}
