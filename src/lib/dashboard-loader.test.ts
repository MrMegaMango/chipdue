import { describe, expect, it, vi } from 'vitest';
import type { DashboardResponse } from './dashboard';
import { createDashboardLoader } from './dashboard-loader';

function snapshot(lastSyncedAt: string | null = null): DashboardResponse {
	return {
		cards: {
			ok: true,
			data: { cards: [], connections: { providers: [], connected: 0, lastSyncedAt } }
		},
		workspace: { ok: true, data: { accounts: [], bonuses: [] } },
		recentActivity: {}
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function options(request: (epoch: number) => Promise<DashboardResponse>) {
	return {
		isCurrent: (epoch: number): boolean => epoch === 1,
		request: vi.fn(request),
		start: vi.fn(),
		apply: vi.fn((response: DashboardResponse) => response.cards.ok),
		fail: vi.fn(),
		finish: vi.fn()
	};
}

describe('dashboard refreshes', () => {
	it('requests a fresh snapshot on each load without reusing the previous response', async () => {
		const before = snapshot('2026-09-29T15:00:00Z');
		const after = snapshot('2026-09-29T23:00:00Z');
		const hooks = options(() => Promise.resolve(before));
		hooks.request.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
		const load = createDashboardLoader(hooks);

		expect(await load(false, 1)).toBe(true);
		expect(await load(true, 1)).toBe(true);
		expect(hooks.request).toHaveBeenCalledTimes(2);
		expect(hooks.apply.mock.calls).toEqual([[before], [after]]);
		expect(hooks.start.mock.calls).toEqual([[false], [true]]);
		expect(hooks.finish).toHaveBeenCalledTimes(2);
	});

	it('keeps the refresh after a mutation when an earlier request finishes later', async () => {
		const earlier = deferred<DashboardResponse>();
		const refreshed = deferred<DashboardResponse>();
		const hooks = options(() => earlier.promise);
		hooks.request.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(refreshed.promise);
		const load = createDashboardLoader(hooks);
		const initialLoad = load(false, 1);
		const afterMutation = load(true, 1);
		const latest = snapshot('2026-09-30T00:00:00Z');

		refreshed.resolve(latest);
		expect(await afterMutation).toBe(true);
		earlier.resolve(snapshot());
		expect(await initialLoad).toBe(false);
		expect(hooks.request).toHaveBeenCalledTimes(2);
		expect(hooks.apply.mock.calls).toEqual([[latest]]);
		expect(hooks.finish).toHaveBeenCalledTimes(1);
	});

	it('does not publish data from a session that signed out and signed back in', async () => {
		let currentEpoch = 1;
		const signedOutRequest = deferred<DashboardResponse>();
		const hooks = options(() => signedOutRequest.promise);
		hooks.isCurrent = (epoch) => epoch === currentEpoch;
		const load = createDashboardLoader(hooks);
		const oldLoad = load(false, 1);
		currentEpoch = 2;

		signedOutRequest.resolve(snapshot());
		expect(await oldLoad).toBe(false);
		expect(hooks.apply).not.toHaveBeenCalled();
		expect(hooks.fail).not.toHaveBeenCalled();
		expect(hooks.finish).not.toHaveBeenCalled();
		expect(await load(false, 1)).toBe(false);
		expect(hooks.request).toHaveBeenCalledTimes(1);

		expect(await load(false, 2)).toBe(true);
		expect(hooks.request).toHaveBeenLastCalledWith(2);
		expect(hooks.apply).toHaveBeenCalledTimes(1);
	});

	it('does not let an earlier error clear the newer loading state', async () => {
		const earlier = deferred<DashboardResponse>();
		const refreshed = deferred<DashboardResponse>();
		const hooks = options(() => earlier.promise);
		hooks.request.mockReturnValueOnce(earlier.promise).mockReturnValueOnce(refreshed.promise);
		const load = createDashboardLoader(hooks);
		const initialLoad = load(false, 1);
		const afterMutation = load(true, 1);

		earlier.reject(new Error('Earlier request failed'));
		expect(await initialLoad).toBe(false);
		expect(hooks.fail).not.toHaveBeenCalled();
		expect(hooks.finish).not.toHaveBeenCalled();

		refreshed.resolve(snapshot());
		expect(await afterMutation).toBe(true);
		expect(hooks.finish).toHaveBeenCalledTimes(1);
	});

	it('reports the current request failure and finishes loading', async () => {
		const failure = new Error('Database unavailable');
		const hooks = options(() => Promise.reject(failure));
		const load = createDashboardLoader(hooks);

		expect(await load(false, 1)).toBe(false);
		expect(hooks.apply).not.toHaveBeenCalled();
		expect(hooks.fail).toHaveBeenCalledWith(failure);
		expect(hooks.finish).toHaveBeenCalledTimes(1);
	});

	it('passes partial section failures through without discarding successful sections', async () => {
		const partial = snapshot();
		partial.workspace = {
			ok: false,
			error: { code: 'DATABASE_ERROR', message: 'Workspace temporarily unavailable' }
		};
		const hooks = options(() => Promise.resolve(partial));
		const load = createDashboardLoader(hooks);

		expect(await load(false, 1)).toBe(true);
		expect(hooks.apply).toHaveBeenCalledWith(partial);
		expect(hooks.fail).not.toHaveBeenCalled();
		expect(hooks.finish).toHaveBeenCalledTimes(1);
	});
});
