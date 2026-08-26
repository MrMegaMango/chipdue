import { afterEach, describe, expect, it } from 'vitest';
import { handle } from './hooks.server';

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
		expect(await response.text()).toBe('CardDue accepts local connections only.');
	});
});
