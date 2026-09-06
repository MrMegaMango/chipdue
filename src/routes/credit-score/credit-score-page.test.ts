import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const chartSource = readFileSync(
	new URL('../../lib/components/CreditScoreChart.svelte', import.meta.url),
	'utf8'
);
const headerSource = readFileSync(
	new URL('../../lib/components/WorkspaceHeader.svelte', import.meta.url),
	'utf8'
);

describe('credit score workspace', () => {
	it('makes the private score tracker a first-class workspace tab', () => {
		expect(headerSource).toContain("label: 'Score'");
		expect(headerSource).toContain("href: '/credit-score'");
		expect(pageSource).toContain("resolve('/api/credit-scores')");
	});

	it('shows like-for-like changes, a trend chart, and official pre-approval tools', () => {
		expect(pageSource).toContain('previousComparableScore');
		expect(chartSource).toContain('Compare readings from the same bureau');
		expect(pageSource).toContain('Check card bonuses without applying');
		expect(chartSource).toContain('Your trend');
		expect(chartSource).toContain('score-band');
	});

	it('keeps score data out of persistent browser storage', () => {
		expect(pageSource).not.toContain('localStorage');
		expect(pageSource).not.toContain('sessionStorage');
		expect(pageSource).not.toContain('indexedDB');
	});
});
