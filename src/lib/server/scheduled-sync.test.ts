import { afterEach, describe, expect, it } from 'vitest';
import {
	resetCloudDatabaseForTests,
	setCloudDatabaseAdapterForTests,
	type CloudDatabaseAdapter,
	type CloudRow
} from './cloud-database';
import { AppError } from './errors';
import {
	assertScheduledSyncRequest,
	claimScheduledSync,
	completeScheduledSync,
	failScheduledSync,
	scheduledSyncWindow
} from './scheduled-sync';

describe.sequential('scheduled Plaid synchronization', () => {
	afterEach(() => {
		resetCloudDatabaseForTests();
	});

	it('selects the Pacific daylight and standard time windows', () => {
		expect(scheduledSyncWindow('morning-pdt', new Date('2026-08-28T15:15:00Z'))).toEqual({
			period: 'morning',
			localDate: '2026-08-28'
		});
		expect(scheduledSyncWindow('morning-pst', new Date('2026-12-28T16:15:00Z'))).toEqual({
			period: 'morning',
			localDate: '2026-12-28'
		});
		expect(scheduledSyncWindow('evening-pdt', new Date('2026-08-29T00:15:00Z'))).toEqual({
			period: 'evening',
			localDate: '2026-08-28'
		});
		expect(scheduledSyncWindow('evening-pst', new Date('2026-12-29T01:15:00Z'))).toEqual({
			period: 'evening',
			localDate: '2026-12-28'
		});
	});

	it('allows a later candidate or manual run to catch up a missed period', () => {
		expect(scheduledSyncWindow('morning-pst', new Date('2026-08-28T16:15:00Z'))).toEqual({
			period: 'morning',
			localDate: '2026-08-28'
		});
		expect(scheduledSyncWindow('morning-pdt', new Date('2026-08-28T17:15:00Z'))).toEqual({
			period: 'morning',
			localDate: '2026-08-28'
		});
		expect(scheduledSyncWindow('evening-pst', new Date('2026-08-29T01:15:00Z'))).toEqual({
			period: 'evening',
			localDate: '2026-08-28'
		});
	});

	it('skips candidates before their Pacific period and malformed requests', () => {
		expect(scheduledSyncWindow('morning-pdt', new Date('2026-12-28T15:15:00Z'))).toBeNull();
		expect(scheduledSyncWindow('evening-pdt', new Date('2026-12-29T00:15:00Z'))).toBeNull();
		expect(scheduledSyncWindow('unknown', new Date('2026-08-28T15:15:00Z'))).toBeNull();
		expect(scheduledSyncWindow('morning-pdt', new Date('invalid'))).toBeNull();
	});

	it('requires both Vercel Cron identity and the shared secret', () => {
		const secret = 'x'.repeat(32);
		const authorized = new Request('https://chipdue.example/api/cron', {
			headers: {
				authorization: `Bearer ${secret}`,
				'user-agent': 'vercel-cron/1.0'
			}
		});
		expect(() => assertScheduledSyncRequest(authorized, secret)).not.toThrow();

		for (const request of [
			new Request('https://chipdue.example/api/cron', {
				headers: { authorization: 'Bearer wrong', 'user-agent': 'vercel-cron/1.0' }
			}),
			new Request('https://chipdue.example/api/cron', {
				headers: { authorization: `Bearer ${secret}`, 'user-agent': 'browser' }
			})
		]) {
			expect(() => assertScheduledSyncRequest(request, secret)).toThrow(AppError);
		}
		expect(() => assertScheduledSyncRequest(authorized, 'short')).toThrowError(
			'Scheduled synchronization is unavailable.'
		);
	});

	it('claims each period atomically and records completion or failure', async () => {
		const calls: Array<{ text: string; params: unknown[] }> = [];
		let claimAvailable = true;
		const adapter: CloudDatabaseAdapter = {
			async query<T extends CloudRow>(text: string, params: unknown[] = []): Promise<T[]> {
				calls.push({ text, params });
				if (text.includes('INSERT INTO public.carddue_metadata') && claimAvailable) {
					return [{ value: String(params[1]) }] as unknown as T[];
				}
				return [];
			},
			async transaction(): Promise<CloudRow[][]> {
				return [];
			}
		};
		setCloudDatabaseAdapterForTests(adapter);
		const window = { period: 'morning' as const, localDate: '2026-08-28' };

		expect(await claimScheduledSync(window)).toBe(true);
		claimAvailable = false;
		expect(await claimScheduledSync(window)).toBe(false);
		await completeScheduledSync(window);
		await failScheduledSync(window);

		expect(calls[0]?.params).toEqual([
			'scheduled_plaid_sync_morning',
			'2026-08-28|running',
			'2026-08-28|done'
		]);
		expect(calls.at(-2)?.params).toEqual([
			'2026-08-28|done',
			'scheduled_plaid_sync_morning',
			'2026-08-28|running'
		]);
		expect(calls.at(-1)?.params).toEqual([
			'2026-08-28|failed',
			'scheduled_plaid_sync_morning',
			'2026-08-28|running'
		]);
	});
});
