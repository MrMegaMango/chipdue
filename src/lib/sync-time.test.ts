import { describe, expect, it } from 'vitest';
import { exactTimestampLabel, relativeTimestampLabel } from './sync-time';

describe('sync time labels', () => {
	const now = new Date('2026-08-29T20:00:00.000Z').getTime();

	it('formats timestamps as live relative ages', () => {
		expect(relativeTimestampLabel('2026-08-29T19:59:45.000Z', now)).toBe('Synced just now');
		expect(relativeTimestampLabel('2026-08-29T19:12:00.000Z', now)).toBe('Synced 48m ago');
		expect(relativeTimestampLabel('2026-08-29T17:30:00.000Z', now)).toBe('Synced 2h ago');
		expect(relativeTimestampLabel('2026-08-27T17:30:00.000Z', now)).toBe('Synced 2d ago');
	});

	it('supports update labels and explicit empty states', () => {
		expect(relativeTimestampLabel('2026-08-29T17:30:00.000Z', now, 'Updated')).toBe(
			'Updated 2h ago'
		);
		expect(relativeTimestampLabel(null, now, 'Synced', 'Waiting for first sync')).toBe(
			'Waiting for first sync'
		);
	});

	it('provides a precise hover label with seconds and a time zone', () => {
		const label = exactTimestampLabel('2026-08-29T19:12:34.000Z');
		expect(label).toMatch(/^Synced Saturday, August 29, 2026 at /);
		expect(label).toContain(':34');
		expect(label).toMatch(/ (UTC|[A-Z]{2,5}|GMT[+-]\d+)$/);
	});
});
