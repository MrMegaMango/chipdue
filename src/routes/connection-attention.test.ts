import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('connection attention state', () => {
	it('turns a connection requiring reauthentication into a prominent repair action', () => {
		expect(dashboardSource).toMatch(
			/class:needs-update=\{\s*connection.status === 'needs_update' &&\s*!connection.syncPaused\s*\}/
		);
		expect(dashboardSource).toContain('Reconnect to resume syncing');
		expect(dashboardSource).toContain('Repair connection');
		expect(dashboardSource).toMatch(
			/class:repair-connection=\{\s*connection.status === 'needs_update' &&\s*!connection.syncPaused\s*\}/
		);
		expect(dashboardSource).toContain('`Repair ${connectionLabel(connection)} connection`');
		expect(dashboardSource).toContain('.connection-list > li.needs-update');
		expect(dashboardSource).toContain('.update-connection.repair-connection');
	});
});
