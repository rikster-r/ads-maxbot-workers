import Database from 'better-sqlite3';

export interface WorkerSession {
  max_user_id: number;
  login: string;
  token: string;
  created_at: string;
  updated_at: string;
  ads_user_id: number | null;
  role: string | null;
  name: string | null;
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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const existingColumns = new Set(
      (this.db.prepare('PRAGMA table_info(worker_sessions)').all() as { name: string }[]).map(
        (column) => column.name,
      ),
    );

    for (const [column, definition] of [
      ['ads_user_id', 'INTEGER'],
      ['role', 'TEXT'],
      ['name', 'TEXT'],
    ] as const) {
      if (!existingColumns.has(column)) {
        this.db.exec(`ALTER TABLE worker_sessions ADD COLUMN ${column} ${definition}`);
      }
    }

    // Sessions no longer expire; drop the legacy column from older databases
    if (existingColumns.has('expires_at')) {
      this.db.exec('ALTER TABLE worker_sessions DROP COLUMN expires_at');
    }
  }

  /**
   * Save or update a worker's API session
   */
  saveSession(maxUserId: number, login: string, token: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO worker_sessions
        (max_user_id, login, token, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(max_user_id) DO UPDATE SET
        login = excluded.login,
        token = excluded.token,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(maxUserId, login, token);
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
   * Save the ADS profile (ads user id, role, name) fetched after login
   */
  saveProfile(maxUserId: number, adsUserId: number, role: string, name: string): void {
    const stmt = this.db.prepare(`
      UPDATE worker_sessions
      SET ads_user_id = ?, role = ?, name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE max_user_id = ?
    `);

    stmt.run(adsUserId, role, name, maxUserId);
  }

  /**
   * All sessions with a profile, used to re-subscribe Pusher channels after
   * a process restart
   */
  getActiveSessions(): WorkerSession[] {
    const stmt = this.db.prepare(`
      SELECT * FROM worker_sessions
      WHERE ads_user_id IS NOT NULL
    `);

    return stmt.all() as WorkerSession[];
  }

  /**
   * All sessions logged in as one of the given ads_user_ids, used to notify
   * a request's assigned workers
   */
  getActiveSessionsByAdsUserIds(adsUserIds: number[]): WorkerSession[] {
    if (adsUserIds.length === 0) return [];

    const placeholders = adsUserIds.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT * FROM worker_sessions
      WHERE ads_user_id IN (${placeholders})
    `);

    return stmt.all(...adsUserIds) as WorkerSession[];
  }

  /**
   * Most recently active session's token, used to authenticate the private
   * Pusher channel handshake
   */
  getAnyActiveSessionToken(): string | null {
    const stmt = this.db.prepare(`
      SELECT token FROM worker_sessions
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    const row = stmt.get() as { token: string } | undefined;
    return row?.token ?? null;
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
