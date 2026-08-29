import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { verifyCloudRoleBoundary } from './cloud-role.js';
import { CLOUD_SCHEMA_VERSION, verifyCloudSchemaCatalog } from './cloud-schema.js';
import { AppError } from './errors';
import { getCloudRuntimeConfig } from './runtime';
import { LEGACY_TENANT_ID, tenantReference } from './tenant';

export { CLOUD_MIGRATION_STATEMENTS, CLOUD_SCHEMA_VERSION } from './cloud-schema.js';

export type CloudRow = Record<string, unknown>;
export interface CloudStatement {
	text: string;
	params?: unknown[];
}

export interface CloudDatabaseAdapter {
	query<T extends CloudRow>(text: string, params?: unknown[]): Promise<T[]>;
	transaction(statements: CloudStatement[]): Promise<CloudRow[][]>;
}

let cachedClient: { url: string; sql: NeonQueryFunction<false, false> } | undefined;
let schemaPromise: Promise<void> | undefined;
let testAdapter: CloudDatabaseAdapter | undefined;

function productionAdapter(): CloudDatabaseAdapter {
	const { databaseUrl } = getCloudRuntimeConfig();
	if (cachedClient?.url !== databaseUrl) {
		cachedClient = { url: databaseUrl, sql: neon(databaseUrl) };
		schemaPromise = undefined;
	}
	const sql = cachedClient.sql;
	return {
		async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
			return (await sql.query(text, params)) as T[];
		},
		async transaction(statements: CloudStatement[]): Promise<CloudRow[][]> {
			return (await sql.transaction((transaction) =>
				statements.map((statement) => transaction.query(statement.text, statement.params ?? []))
			)) as CloudRow[][];
		}
	};
}

async function rawAdapter(): Promise<CloudDatabaseAdapter> {
	return testAdapter ?? productionAdapter();
}

export async function ensureCloudSchema(): Promise<void> {
	if (testAdapter) return;
	if (!schemaPromise) {
		schemaPromise = (async () => {
			const adapter = await rawAdapter();
			const { databaseRole } = getCloudRuntimeConfig();
			const identity = (
				await adapter.query<{ current_user: string; session_user: string }>(
					`SELECT current_user AS current_user, session_user AS session_user`
				)
			)[0];
			if (
				!identity ||
				identity.current_user !== databaseRole ||
				identity.session_user !== databaseRole
			) {
				throw new Error('unexpected cloud database identity');
			}
			await verifyCloudRoleBoundary(
				(text: string, parameters: unknown[] = []) => adapter.query(text, parameters),
				databaseRole
			);
			await verifyCloudSchemaCatalog((text: string, parameters: unknown[] = []) =>
				adapter.query(text, parameters)
			);
			const rows = await adapter.query<{ value: string }>(
				`SELECT value FROM public.carddue_metadata WHERE key = 'schema_version'`
			);
			if (rows.length !== 1 || rows[0].value !== String(CLOUD_SCHEMA_VERSION)) {
				throw new AppError(
					'CLOUD_SCHEMA_MISMATCH',
					'Encrypted cloud storage has not been provisioned.',
					503
				);
			}
			await adapter.query(
				`INSERT INTO public.carddue_metadata (key, value)
				 VALUES ('tenant_scope_v2_legacy_ref', $1)
				 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
				[tenantReference(LEGACY_TENANT_ID)]
			);
		})().catch((error) => {
			schemaPromise = undefined;
			if (error instanceof AppError) throw error;
			throw new AppError('DATABASE_UNAVAILABLE', 'Encrypted cloud storage is unavailable.', 503);
		});
	}
	return schemaPromise;
}

export async function cloudQuery<T extends CloudRow>(
	text: string,
	params: unknown[] = []
): Promise<T[]> {
	try {
		await ensureCloudSchema();
		return await (await rawAdapter()).query<T>(text, params);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('DATABASE_UNAVAILABLE', 'Encrypted cloud storage is unavailable.', 503);
	}
}

export async function cloudTransaction(statements: CloudStatement[]): Promise<CloudRow[][]> {
	try {
		await ensureCloudSchema();
		return await (await rawAdapter()).transaction(statements);
	} catch (error) {
		if (error instanceof AppError) throw error;
		throw new AppError('DATABASE_UNAVAILABLE', 'Encrypted cloud storage is unavailable.', 503);
	}
}

export function setCloudDatabaseAdapterForTests(adapter: CloudDatabaseAdapter | undefined): void {
	testAdapter = adapter;
	schemaPromise = undefined;
}

export function resetCloudDatabaseForTests(): void {
	testAdapter = undefined;
	schemaPromise = undefined;
	cachedClient = undefined;
}
