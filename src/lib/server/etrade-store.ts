import { cloudQuery } from './cloud-database';
import { decryptJson, encryptJson } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import { currentTenantId } from './tenant';

export interface EtradeConfiguration {
	consumerKey: string;
	consumerSecret: string;
}

export type EtradeAuthorization =
	| { state: 'disconnected' }
	| {
			state: 'pending';
			requestToken: string;
			requestTokenSecret: string;
			createdAt: string;
	  }
	| {
			state: 'connected';
			accessToken: string;
			accessTokenSecret: string;
			authorizedAt: string;
			authorizedEasternDay: string;
			accountCount: number;
	  };

interface StoredEtradeConfiguration {
	version: 1;
	state: 'configured' | 'removed';
	consumerKey?: string;
	consumerSecret?: string;
}

type StoredEtradeAuthorization = { version: 1 } & EtradeAuthorization;

const CONFIGURATION_KEY_PREFIX = 'etrade_config_v1:';
const AUTHORIZATION_KEY_PREFIX = 'etrade_auth_v1:';

function metadataKey(prefix: string, tenantId: string): string {
	return `${prefix}${tenantId}`;
}

function storageContext(kind: 'config' | 'authorization', tenantId: string): string {
	return `etrade-${kind}:${tenantId}`;
}

function validSecret(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 8 &&
		value.length <= 256 &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x20 || code === 0x7f;
		})
	);
}

function validToken(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length >= 4 &&
		value.length <= 1024 &&
		![...value].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	);
}

async function readMetadata(key: string): Promise<string | null> {
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
	return row?.value ?? null;
}

async function writeMetadata(key: string, value: string): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_metadata AS current_value (key, value)
			 VALUES ($1, $2)
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
			[key, value]
		);
		return;
	}
	getDatabase()
		.prepare(
			`INSERT INTO metadata (key, value) VALUES (?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value`
		)
		.run(key, value);
}

export async function getEtradeConfiguration(): Promise<EtradeConfiguration | null> {
	const tenantId = currentTenantId();
	const stored = await readMetadata(metadataKey(CONFIGURATION_KEY_PREFIX, tenantId));
	if (!stored) return null;
	const value = decryptJson<Partial<StoredEtradeConfiguration>>(
		stored,
		storageContext('config', tenantId)
	);
	if (value.version !== 1 || !['configured', 'removed'].includes(value.state ?? '')) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (value.state === 'removed') return null;
	if (!validSecret(value.consumerKey) || !validSecret(value.consumerSecret)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return { consumerKey: value.consumerKey, consumerSecret: value.consumerSecret };
}

export async function saveEtradeConfiguration(
	consumerKey: string,
	consumerSecret: string
): Promise<void> {
	const tenantId = currentTenantId();
	await writeMetadata(
		metadataKey(CONFIGURATION_KEY_PREFIX, tenantId),
		encryptJson(
			{ version: 1, state: 'configured', consumerKey, consumerSecret },
			storageContext('config', tenantId)
		)
	);
	await saveEtradeAuthorization({ state: 'disconnected' });
}

export async function removeEtradeConfiguration(): Promise<void> {
	const tenantId = currentTenantId();
	await writeMetadata(
		metadataKey(CONFIGURATION_KEY_PREFIX, tenantId),
		encryptJson({ version: 1, state: 'removed' }, storageContext('config', tenantId))
	);
	await saveEtradeAuthorization({ state: 'disconnected' });
}

export async function getEtradeAuthorization(): Promise<EtradeAuthorization> {
	const tenantId = currentTenantId();
	const stored = await readMetadata(metadataKey(AUTHORIZATION_KEY_PREFIX, tenantId));
	if (!stored) return { state: 'disconnected' };
	const value = decryptJson<Partial<StoredEtradeAuthorization>>(
		stored,
		storageContext('authorization', tenantId)
	);
	if (
		value.version !== 1 ||
		!['disconnected', 'pending', 'connected'].includes(value.state ?? '')
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (value.state === 'disconnected') return value as EtradeAuthorization;
	if (
		value.state === 'pending' &&
		validToken(value.requestToken) &&
		validToken(value.requestTokenSecret) &&
		typeof value.createdAt === 'string'
	) {
		return value as EtradeAuthorization;
	}
	if (
		value.state === 'connected' &&
		validToken(value.accessToken) &&
		validToken(value.accessTokenSecret) &&
		typeof value.authorizedAt === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(value.authorizedEasternDay ?? '') &&
		Number.isInteger(value.accountCount) &&
		(value.accountCount ?? -1) >= 0 &&
		(value.accountCount ?? 0) <= 100
	) {
		return value as EtradeAuthorization;
	}
	throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
}

export async function saveEtradeAuthorization(value: EtradeAuthorization): Promise<void> {
	const tenantId = currentTenantId();
	await writeMetadata(
		metadataKey(AUTHORIZATION_KEY_PREFIX, tenantId),
		encryptJson({ version: 1, ...value }, storageContext('authorization', tenantId))
	);
}
