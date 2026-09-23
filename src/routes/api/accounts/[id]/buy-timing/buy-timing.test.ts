import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountBuyTiming } from '$lib/server/buy-timing-service';
import { AppError } from '$lib/server/errors';
import { GET } from './+server';

vi.mock('$lib/server/buy-timing-service', () => ({ accountBuyTiming: vi.fn() }));
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001';

beforeEach(() => vi.resetAllMocks());

function request(query = '', id = ACCOUNT_ID) {
	return GET({
		params: { id },
		url: new URL(`http://localhost/api/accounts/${id}/buy-timing?${query}`)
	} as never);
}

describe('buy timing endpoint', () => {
	it('uses safe defaults and private response headers', async () => {
		vi.mocked(accountBuyTiming).mockResolvedValue({
			comparison: { status: 'unavailable', reason: 'no_buys', message: 'No purchases.' },
			coverage: {
				transactionCount: 0,
				buyCount: 0,
				includedBuyCount: 0,
				postedDateBuyCount: 0,
				excludedBuyCount: 0,
				excludedAmountCents: 0,
				exclusions: [],
				activitySyncedAt: null,
				rangeStartDate: '2026-01-01',
				rangeEndDate: '2026-08-31',
				capped: false
			},
			priceFetchedAt: null
		});
		const response = await request();
		expect(response.status).toBe(200);
		expect(accountBuyTiming).toHaveBeenCalledWith(ACCOUNT_ID, 'ALL', 'monthly');
		expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
		expect(response.headers.get('pragma')).toBe('no-cache');
	});

	it.each([
		'range=2Y',
		'schedule=daily',
		'ticker=AAA',
		'range=1Y&range=ALL',
		'schedule=monthly&schedule=weekly',
		'start=2026-01-01',
		'accountId=private'
	])('rejects unsupported or duplicate parameters: %s', async (query) => {
		expect((await request(query)).status).toBe(400);
		expect(accountBuyTiming).not.toHaveBeenCalled();
	});

	it('rejects invalid account identifiers before analysis', async () => {
		expect((await request('', '../private')).status).toBe(400);
		expect(accountBuyTiming).not.toHaveBeenCalled();
	});

	it('retains tenant-scoped not-found responses without exposing internals', async () => {
		vi.mocked(accountBuyTiming).mockRejectedValue(
			new AppError('ACCOUNT_NOT_FOUND', 'Account not found.', 404)
		);
		const response = await request('range=YTD&schedule=biweekly');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: { code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' }
		});
		expect(accountBuyTiming).toHaveBeenCalledWith(ACCOUNT_ID, 'YTD', 'biweekly');
	});
});
