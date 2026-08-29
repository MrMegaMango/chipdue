import { afterEach, describe, expect, it } from 'vitest';
import { historicalCloseSeries, setMarketHistoryFetchForTests } from './market-history';

afterEach(() => setMarketHistoryFetchForTests());

describe('historical market closes', () => {
	it('requests only an allowlisted symbol and date range', async () => {
		let requestedUrl = '';
		setMarketHistoryFetchForTests(async (input) => {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({
					chart: {
						result: [
							{
								timestamp: [1_777_593_600],
								indicators: { quote: [{ close: [123.45] }] }
							}
						]
					}
				})
			);
		});

		const result = await historicalCloseSeries(['BRK.B'], '2026-05-01', '2026-05-02');

		expect(new URL(requestedUrl).origin).toBe('https://query1.finance.yahoo.com');
		expect(new URL(requestedUrl).pathname).toBe('/v8/finance/chart/BRK-B');
		expect(requestedUrl).not.toContain('account');
		expect(result[0].closes.get('2026-05-01')).toBe(123.45);
	});

	it('does not send invalid ticker text', async () => {
		let calls = 0;
		setMarketHistoryFetchForTests(async () => {
			calls += 1;
			return new Response('{}');
		});

		const result = await historicalCloseSeries(
			['../../private?token=secret'],
			'2026-05-01',
			'2026-05-02'
		);
		expect(calls).toBe(0);
		expect(result[0].closes.size).toBe(0);
	});
});
