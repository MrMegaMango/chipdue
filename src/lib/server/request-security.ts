import { AppError } from './errors';
import { getCloudRuntimeConfig } from './runtime';

function validPort(port: string | undefined): boolean {
	if (port === undefined) return true;
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export function normalizeAuthority(authority: string | null): string | null {
	if (!authority || authority.length > 255 || /[\s,@/\\?#]/.test(authority)) return null;
	const normalized = authority.toLowerCase();
	if (normalized.startsWith('[')) {
		const match = normalized.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/);
		return match && validPort(match[2]) ? normalized : null;
	}
	const match = normalized.match(/^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/);
	return match && validPort(match[2]) ? normalized : null;
}

export function isLocalAuthority(authority: string | null): boolean {
	const normalized = normalizeAuthority(authority);
	if (!normalized) return false;
	if (normalized.startsWith('[')) return /^\[::1\](?::\d+)?$/.test(normalized);
	const hostname = normalized.split(':', 1)[0];
	return hostname === '127.0.0.1' || hostname === 'localhost';
}

export function assertSecureCloudTransport(request: Request, url: URL): void {
	const secure =
		process.env.VERCEL === '1'
			? request.headers.get('x-forwarded-proto')?.trim().toLowerCase() === 'https'
			: url.protocol === 'https:';
	if (!secure) throw new AppError('HTTPS_REQUIRED', 'Cloud mode requires HTTPS.', 403);
}

export function assertSecureCloudRequest(request: Request, url: URL): string {
	const config = getCloudRuntimeConfig();
	const authority = normalizeAuthority(request.headers.get('host'));
	if (!authority || !config.allowedHosts.has(authority)) {
		throw new AppError('HOST_NOT_ALLOWED', 'The request host is not allowed.', 403);
	}

	assertSecureCloudTransport(request, url);
	return authority;
}

export function expectedRequestOrigin(request: Request, url: URL, cloud: boolean): string {
	if (!cloud) return url.origin;
	const authority = normalizeAuthority(request.headers.get('host'));
	if (!authority) throw new AppError('HOST_NOT_ALLOWED', 'The request host is not allowed.', 403);
	return `https://${authority}`;
}
