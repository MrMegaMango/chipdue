import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	authorizeGoogleCallbackResult,
	cardBrandForIssuer,
	canOfferGoogleLogin,
	canShowGoogleBootstrap,
	canShowPasswordLogin,
	GOOGLE_BOOTSTRAP_CONTINUE_TO,
	formatRewardEstimate,
	formatRewardRate,
	googleCalendarEventUrl,
	hasPaymentDue,
	inputToCents,
	inputToRewardRate,
	isApprovedBootstrapContinuation,
	isGoogleOnlyCloudMode,
	isValidOptionalAmount,
	isValidSetupToken,
	LAST_FOUR_PATTERN,
	payInFullTarget,
	parseGoogleCallbackResult
} from './+page.svelte';

describe('Google Calendar event links', () => {
	it('opens an all-day event draft without disclosing payment amounts', () => {
		const value = googleCalendarEventUrl({
			nickname: 'Daily, card',
			dueDate: '2027-02-28'
		});
		expect(value).not.toBeNull();
		const url = new URL(value!);
		expect(url.origin).toBe('https://calendar.google.com');
		expect(url.pathname).toBe('/calendar/render');
		expect(url.searchParams.get('action')).toBe('TEMPLATE');
		expect(url.searchParams.get('text')).toBe('Daily, card payment due');
		expect(url.searchParams.get('dates')).toBe('20270228/20270301');
		expect(url.searchParams.get('details')).toBeNull();
		expect(value).not.toContain('$');
	});

	it('rejects invalid dates instead of opening a malformed Google event', () => {
		expect(googleCalendarEventUrl({ nickname: 'Card', dueDate: '2027-02-30' })).toBeNull();
		expect(googleCalendarEventUrl({ nickname: 'Card', dueDate: 'not-a-date' })).toBeNull();
	});

	it('makes Google Calendar primary and keeps the calendar file as a fallback', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('Add to Google Calendar');
		expect(source).toContain('Review and save each due date in Google Calendar.');
		expect(source).toContain('Download .ics instead');
	});
});

describe('manual card form conversions', () => {
	it('converts the numeric values emitted by number inputs without treating them as strings', () => {
		expect(inputToCents(123.45)).toBe(12_345);
		expect(inputToCents(0)).toBe(0);
		expect(inputToCents(undefined)).toBeNull();
	});

	it('continues to handle string values used when editing and blank optional amounts', () => {
		expect(inputToCents('123.45')).toBe(12_345);
		expect(inputToCents('')).toBeNull();
		expect(inputToCents('   ')).toBeNull();
	});

	it('treats a cleared number input as blank while rejecting non-finite values', () => {
		let inputValue: number | undefined = 42.5;
		expect(isValidOptionalAmount(inputValue)).toBe(true);

		inputValue = undefined;
		expect(isValidOptionalAmount(inputValue)).toBe(true);
		expect(isValidOptionalAmount(null)).toBe(true);
		expect(isValidOptionalAmount('')).toBe(true);
		expect(isValidOptionalAmount(Number.NaN)).toBe(false);
		expect(isValidOptionalAmount(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isValidOptionalAmount('not-a-number')).toBe(false);
		expect(isValidOptionalAmount(-0.01)).toBe(false);
	});

	it('accepts exactly four ASCII digits for a card suffix', () => {
		const lastFour = new RegExp(`^(?:${LAST_FOUR_PATTERN})$`);
		expect(lastFour.test('4242')).toBe(true);
		expect(lastFour.test('123')).toBe(false);
		expect(lastFour.test('12345')).toBe(false);
		expect(lastFour.test('12a4')).toBe(false);
	});
});

describe('Google callback marker parsing', () => {
	it('offers configured cloud login without exposing anonymous link status', () => {
		expect(canOfferGoogleLogin('cloud', true)).toBe(true);
		expect(canOfferGoogleLogin('cloud', false)).toBe(false);
		expect(canOfferGoogleLogin('local', true)).toBe(false);
	});

	it('accepts only the fixed result markers emitted by the server', () => {
		expect(parseGoogleCallbackResult('login')).toBe('login');
		expect(parseGoogleCallbackResult('linked')).toBe('linked');
		expect(parseGoogleCallbackResult('error')).toBe('error');
		expect(parseGoogleCallbackResult('linked<script>')).toBeNull();
		expect(parseGoogleCallbackResult('anything-else')).toBeNull();
		expect(parseGoogleCallbackResult(null)).toBeNull();
	});

	it('requires authoritative authenticated and linked session state for success', () => {
		expect(authorizeGoogleCallbackResult('login', true, true)).toBe('login');
		expect(authorizeGoogleCallbackResult('linked', true, true)).toBe('linked');
		expect(authorizeGoogleCallbackResult('login', false, true)).toBe('error');
		expect(authorizeGoogleCallbackResult('linked', true, false)).toBe('error');
		expect(authorizeGoogleCallbackResult('error', false, false)).toBe('error');
	});
});

describe('Google-only setup privacy contract', () => {
	it('never offers password login in Google-only cloud mode', () => {
		expect(isGoogleOnlyCloudMode('cloud', 'google')).toBe(true);
		expect(canShowPasswordLogin('cloud', 'google')).toBe(false);
		expect(canShowPasswordLogin('cloud', 'password')).toBe(true);
		expect(canShowPasswordLogin('local', 'password')).toBe(false);
	});

	it('shows one-time setup only when the backend says bootstrap is available', () => {
		expect(canShowGoogleBootstrap('cloud', 'google', true)).toBe(true);
		expect(canShowGoogleBootstrap('cloud', 'google', false)).toBe(false);
		expect(canShowGoogleBootstrap('cloud', 'password', true)).toBe(false);
		expect(canShowGoogleBootstrap('local', 'local', true)).toBe(false);
	});

	it('explains that a first Google sign-in creates an isolated account', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('Your first sign-in creates it automatically.');
		expect(source).toContain('separate from every other user');
		expect(source).not.toContain('mailto:');
	});

	it('accepts only the fixed-size one-time setup token format', () => {
		expect(isValidSetupToken('a'.repeat(43))).toBe(true);
		expect(isValidSetupToken(`${'a'.repeat(42)}+`)).toBe(false);
		expect(isValidSetupToken('a'.repeat(42))).toBe(false);
		expect(isValidSetupToken('a'.repeat(44))).toBe(false);
	});

	it('allows only the compile-time same-origin continuation path', () => {
		expect(isApprovedBootstrapContinuation(GOOGLE_BOOTSTRAP_CONTINUE_TO)).toBe(true);
		expect(isApprovedBootstrapContinuation('https://accounts.google.com/')).toBe(false);
		expect(
			isApprovedBootstrapContinuation('/api/auth/google/bootstrap/continue?token=example')
		).toBe(false);
		expect(isApprovedBootstrapContinuation(null)).toBe(false);
	});

	it('does not read setup codes from URLs, storage, or the clipboard', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).not.toContain("searchParams.get('setup')");
		expect(source).not.toContain('#setup=');
		expect(source).not.toContain('localStorage');
		expect(source).not.toContain('sessionStorage');
		expect(source).not.toContain('navigator.clipboard');
		expect(source).not.toMatch(/location\.(?:assign|replace)\([^)]*setupToken/);
		expect(source).toContain('window.location.assign(resolve(GOOGLE_BOOTSTRAP_CONTINUE_TO))');
	});

	it('defers callback URL cleanup until after SvelteKit hydration', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toMatch(
			/initializeAuth\(\)\.finally\(async \(\) => \{[\s\S]*replaceState\(resolve\('\/'\), \{\}\);[\s\S]*\}\);/
		);
		expect(source).toContain("searchParams.has('google')");
		expect(source).not.toContain('Boolean(window.location.search || window.location.hash)');
	});
});

describe('card activity preview', () => {
	it('offers one-time card selection when Plaid sends a generic product name', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('Plaid sent a generic card name. Choose the card once');
		expect(source).toContain('Which card is this?');
		expect(source).toContain('Fill reward details');
		expect(source).toContain("method: 'PUT'");
		expect(source).toContain("resolve('/api/cards/[id]/rewards/profile', { id: card.id })");
		expect(source).toContain("profile.issuer === 'American Express'");
		expect(source).toContain("profile.issuer === 'U.S. Bank'");
		expect(source).toContain('does not have a verified reward profile for it yet');
		expect(source).toContain('annual spend cap');
	});

	it('shows three recent transactions and keeps full history behind a button', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).not.toContain('Auto-detected');
		expect(source).toContain('const RECENT_ACTIVITY_LIMIT = 3');
		expect(source).toContain('Recent activity');
		expect(source).toContain('View all activity');
		expect(source).toContain('?limit=${RECENT_ACTIVITY_LIMIT}');
		expect(source).toContain('onclick={() => openTransactionHistory(card)}');
		expect(source).toContain('of ${wholeDollarMoney.format(spending.capCents / 100)} spent in');
		expect(source).toContain('role="progressbar"');
		expect(source).toContain('rewardCategorySpendingByCard');
	});

	it('keeps the card reward preview compact and rate-first', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('const CARD_REWARD_PREVIEW_LIMIT = 4');
		expect(source).toContain(
			'card.rewardCategories.slice(0, CARD_REWARD_PREVIEW_LIMIT) as category'
		);
		expect(source).toContain('class="reward-base"');
		expect(source).toContain(
			'+{card.rewardCategories.length - CARD_REWARD_PREVIEW_LIMIT} more rates'
		);
		expect(source).not.toContain('class="reward-summary"');
	});

	it('places live card activity before static reward reference', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const activityIndex = source.indexOf('class="card-activity-preview"');
		const rewardsIndex = source.indexOf('class="card-rewards"');

		expect(activityIndex).toBeGreaterThan(-1);
		expect(rewardsIndex).toBeGreaterThan(-1);
		expect(activityIndex).toBeLessThan(rewardsIndex);
	});

	it('keeps both activity header labels on one compact line', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toMatch(
			/\.activity-preview-header h4 \{[\s\S]*?font-size: 0\.8rem;[\s\S]*?white-space: nowrap;/
		);
		expect(source).toMatch(
			/\.activity-preview-header button \{[\s\S]*?font-size: 0\.7rem;[\s\S]*?white-space: nowrap;/
		);
	});

	it('formats point, mile, and cash-back estimates in plain language', () => {
		expect(inputToRewardRate(3)).toBe(3);
		expect(inputToRewardRate('1.5')).toBe(1.5);
		expect(inputToRewardRate(0)).toBeNull();
		expect(inputToRewardRate(101)).toBeNull();
		expect(formatRewardRate(3, 'points')).toBe('3x');
		expect(formatRewardRate(2.5, 'cash_back')).toBe('2.5%');
		expect(
			formatRewardEstimate({
				type: 'points',
				amount: 37,
				rate: 3,
				categoryName: 'Dining',
				currency: 'USD'
			})
		).toBe('Est. 37 points');
		expect(
			formatRewardEstimate({
				type: 'cash_back',
				amount: 37,
				rate: 3,
				categoryName: 'Dining',
				currency: 'USD'
			})
		).toBe('Est. $0.37 cash back');
	});
});

describe('credit-card payment status', () => {
	it('prioritizes statement balances and their deadlines over minimum payments', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).not.toContain('Pay to avoid interest');
		expect(source).not.toContain('Minimum payments due');
		expect(source).toContain('Statement balances to pay');
		expect(source).toContain("payment.source === 'statement' ? 'Pay by' : 'Reported due date'");
	});

	it('uses the statement balance as the pay-in-full target', () => {
		expect(payInFullTarget(17_522, 4_000, 28_139)).toEqual({
			label: 'Statement balance to pay',
			amountCents: 17_522,
			source: 'statement'
		});
	});

	it('shows no payment due when the minimum is zero, regardless of the historical statement', () => {
		expect(payInFullTarget(19_977, 0, -1_545)).toEqual({
			label: 'No payment due',
			amountCents: 0,
			source: 'none'
		});
		expect(hasPaymentDue(19_977, 0, -1_545, '2026-09-01')).toBe(false);
	});

	it('does not substitute the current balance when the statement balance is unavailable', () => {
		expect(payInFullTarget(null, 3_000, 147_657)).toEqual({
			label: 'Statement balance unavailable',
			amountCents: null,
			source: 'unavailable'
		});
		expect(payInFullTarget(null, null, null)).toEqual({
			label: 'Statement balance unavailable',
			amountCents: null,
			source: 'unavailable'
		});
	});

	it('never presents a negative current balance as money owed', () => {
		expect(payInFullTarget(20_000, 2_500, -1_000)).toEqual({
			label: 'No payment due',
			amountCents: 0,
			source: 'none'
		});
		expect(hasPaymentDue(20_000, 2_500, -1_000, '2026-09-01')).toBe(false);
	});

	it('uses a reported due date only when the amount and balance do not rule out a payment', () => {
		expect(hasPaymentDue(12_000, null, 15_000, '2026-09-01')).toBe(true);
		expect(hasPaymentDue(null, null, null, '2026-09-01')).toBe(true);
		expect(hasPaymentDue(12_000, null, 15_000, null)).toBe(false);
	});
});

describe('issuer branding', () => {
	it('recognizes local logo fallbacks without matching unrelated names', () => {
		expect(cardBrandForIssuer('Venmo - Personal')).toBe('venmo');
		expect(cardBrandForIssuer('VENMO')).toBe('venmo');
		expect(cardBrandForIssuer('Chase')).toBe('chase');
		expect(cardBrandForIssuer('JPMorgan Chase Bank')).toBe('chase');
		expect(cardBrandForIssuer('Vio Bank')).toBe('vio-bank');
		expect(cardBrandForIssuer('VIO   BANK Online Savings')).toBe('vio-bank');
		expect(cardBrandForIssuer('Wells Fargo')).toBe('wells-fargo');
		expect(cardBrandForIssuer('WELLS   FARGO BANK')).toBe('wells-fargo');
		expect(cardBrandForIssuer('Venmoney Bank')).toBeNull();
		expect(cardBrandForIssuer('Viola Bank')).toBeNull();
		expect(cardBrandForIssuer('Wellspring Fargo Bank')).toBeNull();
		expect(cardBrandForIssuer(null)).toBeNull();
	});

	it('shows stored Plaid institution logos and keeps local bank fallbacks', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('{#if card.issuerLogoUrl}');
		expect(source).toContain('connectionLogoUrl(connection)');
		expect(source).toContain('asset(`/brands/${brand}.svg`)');
		expect(source).not.toContain('paypalobjects.com');
	});
});

describe('banking visual identity', () => {
	it('uses the ink-and-cobalt palette without the decorative card stripe', () => {
		const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const layoutSource = readFileSync(new URL('./layout.css', import.meta.url), 'utf8');
		expect(pageSource).not.toContain('class="card-accent"');
		expect(pageSource).not.toContain('var(--green');
		expect(layoutSource).toContain('--ink: #111827');
		expect(layoutSource).toContain('--accent: #3d5afe');
		expect(layoutSource).toContain('background: #f1ede5');
	});

	it('uses the native UI font and readable secondary-text contrast', () => {
		const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		const layoutSource = readFileSync(new URL('./layout.css', import.meta.url), 'utf8');
		expect(layoutSource).not.toContain("'Avenir Next'");
		expect(layoutSource).toContain('--muted: #465163');
		expect(layoutSource).toContain('--faint: #5f697a');
		expect(pageSource).toMatch(
			/\.activity-preview-header h4 \{[\s\S]*?font-size: 0\.8rem;[\s\S]*?font-weight: 700;/
		);
		expect(pageSource).toMatch(
			/\.activity-preview-list span \{[\s\S]*?color: var\(--faint\);[\s\S]*?font-size: 0\.74rem;/
		);
	});

	it('lays out four cards across on desktop', () => {
		const pageSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(pageSource).toContain('grid-template-columns: repeat(4, minmax(0, 1fr))');
	});
});

describe('returning-user overview', () => {
	it('replaces onboarding copy with a compact overview toolbar after any record is added', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('workspaceAccounts.length === 0');
		expect(source).toContain('workspaceBonuses.length === 0');
		expect(source).toContain("{#if showOnboardingHero && currentSection === 'overview'}");
		expect(source).toContain(
			"class:dashboard-toolbar={!showOnboardingHero || currentSection !== 'overview'}"
		);
		expect(source).toContain('<h1 id="page-title">Overview</h1>');
		expect(source).toContain('Your money, deadlines, and active offers at a glance.');
		expect(source).toContain(
			"class:visually-hidden={!showOnboardingHero || currentSection === 'cards'}"
		);
	});
});
