import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	GET as listCardsEndpoint,
	POST as createCardEndpoint
} from '../../routes/api/cards/+server';
import { closeDatabaseForTests } from './database';
import { resetCryptoStateForTests } from './crypto';

interface TestEnvironment {
	CARDDUE_DATA_DIR?: string;
	PLAID_CLIENT_ID?: string;
	PLAID_SECRET?: string;
}

function restoreEnvironment(previous: TestEnvironment): void {
	for (const key of ['CARDDUE_DATA_DIR', 'PLAID_CLIENT_ID', 'PLAID_SECRET'] as const) {
		if (previous[key] === undefined) delete process.env[key];
		else process.env[key] = previous[key];
	}
}

async function createCard(request: Request): Promise<Response> {
	return (await createCardEndpoint({
		request,
		url: new URL(request.url)
	} as never)) as Response;
}

describe.sequential('cards API contract', () => {
	let temporaryDirectory: string;
	let previousEnvironment: TestEnvironment;

	beforeEach(() => {
		previousEnvironment = {
			CARDDUE_DATA_DIR: process.env.CARDDUE_DATA_DIR,
			PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
			PLAID_SECRET: process.env.PLAID_SECRET
		};
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-api-test-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		delete process.env.PLAID_CLIENT_ID;
		delete process.env.PLAID_SECRET;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		restoreEnvironment(previousEnvironment);
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('returns cards and aggregate Plaid status without cacheable data', async () => {
		const response = (await listCardsEndpoint({} as never)) as Response;
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(await response.json()).toEqual({
			cards: [],
			plaid: { configured: false, connectedItems: 0, lastSyncedAt: null }
		});
	});

	it('creates the frontend card shape and applies privacy-safe defaults', async () => {
		const response = await createCard(
			new Request('http://localhost/api/cards', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'http://localhost' },
				body: JSON.stringify({
					nickname: 'Everyday card',
					minimumPaymentCents: 2_500,
					dueDate: '2028-02-29'
				})
			})
		);
		expect(response.status).toBe(201);
		const payload = await response.json();
		expect(payload.card).toMatchObject({
			nickname: 'Everyday card',
			source: 'manual',
			minimumPaymentCents: 2_500,
			currentBalanceCents: null,
			statementDate: null,
			autopayEnabled: false
		});
		expect(payload.card).not.toHaveProperty('payload_enc');
	});

	it('rejects non-JSON and cross-origin mutations without reflecting input', async () => {
		const nonJsonResponse = await createCard(
			new Request('http://localhost/api/cards', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'private card details'
			})
		);
		expect(nonJsonResponse.status).toBe(415);
		expect(JSON.stringify(await nonJsonResponse.json())).not.toContain('private card details');

		const crossOriginResponse = await createCard(
			new Request('http://localhost/api/cards', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
				body: JSON.stringify({ nickname: 'Private card' })
			})
		);
		expect(crossOriginResponse.status).toBe(403);
	});
});
