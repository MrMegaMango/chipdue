import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accountsSource = readFileSync(new URL('./accounts/+page.svelte', import.meta.url), 'utf8');
const bonusesSource = readFileSync(new URL('./bonuses/+page.svelte', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');

describe('financial workspace navigation', () => {
	it('makes accounts and bonuses first-class parts of the dashboard', () => {
		expect(dashboardSource).toContain("href={resolve('/accounts')}");
		expect(dashboardSource).toContain("href={resolve('/bonuses')}");
		expect(dashboardSource).toContain('Payments &amp; deadlines');
		expect(dashboardSource).toContain('activeBonusValueCents');
	});

	it('supports personal, business, and brokerage account tracking', () => {
		expect(accountsSource).toContain('<option value="business">Business</option>');
		expect(accountsSource).toContain('<option value="brokerage">Brokerage</option>');
		expect(accountsSource).toContain('Cost basis / contributions');
		expect(accountsSource).toContain('Brokerage performance');
	});

	it('tracks the full bonus lifecycle and manual requirements', () => {
		for (const marker of [
			'Requirement deadline',
			'Expected payout',
			'Safe to close',
			'Payout pending',
			'toggleRequirement'
		]) {
			expect(bonusesSource).toContain(marker);
		}
	});

	it('keeps new financial data out of persistent browser storage', () => {
		for (const source of [accountsSource, bonusesSource]) {
			expect(source).not.toContain('localStorage');
			expect(source).not.toContain('sessionStorage');
			expect(source).not.toContain('indexedDB');
		}
	});
});
