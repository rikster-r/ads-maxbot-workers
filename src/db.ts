import Database from 'better-sqlite3';

export interface AuthenticatedUser {
  telegram_id: number;
  phone_number: string;
  name: string;
  created_at: string;
  updated_at: string;
}

class UserDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './users.db') {
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS authenticated_users (
        telegram_id INTEGER PRIMARY KEY,
        phone_number TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for faster lookups
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_phone_number
      ON authenticated_users(phone_number)
    `);
  }

  /**
   * Save or update user authentication data
   */
  saveUser(telegramId: number, phoneNumber: string, name: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO authenticated_users
        (telegram_id, phone_number, name, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(telegram_id) DO UPDATE SET
        phone_number = excluded.phone_number,
        name = excluded.name,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(telegramId, phoneNumber, name);
  }

  /**
   * Get authenticated user by Telegram ID
   */
  getUser(telegramId: number): AuthenticatedUser | null {
    const stmt = this.db.prepare(`
      SELECT * FROM authenticated_users WHERE telegram_id = ?
    `);

    return stmt.get(telegramId) as AuthenticatedUser | null;
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(telegramId: number): boolean {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM authenticated_users WHERE telegram_id = ?
    `);

    const result = stmt.get(telegramId) as { count: number };
    return result.count > 0;
  }

  /**
   * Delete user authentication
   */
  deleteUser(telegramId: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM authenticated_users WHERE telegram_id = ?
    `);

    stmt.run(telegramId);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: UserDatabase | null = null;

export function getUserDatabase(): UserDatabase {
  if (!dbInstance) {
    dbInstance = new UserDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
