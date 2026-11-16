import { afterEach, describe, expect, it } from 'vitest';
import { handle, handleError } from './hooks.server';

const previousAllowRemote = process.env.CARDDUE_ALLOW_REMOTE;

afterEach(() => {
	if (previousAllowRemote === undefined) delete process.env.CARDDUE_ALLOW_REMOTE;
	else process.env.CARDDUE_ALLOW_REMOTE = previousAllowRemote;
});

async function requestWithHost(host: string): Promise<Response> {
	delete process.env.CARDDUE_ALLOW_REMOTE;
	const request = new Request('http://127.0.0.1:4173/api/cards', { headers: { host } });
	return handle({
		event: { request, url: new URL(request.url) } as never,
		resolve: (() => new Response('private response')) as never
	});
}

describe('loopback host enforcement', () => {
	it.each(['127.0.0.1:4173', 'localhost:4173', '[::1]:4173'])(
		'allows a loopback authority (%s)',
		async (host) => {
			const response = await requestWithHost(host);
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('private response');
		}
	);

	it.each([
		'attacker.invalid',
		'localhost.attacker.invalid',
		'127.0.0.1@example.invalid',
		'127.0.0.1:4173, attacker.invalid',
		'127.0.0.1:99999'
	])('rejects a non-loopback or malformed authority (%s)', async (host) => {
		const response = await requestWithHost(host);
		expect(response.status).toBe(403);
		expect(await response.text()).toBe('ChipDue accepts local connections only.');
	});
});

describe('server error privacy', () => {
	it('hides unknown error details and ignores an untrusted status property', async () => {
		const error = Object.assign(new Error('Synthetic private account data failed to load'), {
			status: 401
		});
		const result = await handleError({ kind: 'unknown', error, event: {} as never });
		expect(result).toEqual({
			status: 500,
			message: 'An unexpected error occurred.',
			code: 'INTERNAL_ERROR'
		});
	});

	it('preserves a framework 404 without returning its internal message', async () => {
		const result = await handleError({
			kind: 'framework',
			error: { status: 404, message: 'Synthetic private route was not found' },
			event: {} as never
		});
		expect(result).toEqual({
			status: 404,
			message: 'The request could not be completed.',
			code: 'REQUEST_ERROR'
		});
	});
});
