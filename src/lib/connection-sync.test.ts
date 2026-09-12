import { describe, expect, it } from 'vitest';
import { connectionSyncSummary } from './connection-sync';

describe('connection sync controls', () => {
	it('reports partial successes and excluded connections without claiming everything is current', () => {
		expect(
			connectionSyncSummary({ syncedConnections: 2, failedConnections: 1, skippedConnections: 1 })
		).toBe('2 synced, 1 failed, 1 skipped.');
	});

	it('makes an all-paused run distinguishable from successful updates', () => {
		expect(
			connectionSyncSummary({ syncedConnections: 0, failedConnections: 0, skippedConnections: 3 })
		).toBe('0 synced, 0 failed, 3 skipped.');
	});
});
