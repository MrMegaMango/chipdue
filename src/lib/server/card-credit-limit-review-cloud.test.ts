import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createManualCard,
	getCard,
	listCards,
	replaceConnectedCards,
	updateCardCreditLimitReview,
	type ConnectedCardSnapshot
} from './cards';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow,
	type CloudStatement
} from './cloud-database';
import { resetCryptoStateForTests } from './crypto';
import { createManualCardSchema } from './schemas';
import { runAsTenant, tenantReference } from './tenant';

const FIRST_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FIRST_CONNECTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SECOND_CONNECTION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REVIEW = {
	reviewDate: '2028-02-29',
	dateSource: 'estimated' as const,
	notes: 'Synthetic cloud review note'
};

function snapshot(accountId: string, currentBalanceCents = 12_345): ConnectedCardSnapshot {
	return {
		accountId,
		nickname: 'Synthetic cloud card',
		issuer: 'Synthetic Bank',
		last4: '3456',
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

class ReviewCloudAdapter implements CloudDatabaseAdapter {
	readonly cards = new Map<string, CloudRow>();
	readonly queries: Array<{ text: string; params: unknown[] }> = [];
	beforeQuery?: (text: string, params: unknown[]) => Promise<void>;

	async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
		this.queries.push({ text, params });
		await this.beforeQuery?.(text, params);
		if (!text.includes('public.carddue_cards')) throw new Error('Unexpected cloud review table.');
		if (text.trimStart().startsWith('INSERT INTO')) {
			const manual = text.includes("'manual'");
			const row = manual
				? {
						id: params[0],
						source: 'manual',
						plaid_item_id: null,
						external_account_ref: null,
						payload_enc: params[1],
						last_synced_at: null,
						created_at: params[2],
						updated_at: params[2],
						tenant_ref: params[3]
					}
				: {
						id: params[0],
						source: params[1],
						plaid_item_id: params[2],
						external_account_ref: params[3],
						payload_enc: params[4],
						last_synced_at: params[5],
						created_at: params[5],
						updated_at: params[5],
						tenant_ref: params[6]
					};
			const existing = this.cards.get(String(row.id));
			if (
				existing &&
				!manual &&
				text.includes('carddue_cards.payload_enc = $8') &&
				(existing.tenant_ref !== params[6] || existing.payload_enc !== params[7])
			) {
				return [];
			}
			this.cards.set(String(row.id), {
				...row,
				created_at: existing?.created_at ?? row.created_at
			});
			return [];
		}
		const where = text.split(/\bWHERE\b/)[1];
		if (!where || !/tenant_ref = \$\d+/.test(where)) {
			throw new Error('Cloud review access must constrain the tenant in SQL.');
		}
		const constraints = [
			...where.matchAll(
				/\b(tenant_ref|id|source|plaid_item_id|external_account_ref|payload_enc) = \$(\d+)/g
			)
		];
		const rows = [...this.cards.values()].filter((row) =>
			constraints.every(([, column, position]) => row[column] === params[Number(position) - 1])
		);
		if (text.trimStart().startsWith('UPDATE')) {
			for (const row of rows) {
				row.payload_enc = params[0];
				row.updated_at = params[1];
			}
			return rows.map((row) => ({ ...row })) as T[];
		}
		if (text.trimStart().startsWith('DELETE FROM')) {
			for (const row of rows) this.cards.delete(String(row.id));
			return [];
		}
		if (text.trimStart().startsWith('SELECT')) return rows.map((row) => ({ ...row })) as T[];
		throw new Error('Unexpected cloud review statement.');
	}

	async transaction(statements: CloudStatement[]): Promise<CloudRow[][]> {
		const results: CloudRow[][] = [];
		for (const statement of statements)
			results.push(await this.query(statement.text, statement.params));
		return results;
	}
}

describe.sequential('cloud card credit limit reviews', () => {
	let adapter: ReviewCloudAdapter;

	beforeEach(() => {
		vi.stubEnv('CARDDUE_MODE', 'cloud');
		vi.stubEnv(
			'DATABASE_URL',
			[
				'postgresql://carddue_runtime:synthetic',
				'ep-chipdue-test.us-west-2.aws.neon.tech/carddue?sslmode=require'
			].join('@')
		);
		vi.stubEnv('CARDDUE_MASTER_KEY', Buffer.alloc(32, 7).toString('base64url'));
		vi.stubEnv('CARDDUE_AUTH_MODE', 'google');
		vi.stubEnv('CARDDUE_OWNER_PASSWORD_HASH', undefined);
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_ID', 'synthetic.apps.googleusercontent.com');
		vi.stubEnv('CARDDUE_GOOGLE_CLIENT_SECRET', 'synthetic-google-secret');
		vi.stubEnv('CARDDUE_ALLOWED_HOSTS', 'cards.example.test');
		vi.stubEnv('CARDDUE_GOOGLE_BOOTSTRAP_HASH', undefined);
		vi.stubEnv('CARDDUE_SESSION_TTL_HOURS', undefined);
		vi.stubEnv('VERCEL', undefined);
		resetCryptoStateForTests();
		resetCloudDatabaseForTests();
		adapter = new ReviewCloudAdapter();
		setCloudDatabaseAdapterForTests(adapter);
	});

	afterEach(() => {
		resetCloudDatabaseForTests();
		resetCryptoStateForTests();
		vi.unstubAllEnvs();
	});

	it('encrypts saved and cleared manual reviews and restricts updates to their tenant', async () => {
		const cardId = await runAsTenant(FIRST_TENANT, async () => {
			const card = await createManualCard(
				createManualCardSchema.parse({
					nickname: 'Synthetic cloud manual',
					currentBalanceCents: 6_789
				})
			);
			await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
			expect(await getCard(card.id)).toMatchObject({
				currentBalanceCents: 6_789,
				creditLimitReview: REVIEW
			});
			return card.id;
		});
		await runAsTenant(SECOND_TENANT, async () => {
			const queryCount = adapter.queries.length;
			await expect(
				updateCardCreditLimitReview(cardId, { creditLimitReview: null })
			).rejects.toMatchObject({ status: 404 });
			expect(
				adapter.queries.slice(queryCount).every(({ text }) => text.trimStart().startsWith('SELECT'))
			).toBe(true);
			expect(await listCards()).toEqual([]);
		});
		await runAsTenant(FIRST_TENANT, async () => {
			expect((await getCard(cardId)).creditLimitReview).toEqual(REVIEW);
			await updateCardCreditLimitReview(cardId, { creditLimitReview: null });
			expect((await getCard(cardId)).creditLimitReview).toBeNull();
		});
		const values = JSON.stringify(adapter.queries.map(({ params }) => params));
		expect(values).not.toContain(REVIEW.notes);
		expect(values).not.toContain(REVIEW.reviewDate);
		expect(values).not.toContain('creditLimitReview');
		for (const { text, params } of adapter.queries.filter(({ text }) =>
			text.trimStart().startsWith('UPDATE')
		)) {
			expect(text).toContain('tenant_ref = $3');
			expect(params[2]).toBe(tenantReference(FIRST_TENANT));
		}
	});

	it.each(['stable reference', 'changed reference'])(
		'preserves a connected review through cloud sync and relink using %s',
		async (identity) => {
			await runAsTenant(FIRST_TENANT, async () => {
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('initial-account')],
					'2027-03-12T12:00:00Z'
				);
				const card = (await listCards())[0];
				await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('initial-account', 8_888)],
					'2027-03-13T12:00:00Z'
				);
				expect(await listCards()).toMatchObject([
					{ id: card.id, currentBalanceCents: 8_888, creditLimitReview: REVIEW }
				]);
				const relinkedAccount =
					identity === 'stable reference' ? 'initial-account' : 'relinked-account';
				await replaceConnectedCards(
					'plaid',
					SECOND_CONNECTION,
					[snapshot(relinkedAccount, 7_777)],
					'2027-03-14T12:00:00Z'
				);
				const relinked = (await listCards())[0];
				expect(relinked).toMatchObject({
					connectionId: SECOND_CONNECTION,
					currentBalanceCents: 7_777,
					creditLimitReview: REVIEW
				});
				await updateCardCreditLimitReview(relinked.id, { creditLimitReview: null });
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('initial-account', 6_666)],
					'2027-03-15T12:00:00Z'
				);
				expect(await listCards()).toMatchObject([
					{ currentBalanceCents: 6_666, creditLimitReview: null }
				]);
			});
			expect(JSON.stringify([...adapter.cards.values()])).not.toContain(REVIEW.notes);
		}
	);

	it('does not carry a review into another tenant during a cloud account refresh', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await replaceConnectedCards(
				'plaid',
				FIRST_CONNECTION,
				[snapshot('shared-account')],
				'2027-03-12T12:00:00Z'
			);
			await updateCardCreditLimitReview((await listCards())[0].id, { creditLimitReview: REVIEW });
		});
		await runAsTenant(SECOND_TENANT, async () => {
			await replaceConnectedCards(
				'plaid',
				SECOND_CONNECTION,
				[snapshot('shared-account')],
				'2027-03-13T12:00:00Z'
			);
			expect(await listCards()).toMatchObject([
				{ connectionId: SECOND_CONNECTION, creditLimitReview: null }
			]);
		});
		await runAsTenant(FIRST_TENANT, async () => {
			expect(await listCards()).toMatchObject([
				{ connectionId: FIRST_CONNECTION, creditLimitReview: REVIEW }
			]);
		});
	});

	it.each(['save', 'clear'] as const)(
		'keeps a concurrent review %s when a cloud sync has already read the old card',
		async (action) => {
			await runAsTenant(FIRST_TENANT, async () => {
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('racing-account')],
					'2027-03-12T12:00:00Z'
				);
				const card = (await listCards())[0];
				if (action === 'clear')
					await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
				const savedReview = action === 'save' ? REVIEW : null;
				adapter.beforeQuery = async (text) => {
					if (!text.trimStart().startsWith('INSERT INTO')) return;
					adapter.beforeQuery = undefined;
					await updateCardCreditLimitReview(card.id, { creditLimitReview: savedReview });
				};
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('racing-account', 8_888)],
					'2027-03-13T12:00:00Z'
				);
				expect((await getCard(card.id)).creditLimitReview).toEqual(savedReview);

				// The skipped stale snapshot can be replaced on the next fresh provider sync.
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('racing-account', 7_777)],
					'2027-03-14T12:00:00Z'
				);
				expect(await getCard(card.id)).toMatchObject({
					creditLimitReview: savedReview,
					currentBalanceCents: 7_777
				});
			});
		}
	);

	it('reapplies a review to current card data when a provider sync wins the first save attempt', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await replaceConnectedCards(
				'plaid',
				FIRST_CONNECTION,
				[snapshot('racing-account')],
				'2027-03-12T12:00:00Z'
			);
			const card = (await listCards())[0];
			adapter.beforeQuery = async (text) => {
				if (!text.trimStart().startsWith('UPDATE')) return;
				adapter.beforeQuery = undefined;
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('racing-account', 8_888)],
					'2027-03-13T12:00:00Z'
				);
			};
			const saved = await updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW });
			expect(saved).toMatchObject({
				creditLimitReview: REVIEW,
				currentBalanceCents: 8_888,
				lastSyncedAt: '2027-03-13T12:00:00Z'
			});
			expect((await getCard(card.id)).creditLimitReview).toEqual(REVIEW);
			expect(
				adapter.queries.filter(({ text }) => text.trimStart().startsWith('UPDATE'))
			).toHaveLength(2);
		});
	});

	it('stops after three conflicting review saves and preserves the latest provider data', async () => {
		await runAsTenant(FIRST_TENANT, async () => {
			await replaceConnectedCards(
				'plaid',
				FIRST_CONNECTION,
				[snapshot('contended-account')],
				'2027-03-12T12:00:00Z'
			);
			const card = (await listCards())[0];
			let attempts = 0;
			adapter.beforeQuery = async (text) => {
				if (!text.trimStart().startsWith('UPDATE')) return;
				attempts += 1;
				await replaceConnectedCards(
					'plaid',
					FIRST_CONNECTION,
					[snapshot('contended-account', 8_000 + attempts)],
					'2027-03-13T12:00:00Z'
				);
			};
			await expect(
				updateCardCreditLimitReview(card.id, { creditLimitReview: REVIEW })
			).rejects.toMatchObject({ code: 'CARD_CHANGED', status: 409 });
			expect(attempts).toBe(3);
			expect(await getCard(card.id)).toMatchObject({
				creditLimitReview: null,
				currentBalanceCents: 8_003
			});
		});
	});
});
