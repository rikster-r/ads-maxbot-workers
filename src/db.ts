import Database from 'better-sqlite3';

export interface WorkerSession {
  max_user_id: number;
  login: string;
  token: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

class WorkerDatabase {
  private db: Database.Database;

  constructor(dbPath: string = './workers.db') {
    this.db = new Database(dbPath);
    this.initDatabase();
  }

  private initDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        max_user_id INTEGER PRIMARY KEY,
        login TEXT NOT NULL,
        token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Save or update a worker's API session (token + expiry)
   */
  saveSession(
    maxUserId: number,
    login: string,
    token: string,
    expiresAt: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO worker_sessions
        (max_user_id, login, token, expires_at, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(max_user_id) DO UPDATE SET
        login = excluded.login,
        token = excluded.token,
        expires_at = excluded.expires_at,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(maxUserId, login, token, expiresAt);
  }

  /**
   * Get a worker's session by their Max user id
   */
  getSession(maxUserId: number): WorkerSession | null {
    const stmt = this.db.prepare(`
      SELECT * FROM worker_sessions WHERE max_user_id = ?
    `);

    return stmt.get(maxUserId) as WorkerSession | null;
  }

  /**
   * Delete a worker's session
   */
  deleteSession(maxUserId: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM worker_sessions WHERE max_user_id = ?
    `);

    stmt.run(maxUserId);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton instance
let dbInstance: WorkerDatabase | null = null;

export function getWorkerDatabase(): WorkerDatabase {
  if (!dbInstance) {
    dbInstance = new WorkerDatabase();
  }
  return dbInstance;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
