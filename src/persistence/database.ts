import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/** A single schema migration. Applied once, in version order. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '0001_init',
    sql: readFileSync(
      fileURLToPath(new URL('./migrations/0001_init.sql', import.meta.url)),
      'utf8',
    ),
  },
  {
    version: 2,
    name: '0002_observability',
    sql: readFileSync(
      fileURLToPath(new URL('./migrations/0002_observability.sql', import.meta.url)),
      'utf8',
    ),
  },
];

/**
 * SQLite database handle. Configures WAL journaling, foreign keys and
 * applies pending migrations inside transactions on construction.
 */
export class AppDatabase {
  readonly db: Database.Database;

  constructor(path: string = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.applyMigrations();
  }

  /** Current journal mode (exposed so tests can assert WAL). */
  get journalMode(): string {
    return String(this.db.pragma('journal_mode', { simple: true }));
  }

  /** Whether foreign key enforcement is enabled (1 = on). */
  get foreignKeys(): number {
    return Number(this.db.pragma('foreign_keys', { simple: true }));
  }

  close(): void {
    this.db.close();
  }

  private applyMigrations(): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    );
    const rows = this.db.prepare('SELECT version FROM schema_migrations').all() as Array<{
      version: number;
    }>;
    const applied = new Set(rows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      const transaction = this.db.transaction(() => {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
      });
      transaction();
    }
  }
}
