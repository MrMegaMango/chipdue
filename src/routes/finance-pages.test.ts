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
		expect(accountsSource).toContain('Current price');
		expect(accountsSource).toContain('account.holdings');
	});

	it('separates cash and brokerage accounts into distinct groups', () => {
		expect(accountsSource).toContain("title: 'Cash accounts'");
		expect(accountsSource).toContain("account.accountType !== 'brokerage'");
		expect(accountsSource).toContain("title: 'Brokerage accounts'");
		expect(accountsSource).toContain("account.accountType === 'brokerage'");
		expect(accountsSource).toContain('{#each accountGroups as accountGroup');
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

	it('shows a live Wells Fargo tracker for the linked business checking offer', () => {
		for (const marker of [
			'Linked Wells Fargo tracker',
			'Current synced balance',
			'Likely qualifying activity',
			'Check Wells Fargo now',
			'WELLS_FARGO_BUSINESS_BONUS_TIERS'
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
