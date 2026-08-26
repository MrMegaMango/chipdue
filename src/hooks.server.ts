import type { Handle, HandleServerError } from '@sveltejs/kit';

function hasLocalAuthority(authority: string | null): boolean {
	if (!authority || authority.length > 255 || /[\s,@/\\?#]/.test(authority)) return false;

	if (authority.startsWith('[')) {
		const match = authority.match(/^\[([0-9a-f:]+)\](?::(\d{1,5}))?$/i);
		if (!match || match[1].toLowerCase() !== '::1') return false;
		return validPort(match[2]);
	}

	const match = authority.match(/^([^:]+)(?::(\d{1,5}))?$/);
	if (!match || !validPort(match[2])) return false;
	const hostname = match[1].toLowerCase();
	return hostname === '127.0.0.1' || hostname === 'localhost';
}

function validPort(port: string | undefined): boolean {
	if (port === undefined) return true;
	const value = Number(port);
	return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

export const handle: Handle = async ({ event, resolve }) => {
	if (
		process.env.CARDDUE_ALLOW_REMOTE !== '1' &&
		!hasLocalAuthority(event.request.headers.get('host'))
	) {
		return new Response('CardDue accepts local connections only.', {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8' }
		});
	}

	const response = await resolve(event);
	response.headers.set('cache-control', 'no-store, max-age=0');
	response.headers.set('cross-origin-opener-policy', 'same-origin-allow-popups');
	response.headers.set('cross-origin-resource-policy', 'same-origin');
	response.headers.set(
		'permissions-policy',
		'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
	);
	response.headers.set('referrer-policy', 'no-referrer');
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('x-frame-options', 'DENY');
	response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive');
	return response;
};

export const handleError: HandleServerError = ({ status }) => ({
	message:
		status >= 500 ? 'An unexpected local error occurred.' : 'The request could not be completed.',
	code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR'
});
