import Database from 'better-sqlite3';

export interface WorkerSession {
  max_user_id: number;
  login: string;
  token: string;
  expires_at: string;
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
        expires_at TEXT NOT NULL,
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
   * All non-expired sessions belonging to the given roles, used to
   * re-subscribe Pusher channels after a process restart and to fan out
   * notifications to dispatchers
   */
  getActiveSessionsByRoles(roles: string[]): WorkerSession[] {
    const placeholders = roles.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT * FROM worker_sessions
      WHERE expires_at > ? AND ads_user_id IS NOT NULL AND lower(role) IN (${placeholders})
    `);

    return stmt.all(new Date().toISOString(), ...roles) as WorkerSession[];
  }

  /**
   * Most recently active non-expired session's token among the given roles,
   * used to authenticate the private Pusher channel handshake
   */
  getAnyActiveSessionToken(roles: string[]): string | null {
    const placeholders = roles.map(() => '?').join(', ');
    const stmt = this.db.prepare(`
      SELECT token FROM worker_sessions
      WHERE expires_at > ? AND lower(role) IN (${placeholders})
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    const row = stmt.get(new Date().toISOString(), ...roles) as { token: string } | undefined;
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
