import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accountsSource = readFileSync(new URL('./accounts/+page.svelte', import.meta.url), 'utf8');
const bonusesSource = readFileSync(new URL('./bonuses/+page.svelte', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const etradeSource = readFileSync(new URL('./etrade/+page.svelte', import.meta.url), 'utf8');

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

	it('shows institution branding on account cards', () => {
		expect(accountsSource).toContain('account.institutionLogoUrl');
		expect(accountsSource).toContain("asset('/brands/wells-fargo.svg')");
		expect(accountsSource).toContain('class="institution-mark"');
		expect(accountsSource).toContain('alt={`${account.institution ?? account.nickname} logo`}');
	});

	it('separates cash and brokerage accounts into distinct groups', () => {
		expect(accountsSource).toContain("title: 'Cash accounts'");
		expect(accountsSource).toContain("account.accountType !== 'brokerage'");
		expect(accountsSource).toContain("title: 'Brokerage accounts'");
		expect(accountsSource).toContain("account.accountType === 'brokerage'");
		expect(accountsSource).toContain('{#each accountGroups as accountGroup');
	});

	it('shows provider activity and explains the open-order limitation', () => {
		expect(accountsSource).toContain("'Recent activity'");
		expect(accountsSource).toContain("'Investment activity'");
		expect(accountsSource).toContain('investmentDetails');
		expect(accountsSource).toContain("resolve('/api/accounts/[id]/transactions'");
		expect(accountsSource).toContain('<h4>Open orders</h4>');
		expect(accountsSource).toContain('Plaid does not provide open-order data.');
	});

	it('adds a read-only official E*TRADE order connection', () => {
		expect(accountsSource).toContain("resolve('/api/accounts/[id]/orders'");
		expect(accountsSource).not.toContain(
			'<a class="finance-button secondary" href={resolve(\'/etrade\')}>E*TRADE orders</a>'
		);
		expect(accountsSource).toContain("? 'Connect E*TRADE'");
		expect(accountsSource).toContain("? 'Reconnect E*TRADE'");
		expect(accountsSource).toContain(": 'Review E*TRADE setup'");
		expect(etradeSource).toContain('Live consumer key');
		expect(etradeSource).toContain('verification code');
		expect(etradeSource).toContain('midnight Eastern');
		expect(etradeSource).toContain('placing, changing, or cancelling trades');
	});

	it('explains cash sweeps without presenting them as stock sales or gains', () => {
		expect(accountsSource).toContain("return action === 'used' ? 'Cash used'");
		expect(accountsSource).toContain('Paid from QACDS for a purchase or withdrawal');
		expect(accountsSource).toContain('QACDS is Chase’s name for uninvested cash');
		expect(accountsSource).toContain('stock sale or investment gain');
		expect(accountsSource).toContain("? 'Fixed at $1.00'");
	});

	it('lets people hide stale accounts and restore them later', () => {
		expect(accountsSource).toContain('Show hidden (');
		expect(accountsSource).toContain('Excluded from your account map and summary totals.');
		expect(accountsSource).toContain('setAccountHidden(account, !account.hidden)');
		expect(accountsSource).toContain('undoHiddenAccount');
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

	it('shows generic live trackers backed by verified offer templates', () => {
		for (const marker of [
			'Verified offer',
			'Synced + verified',
			'Manual + verified',
			'Current synced balance',
			'Likely qualifying activity',
			'Official terms',
			'form.offerTemplateId'
		]) {
			expect(bonusesSource).toContain(marker);
		}
		expect(accountsSource).toContain('Verified bonus catalog');
		expect(accountsSource).toContain('Choose your offer');
		expect(accountsSource).toContain('window.location.assign(bonusSetupHref(savedAccount))');
		expect(bonusesSource).toContain('Tracker setup needed');
		expect(bonusesSource).toContain("tracker.account.source === 'connected'");
	});

	it('keeps new financial data out of persistent browser storage', () => {
		for (const source of [accountsSource, bonusesSource, etradeSource]) {
			expect(source).not.toContain('localStorage');
			expect(source).not.toContain('sessionStorage');
			expect(source).not.toContain('indexedDB');
		}
	});
});
