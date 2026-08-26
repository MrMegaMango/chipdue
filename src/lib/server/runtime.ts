import { AppError } from './errors';
import { isCloudRuntimeRoleName } from './cloud-role.js';
import { isDirectNeonDatabaseHost } from './neon-url.js';
import { parseScryptPasswordHash } from './password-hash';

export type CardDueMode = 'local' | 'cloud';

export interface CloudRuntimeConfig {
	databaseUrl: string;
	databaseRole: string;
	masterKey: Buffer;
	ownerPasswordHash: string;
	allowedHosts: ReadonlySet<string>;
	sessionTtlSeconds: number;
}

const DEFAULT_SESSION_TTL_HOURS = 24;
const MIN_SESSION_TTL_HOURS = 1;
const MAX_SESSION_TTL_HOURS = 24 * 30;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	return value;
}

function parseMasterKey(value: string): Buffer {
	if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	const key = Buffer.from(value, 'base64url');
	if (key.length !== 32) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	return key;
}

function parseDatabaseUrl(value: string): { databaseUrl: string; databaseRole: string } {
	try {
		const parsed = new URL(value);
		const sslModes = parsed.searchParams.getAll('sslmode');
		const sslMode = sslModes[0];
		const databaseRole = decodeURIComponent(parsed.username);
		if (
			!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
			!parsed.hostname ||
			!isDirectNeonDatabaseHost(parsed.hostname) ||
			!parsed.username ||
			!parsed.password ||
			parsed.pathname === '/' ||
			parsed.hash ||
			[...parsed.searchParams.keys()].some((name) => name !== 'sslmode') ||
			sslModes.length !== 1 ||
			!['require', 'verify-full'].includes(sslMode ?? '') ||
			!isCloudRuntimeRoleName(databaseRole)
		) {
			throw new Error('invalid database URL');
		}
		return { databaseUrl: value, databaseRole };
	} catch {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
}

function parseAllowedHosts(value: string): ReadonlySet<string> {
	const entries = value
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
	if (entries.length === 0 || entries.length > 20 || new Set(entries).size !== entries.length) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	for (const entry of entries) {
		let valid = entry.length <= 255 && !/[\s,@/\\?#*]/.test(entry);
		if (valid && entry.startsWith('[')) {
			const match = entry.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/);
			valid = Boolean(match && validPort(match[2]));
		} else if (valid) {
			const match = entry.match(/^([^:]+)(?::(\d{1,5}))?$/);
			const labels = match?.[1].split('.') ?? [];
			valid = Boolean(
				match &&
				validPort(match[2]) &&
				labels.length > 0 &&
				labels.every(
					(label) =>
						label.length > 0 &&
						label.length <= 63 &&
						/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
				)
			);
		}
		if (!valid) {
			throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
		}
	}
	return new Set(entries);
}

function validPort(port: string | undefined): boolean {
	if (port === undefined) return true;
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parseSessionTtl(): number {
	const raw = process.env.CARDDUE_SESSION_TTL_HOURS?.trim();
	if (!raw) return DEFAULT_SESSION_TTL_HOURS * 60 * 60;
	const hours = Number(raw);
	if (!Number.isInteger(hours) || hours < MIN_SESSION_TTL_HOURS || hours > MAX_SESSION_TTL_HOURS) {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode is not securely configured.', 503);
	}
	return hours * 60 * 60;
}

export function getRuntimeMode(): CardDueMode {
	const mode = process.env.CARDDUE_MODE?.trim().toLowerCase();
	if (!mode || mode === 'local') {
		if (process.env.DATABASE_URL?.trim() || process.env.VERCEL === '1') {
			throw new AppError('CLOUD_MISCONFIGURED', 'Cloud mode must be explicitly enabled.', 503);
		}
		return 'local';
	}
	if (mode !== 'cloud') {
		throw new AppError('CLOUD_MISCONFIGURED', 'The CardDue mode is invalid.', 503);
	}
	return 'cloud';
}

export function getCloudRuntimeConfig(): CloudRuntimeConfig {
	if (getRuntimeMode() !== 'cloud') {
		throw new AppError('CLOUD_MISCONFIGURED', 'Cloud storage is not enabled.', 503);
	}
	const { databaseUrl, databaseRole } = parseDatabaseUrl(required('DATABASE_URL'));
	const masterKey = parseMasterKey(required('CARDDUE_MASTER_KEY'));
	const ownerPasswordHash = required('CARDDUE_OWNER_PASSWORD_HASH');
	parseScryptPasswordHash(ownerPasswordHash);
	const allowedHosts = parseAllowedHosts(required('CARDDUE_ALLOWED_HOSTS'));
	return {
		databaseUrl,
		databaseRole,
		masterKey,
		ownerPasswordHash,
		allowedHosts,
		sessionTtlSeconds: parseSessionTtl()
	};
}
