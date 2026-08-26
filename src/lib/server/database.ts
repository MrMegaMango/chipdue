import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { cloudQuery } from './cloud-database';
import { AppError } from './errors';
import { assertPrivateFilePath, ensurePrivateDataDirectory } from './paths';
import { getRuntimeMode } from './runtime';

let singleton: Database.Database | undefined;
let singletonPath: string | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS plaid_items (
  id TEXT PRIMARY KEY,
  item_ref TEXT NOT NULL UNIQUE,
  item_id_enc TEXT NOT NULL,
  access_token_enc TEXT NOT NULL,
  institution_name_enc TEXT,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'needs_update')) DEFAULT 'healthy',
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('manual', 'plaid')),
  plaid_item_id TEXT REFERENCES plaid_items(id) ON DELETE CASCADE,
  external_account_ref TEXT,
  payload_enc TEXT NOT NULL,
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (source = 'manual' AND plaid_item_id IS NULL AND external_account_ref IS NULL) OR
    (source = 'plaid' AND plaid_item_id IS NOT NULL AND external_account_ref IS NOT NULL)
  ),
  UNIQUE (plaid_item_id, external_account_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS cards_source_idx ON cards(source);
CREATE INDEX IF NOT EXISTS cards_plaid_item_idx ON cards(plaid_item_id);
`;

export function getDatabase(): Database.Database {
	const paths = ensurePrivateDataDirectory();
	if (singleton) {
		if (singletonPath !== paths.database) {
			throw new AppError(
				'DATA_PATH_CHANGED',
				'The private data path cannot change while running.',
				500
			);
		}
		return singleton;
	}

	let database: Database.Database | undefined;
	try {
		assertPrivateFilePath(paths.database);
		assertPrivateFilePath(`${paths.database}-wal`);
		assertPrivateFilePath(`${paths.database}-shm`);
		database = new Database(paths.database);
		database.pragma('foreign_keys = ON');
		database.pragma('journal_mode = WAL');
		database.pragma('synchronous = FULL');
		database.pragma('secure_delete = ON');
		database.pragma('busy_timeout = 5000');
		database.exec(SCHEMA);
		assertPrivateFilePath(paths.database);
		assertPrivateFilePath(`${paths.database}-wal`);
		assertPrivateFilePath(`${paths.database}-shm`);
		if (process.platform !== 'win32') {
			for (const file of [paths.database, `${paths.database}-wal`, `${paths.database}-shm`]) {
				try {
					chmodSync(file, 0o600);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
			}
		}
		singleton = database;
		singletonPath = paths.database;
		return database;
	} catch (error) {
		database?.close();
		if (error instanceof AppError) throw error;
		throw new AppError('DATABASE_UNAVAILABLE', 'Private local storage is unavailable.', 500);
	}
}

export async function getInstallId(): Promise<string> {
	if (getRuntimeMode() === 'cloud') {
		const installId = randomUUID();
		const rows = await cloudQuery<{ value: string }>(
			`INSERT INTO public.carddue_metadata AS metadata (key, value) VALUES ('install_id', $1)
			 ON CONFLICT (key) DO UPDATE SET value = metadata.value
			 RETURNING value`,
			[installId]
		);
		if (!rows[0]?.value) {
			throw new AppError('DATABASE_UNAVAILABLE', 'Encrypted cloud storage is unavailable.', 503);
		}
		return rows[0].value;
	}

	const database = getDatabase();
	const existing = database
		.prepare('SELECT value FROM metadata WHERE key = ?')
		.get('install_id') as { value: string } | undefined;
	if (existing) return existing.value;

	const installId = randomUUID();
	database
		.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)')
		.run('install_id', installId);
	return (
		database.prepare('SELECT value FROM metadata WHERE key = ?').get('install_id') as {
			value: string;
		}
	).value;
}

export function closeDatabaseForTests(): void {
	singleton?.close();
	singleton = undefined;
	singletonPath = undefined;
}
