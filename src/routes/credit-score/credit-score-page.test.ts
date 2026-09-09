import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(new URL('../+page.svelte', import.meta.url), 'utf8');
const headerSource = readFileSync(
	new URL('../../lib/components/WorkspaceHeader.svelte', import.meta.url),
	'utf8'
);
const routeSource = readFileSync(new URL('./+page.server.ts', import.meta.url), 'utf8');

describe('credit score availability', () => {
	it('keeps the status inside Cards instead of a separate workspace tab', () => {
		expect(headerSource).not.toContain("label: 'Score'");
		expect(headerSource).not.toContain("href: '/credit-score'");
		expect(dashboardSource).toContain('id="credit-score"');
		expect(dashboardSource).toContain('<h2>No free tracker yet</h2>');
		expect(dashboardSource).toContain("window.location.hash === '#credit-score'");
	});

	it('redirects the former score page to the Cards status', () => {
		expect(routeSource).toContain("redirect(308, '/cards#credit-score')");
	});
});
