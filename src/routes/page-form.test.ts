import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ACCESS_REQUEST_PATH,
	authorizeGoogleCallbackResult,
	cardBrandForIssuer,
	canOfferGoogleLogin,
	canShowGoogleBootstrap,
	canShowPasswordLogin,
	GOOGLE_BOOTSTRAP_CONTINUE_TO,
	inputToCents,
	interestSavingTarget,
	isApprovedBootstrapContinuation,
	isGoogleOnlyCloudMode,
	isValidOptionalAmount,
	isValidSetupToken,
	LAST_FOUR_PATTERN,
	parseGoogleCallbackResult
} from './+page.svelte';

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

	it('offers an invite request addressed to the configured admin', () => {
		expect(ACCESS_REQUEST_PATH).toBe('/api/access-request');
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('ChipDue is invite-only.');
		expect(source).toContain('Notify Admin');
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
			/initializeAuth\(\)\.finally\(\(\) => \{[\s\S]*replaceState\(resolve\('\/'\), \{\}\);[\s\S]*\}\);/
		);
	});
});

describe('card activity preview', () => {
	it('shows three recent transactions and keeps full history behind a button', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('const RECENT_ACTIVITY_LIMIT = 3');
		expect(source).toContain('Recent activity');
		expect(source).toContain('View all activity');
		expect(source).toContain('?limit=${RECENT_ACTIVITY_LIMIT}');
		expect(source).toContain('onclick={() => openTransactionHistory(card)}');
	});
});

describe('interest-saving payment target', () => {
	it('prioritizes the reported statement balance over the current balance', () => {
		expect(interestSavingTarget(120_000, 145_000)).toEqual({
			amountCents: 120_000,
			source: 'statement'
		});
	});

	it('uses a clearly identified current-balance estimate when the statement is unavailable', () => {
		expect(interestSavingTarget(null, 145_000)).toEqual({
			amountCents: 145_000,
			source: 'current'
		});
		expect(interestSavingTarget(null, null)).toEqual({
			amountCents: null,
			source: 'unavailable'
		});
	});

	it('never suggests paying a negative balance', () => {
		expect(interestSavingTarget(-2_500, -1_000)).toEqual({
			amountCents: 0,
			source: 'statement'
		});
	});
});

describe('issuer branding', () => {
	it('recognizes local logo fallbacks without matching unrelated names', () => {
		expect(cardBrandForIssuer('Venmo - Personal')).toBe('venmo');
		expect(cardBrandForIssuer('VENMO')).toBe('venmo');
		expect(cardBrandForIssuer('Chase')).toBe('chase');
		expect(cardBrandForIssuer('JPMorgan Chase Bank')).toBe('chase');
		expect(cardBrandForIssuer('Venmoney Bank')).toBeNull();
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
			/\.activity-preview-header h4 \{[\s\S]*?font-size: 0\.9rem;[\s\S]*?font-weight: 700;/
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

describe('returning-user dashboard', () => {
	it('replaces onboarding copy with a compact toolbar after any financial record is added', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		expect(source).toContain('workspaceAccounts.length === 0');
		expect(source).toContain('workspaceBonuses.length === 0');
		expect(source).toContain('{#if showOnboardingHero}');
		expect(source).toContain('class:dashboard-toolbar={!showOnboardingHero}');
		expect(source).toContain('Financial command center');
		expect(source).toContain('class:visually-hidden={!showOnboardingHero}');
	});
});
