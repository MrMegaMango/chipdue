import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	GET as listAccountsEndpoint,
	POST as createAccountEndpoint
} from '../../routes/api/accounts/+server';
import {
	GET as listBonusesEndpoint,
	POST as createBonusEndpoint
} from '../../routes/api/bonuses/+server';
import { closeDatabaseForTests } from './database';
import { resetCryptoStateForTests } from './crypto';

function mutationRequest(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin: 'http://localhost' },
		body: JSON.stringify(body)
	});
}

describe.sequential('financial workspace API contract', () => {
	let temporaryDirectory: string;
	let previousDataDirectory: string | undefined;

	beforeEach(() => {
		previousDataDirectory = process.env.CARDDUE_DATA_DIR;
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-financial-api-'));
		process.env.CARDDUE_DATA_DIR = temporaryDirectory;
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		if (previousDataDirectory === undefined) delete process.env.CARDDUE_DATA_DIR;
		else process.env.CARDDUE_DATA_DIR = previousDataDirectory;
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('creates linked accounts and bonuses without returning encrypted storage fields', async () => {
		const accountRequest = mutationRequest('/api/accounts', {
			nickname: 'Operating',
			accountType: 'checking',
			ownerType: 'business'
		});
		const accountResponse = (await createAccountEndpoint({
			request: accountRequest,
			url: new URL(accountRequest.url)
		} as never)) as Response;
		expect(accountResponse.status).toBe(201);
		const accountPayload = await accountResponse.json();
		expect(accountPayload.account).toMatchObject({
			nickname: 'Operating',
			accountType: 'checking',
			ownerType: 'business'
		});
		expect(accountPayload.account).not.toHaveProperty('payload_enc');

		const bonusRequest = mutationRequest('/api/bonuses', {
			accountId: accountPayload.account.id,
			offerTemplateId: 'us-bank-business-essentials-q3-2026',
			name: 'Opening offer',
			rewardCents: 60_000,
			requirements: [{ label: 'Complete qualifying deposits' }]
		});
		const bonusResponse = (await createBonusEndpoint({
			request: bonusRequest,
			url: new URL(bonusRequest.url)
		} as never)) as Response;
		expect(bonusResponse.status).toBe(201);
		const bonusPayload = await bonusResponse.json();
		expect(bonusPayload.bonus).toMatchObject({
			accountId: accountPayload.account.id,
			offerTemplateId: 'us-bank-business-essentials-q3-2026',
			offerDateOverrideConfirmed: false,
			status: 'active',
			requirements: [{ label: 'Complete qualifying deposits', completed: false }]
		});
		expect(bonusPayload.bonus).not.toHaveProperty('payload_enc');

		expect((await (await listAccountsEndpoint({} as never)).json()).accounts).toHaveLength(1);
		expect((await (await listBonusesEndpoint({} as never)).json()).bonuses).toHaveLength(1);
	});

	it('creates a card-linked spend bonus for card-level progress', async () => {
		const cardId = '6ac7c447-c302-4b28-a38a-98626af9aace';
		const bonusRequest = mutationRequest('/api/bonuses', {
			cardId,
			name: 'Targeted card upgrade',
			rewardCents: 15_000,
			spendTargetCents: 100_000,
			openedDate: '2026-08-27',
			requirementDeadline: '2027-02-27'
		});
		const response = (await createBonusEndpoint({
			request: bonusRequest,
			url: new URL(bonusRequest.url)
		} as never)) as Response;

		expect(response.status).toBe(201);
		expect((await response.json()).bonus).toMatchObject({
			accountId: null,
			cardId,
			rewardCents: 15_000,
			spendTargetCents: 100_000
		});
	});

	it('rejects cross-origin financial mutations', async () => {
		const request = mutationRequest('/api/accounts', {
			nickname: 'Private account',
			accountType: 'checking'
		});
		request.headers.set('origin', 'https://example.invalid');
		const response = (await createAccountEndpoint({
			request,
			url: new URL(request.url)
		} as never)) as Response;
		expect(response.status).toBe(403);
		expect(JSON.stringify(await response.json())).not.toContain('Private account');
	});
});
