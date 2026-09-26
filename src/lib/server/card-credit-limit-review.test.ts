import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from '../../routes/api/cards/[id]/credit-limit-review/+server';
import {
	createManualCard,
	getCard,
	listCards,
	replaceConnectedCards,
	updateCardCreditLimitReview,
	updateCardRewards,
	updateManualCard,
	type ConnectedCardSnapshot
} from './cards';
import { decryptJson, resetCryptoStateForTests } from './crypto';
import { closeDatabaseForTests, getDatabase } from './database';
import { savePlaidItem } from './plaid-store';
import { createManualCardSchema, updateCardCreditLimitReviewSchema } from './schemas';
import { runAsTenant } from './tenant';

const REVIEW = {
	reviewDate: '2028-02-29',
	dateSource: 'estimated' as const,
	notes: 'Synthetic review estimate; confirm the effective change date with the issuer.'
};
const FIRST_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function snapshot(accountId: string, currentBalanceCents = 12_345): ConnectedCardSnapshot {
	return {
		accountId,
		nickname: 'Synthetic credit card',
		providerProductName: 'Synthetic credit product',
		issuer: 'Synthetic Bank',
		last4: '1234',
		currency: 'USD',
		statementBalanceCents: 10_000,
		minimumPaymentCents: 2_500,
		currentBalanceCents,
		dueDate: '2027-04-05',
		statementDate: '2027-03-11',
		isOverdue: false,
		autopayEnabled: true
	};
}

async function connectedCard(itemName = 'first-item', accountId = 'first-account') {
	const connectionId = await savePlaidItem(itemName, `${itemName}-token`, 'Synthetic Bank');
	await replaceConnectedCards('plaid', connectionId, [snapshot(accountId)], '2027-03-12T12:00:00Z');
	const card = (await listCards()).find((entry) => entry.connectionId === connectionId)!;
	return { connectionId, card };
}

function storedPayload(id: string): Record<string, unknown> {
	const row = getDatabase().prepare('SELECT payload_enc FROM cards WHERE id = ?').get(id) as {
		payload_enc: string;
	};
	return decryptJson<Record<string, unknown>>(row.payload_enc, `card:${id}`);
}

async function patchReview(id: string, body: unknown, headers: Record<string, string> = {}) {
	const request = new Request(`http://localhost/api/cards/${id}/credit-limit-review`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
		body: JSON.stringify(body)
	});
	return PATCH({ params: { id }, request, url: new URL(request.url) } as never);
}

describe.sequential('card credit limit reviews', () => {
	let temporaryDirectory: string;

	beforeEach(() => {
		temporaryDirectory = mkdtempSync(join(tmpdir(), 'chipdue-credit-limit-review-'));
		vi.stubEnv('CARDDUE_MODE', 'local');
		vi.stubEnv('CARDDUE_DATA_DIR', temporaryDirectory);
		vi.stubEnv('CARDDUE_MASTER_KEY_PATH', undefined);
		vi.stubEnv('DATABASE_URL', undefined);
		vi.stubEnv('VERCEL', undefined);
		closeDatabaseForTests();
		resetCryptoStateForTests();
	});

	afterEach(() => {
		closeDatabaseForTests();
		resetCryptoStateForTests();
		vi.unstubAllEnvs();
		rmSync(temporaryDirectory, { recursive: true, force: true });
	});

	it('defaults existing cards to no review and stores saved details only in the encrypted payload', async () => {
		const card = await createManualCard(
			createManualCardSchema.parse({
				nickname: 'Synthetic manual card',
				currentBalanceCents: 9_876
			})
		);
		expect(card.creditLimitReview).toBeNull();
		const result = await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		expect(result).toMatchObject({ currentBalanceCents: 9_876, creditLimitReview: REVIEW });
		const durableRows = JSON.stringify(getDatabase().prepare('SELECT * FROM cards').all());
		expect(durableRows).not.toContain(REVIEW.reviewDate);
		expect(durableRows).not.toContain(REVIEW.notes);
		closeDatabaseForTests();
		resetCryptoStateForTests();
		expect((await getCard(card.id)).creditLimitReview).toEqual(REVIEW);
	});

	it('edits a connected review without dropping provider, rewards, or transaction data', async () => {
		const connectionId = await savePlaidItem('history-item', 'history-token', 'Synthetic Bank');
		await replaceConnectedCards(
			'plaid',
			connectionId,
			[
				{
					...snapshot('history-account'),
					transactionHistory: {
						enabled: true,
						cursor: 'synthetic-cursor',
						status: 'current',
						transactions: [
							{
								transactionId: 'synthetic-purchase',
								name: 'Synthetic purchase',
								merchantName: null,
								amountCents: 2_300,
								currency: 'USD',
								date: '2027-03-10',
								authorizedDate: null,
								pending: false,
								categoryPrimary: null,
								categoryDetailed: null
							}
						]
					}
				}
			],
			'2027-03-12T12:00:00Z'
		);
		const card = (await listCards())[0];
		await updateCardRewards(card.id, {
			rewardProgramName: 'Synthetic rewards',
			rewardValueCents: 765
		});
		const before = storedPayload(card.id);
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		expect(storedPayload(card.id)).toMatchObject({ ...before, creditLimitReview: REVIEW });
		expect(await getCard(card.id)).toMatchObject({
			creditLimitReview: REVIEW,
			providerProductName: 'Synthetic credit product',
			rewardProgramName: 'Synthetic rewards',
			transactionHistoryEnabled: true
		});
	});

	it('preserves a saved review when a manual card is edited and when rewards change', async () => {
		const card = await createManualCard(
			createManualCardSchema.parse({ nickname: 'Synthetic manual' })
		);
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		await updateManualCard(card.id, { nickname: 'Renamed synthetic manual' });
		await updateCardRewards(card.id, { rewardValueCents: 1_234 });
		expect(await getCard(card.id)).toMatchObject({
			nickname: 'Renamed synthetic manual',
			rewardValueCents: 1_234,
			creditLimitReview: REVIEW
		});
	});

	it('keeps an explicit review through connected balance refreshes', async () => {
		const { connectionId, card } = await connectedCard();
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		await replaceConnectedCards(
			'plaid',
			connectionId,
			[snapshot('first-account', 8_765)],
			'2027-03-13T12:00:00Z'
		);
		expect(await listCards()).toMatchObject([
			{ id: card.id, currentBalanceCents: 8_765, creditLimitReview: REVIEW }
		]);
	});

	it.each([
		{ action: 'saving', review: REVIEW },
		{ action: 'clearing', review: null }
	])('preserves a local sync that commits while $action a review', async ({ review }) => {
		const { connectionId, card } = await connectedCard();
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		// The setter yields after reading its row; local sync then commits before that write.
		const [updated] = await Promise.all([
			updateCardCreditLimitReview(card.id, { creditLimitReview: review }),
			replaceConnectedCards(
				'plaid',
				connectionId,
				[snapshot('first-account', 5_432)],
				'2027-03-13T12:00:00Z'
			)
		]);
		expect(updated).toMatchObject({ currentBalanceCents: 5_432, creditLimitReview: review });
		expect(await getCard(card.id)).toMatchObject({
			currentBalanceCents: 5_432,
			creditLimitReview: review
		});
	});

	it.each(['same-account', 'changed-account'])(
		'preserves review across relink with %s identity',
		async (identity) => {
			const { card } = await connectedCard('old-item', 'old-account');
			await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
			const connectionId = await savePlaidItem('new-item', 'new-token', 'Synthetic Bank');
			const relinked = snapshot(identity === 'same-account' ? 'old-account' : 'new-account', 8_765);
			if (identity === 'same-account') relinked.nickname = 'Provider renamed the synthetic card';
			await replaceConnectedCards('plaid', connectionId, [relinked], '2027-03-13T12:00:00Z');
			expect(await listCards()).toMatchObject([
				{ connectionId, creditLimitReview: REVIEW, currentBalanceCents: 8_765 }
			]);
		}
	);

	it('does not copy a review between distinct lookalike accounts on the same connection', async () => {
		const connectionId = await savePlaidItem('lookalikes', 'lookalikes-token', 'Synthetic Bank');
		await replaceConnectedCards(
			'plaid',
			connectionId,
			[snapshot('one', 1_100), snapshot('two', 2_200)],
			'2027-03-12T12:00:00Z'
		);
		const cards = await listCards();
		const first = cards.find((card) => card.currentBalanceCents === 1_100)!;
		const second = cards.find((card) => card.currentBalanceCents === 2_200)!;
		await updateCardCreditLimitReview(first.id, { creditLimitReview: REVIEW });
		await replaceConnectedCards(
			'plaid',
			connectionId,
			[snapshot('one', 1_101), snapshot('two', 2_201)],
			'2027-03-13T12:00:00Z'
		);
		expect((await getCard(first.id)).creditLimitReview).toEqual(REVIEW);
		expect((await getCard(second.id)).creditLimitReview).toBeNull();
		const relinkId = await savePlaidItem('ambiguous-relink', 'ambiguous-token', 'Synthetic Bank');
		await replaceConnectedCards(
			'plaid',
			relinkId,
			[snapshot('unknown-account')],
			'2027-03-14T12:00:00Z'
		);
		expect(await listCards()).toMatchObject([{ connectionId: relinkId, creditLimitReview: null }]);
	});

	it('keeps a cleared review cleared when an older duplicate connection refreshes', async () => {
		const { connectionId: originalId, card } = await connectedCard(
			'original-item',
			'original-account'
		);
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		const relinkId = await savePlaidItem('relinked-item', 'relinked-token', 'Synthetic Bank');
		await replaceConnectedCards(
			'plaid',
			relinkId,
			[snapshot('relinked-account')],
			'2027-03-13T12:00:00Z'
		);
		const relinked = (await listCards())[0];
		expect(relinked.creditLimitReview).toEqual(REVIEW);
		await updateCardCreditLimitReview(relinked.id, { creditLimitReview: null });
		await replaceConnectedCards(
			'plaid',
			originalId,
			[snapshot('original-account', 7_777)],
			'2027-03-14T12:00:00Z'
		);
		expect(await listCards()).toMatchObject([
			{ currentBalanceCents: 7_777, creditLimitReview: null }
		]);
		await replaceConnectedCards(
			'plaid',
			relinkId,
			[snapshot('relinked-account', 6_666)],
			'2027-03-15T12:00:00Z'
		);
		expect(await listCards()).toMatchObject([
			{ currentBalanceCents: 6_666, creditLimitReview: null }
		]);
	});

	it('rejects another tenant and never inherits its review through a matching card identity', async () => {
		const cardId = await runAsTenant(FIRST_TENANT, async () => {
			const { card } = await connectedCard('first-tenant-item', 'shared-provider-account');
			await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
			return card.id;
		});
		await runAsTenant(SECOND_TENANT, async () => {
			await expect(
				updateCardCreditLimitReview(cardId, { creditLimitReview: null })
			).rejects.toMatchObject({ status: 404 });
			const { card } = await connectedCard('second-tenant-item', 'shared-provider-account');
			expect(card.creditLimitReview).toBeNull();
		});
		await runAsTenant(FIRST_TENANT, async () => {
			expect((await getCard(cardId)).creditLimitReview).toEqual(REVIEW);
		});
	});

	it('saves and clears a connected review through the private API contract', async () => {
		const { card } = await connectedCard();
		const response = await patchReview(card.id, {
			creditLimitReview: { reviewDate: '2028-02-29', dateSource: 'issuer_confirmed' }
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(await response.json()).toMatchObject({
			card: {
				id: card.id,
				creditLimitReview: { reviewDate: '2028-02-29', dateSource: 'issuer_confirmed', notes: null }
			}
		});
		const cleared = await patchReview(card.id, { creditLimitReview: null });
		expect(cleared.status).toBe(200);
		expect(await cleared.json()).toMatchObject({ card: { creditLimitReview: null } });
		expect((await getCard(card.id)).creditLimitReview).toBeNull();
	});

	it.each([
		{},
		{ creditLimitReview: { ...REVIEW, reviewDate: '2027-02-29' } },
		{ creditLimitReview: { ...REVIEW, reviewDate: '2028-02-29T00:00:00Z' } },
		{ creditLimitReview: { reviewDate: REVIEW.reviewDate, notes: null } },
		{ creditLimitReview: { ...REVIEW, dateSource: 'guaranteed' } },
		{ creditLimitReview: { ...REVIEW, notes: 'x'.repeat(2_001) } },
		{ creditLimitReview: { ...REVIEW, guaranteedApproval: true } },
		{ creditLimitReview: REVIEW, currentBalanceCents: 0 }
	])('rejects invalid review input without changing the saved review: %j', async (body) => {
		const { card } = await connectedCard();
		await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
		const response = await patchReview(card.id, body);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: { code: 'INVALID_REQUEST', message: 'The request is invalid.' }
		});
		expect((await getCard(card.id)).creditLimitReview).toEqual(REVIEW);
	});

	it('validates origin, content type, card identifiers and missing cards before making changes', async () => {
		const { card } = await connectedCard();
		const body = { creditLimitReview: REVIEW };
		expect(
			(await patchReview(card.id, body, { origin: 'https://foreign.example.test' })).status
		).toBe(403);
		expect((await patchReview(card.id, body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
		expect((await patchReview(card.id, body, { 'content-type': 'text/plain' })).status).toBe(415);
		expect((await patchReview('not-a-card-id', body)).status).toBe(400);
		expect((await patchReview('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', body)).status).toBe(404);
		expect((await getCard(card.id)).creditLimitReview).toBeNull();
		expect(
			updateCardCreditLimitReviewSchema.parse({
				creditLimitReview: { ...REVIEW, notes: '  Synthetic note  ' }
			})
		).toMatchObject({ creditLimitReview: { notes: 'Synthetic note' } });
	});
});
