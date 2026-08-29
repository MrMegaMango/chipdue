import { cloudQuery } from './cloud-database';
import { decryptJson, encryptJson } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import { currentTenantId, LEGACY_TENANT_ID } from './tenant';

export type PlaidEnvironmentName = 'sandbox' | 'production';

export interface PlaidConfiguration {
	clientId: string;
	secret: string;
	environment: PlaidEnvironmentName;
	source: 'personal' | 'installation';
}

interface StoredPlaidConfiguration {
	version: 1;
	clientId: string;
	secret: string;
	environment: 'production';
}

const CONFIGURATION_KEY_PREFIX = 'plaid_config_v1:';

function configurationKey(tenantId: string): string {
	return `${CONFIGURATION_KEY_PREFIX}${tenantId}`;
}

function configurationContext(tenantId: string): string {
	return `plaid-config:${tenantId}`;
}

function validCredential(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 8 && value.length <= 256;
}

function parseStoredConfiguration(value: string, tenantId: string): PlaidConfiguration {
	const config = decryptJson<Partial<StoredPlaidConfiguration>>(
		value,
		configurationContext(tenantId)
	);
	if (
		config?.version !== 1 ||
		!validCredential(config.clientId) ||
		!validCredential(config.secret) ||
		config.environment !== 'production'
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return {
		clientId: config.clientId,
		secret: config.secret,
		environment: config.environment,
		source: 'personal'
	};
}

async function readPersonalConfiguration(tenantId: string): Promise<PlaidConfiguration | null> {
	const key = configurationKey(tenantId);
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<{ value: string }>(
						`SELECT value FROM public.carddue_metadata WHERE key = $1`,
						[key]
					)
				)[0]
			: (getDatabase().prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
					{ value: string } | undefined);
	return row ? parseStoredConfiguration(row.value, tenantId) : null;
}

function installationConfiguration(): PlaidConfiguration | null {
	const clientId = process.env.PLAID_CLIENT_ID?.trim();
	const secret = process.env.PLAID_SECRET?.trim();
	const environmentValue = process.env.PLAID_ENV?.trim().toLowerCase() || 'sandbox';
	if (!clientId && !secret) return null;
	if (!clientId || !secret || !['sandbox', 'production'].includes(environmentValue)) {
		throw new AppError('PLAID_NOT_CONFIGURED', 'Plaid credentials are not configured.', 503);
	}
	return {
		clientId,
		secret,
		environment: environmentValue as PlaidEnvironmentName,
		source: 'installation'
	};
}

export function isInstallationPlaidConfigured(): boolean {
	try {
		return installationConfiguration() !== null;
	} catch {
		return false;
	}
}

export async function getPlaidConfiguration(): Promise<PlaidConfiguration | null> {
	const tenantId = currentTenantId();
	const personal = await readPersonalConfiguration(tenantId);
	if (personal) return personal;
	return tenantId === LEGACY_TENANT_ID ? installationConfiguration() : null;
}

export async function requirePlaidConfiguration(): Promise<PlaidConfiguration> {
	const config = await getPlaidConfiguration();
	if (!config) {
		throw new AppError('PLAID_NOT_CONFIGURED', 'Connect your Plaid developer account first.', 503);
	}
	return config;
}

export async function savePersonalPlaidConfiguration(
	clientId: string,
	secret: string
): Promise<void> {
	const tenantId = currentTenantId();
	const key = configurationKey(tenantId);
	const encrypted = encryptJson(
		{ version: 1, clientId, secret, environment: 'production' },
		configurationContext(tenantId)
	);
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_metadata AS current_config (key, value)
			 VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, encrypted]
		);
		return;
	}
	getDatabase()
		.prepare(
			`INSERT INTO metadata (key, value) VALUES (?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
		.run(key, encrypted);
}
