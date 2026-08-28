import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	authorizeGoogleCallbackResult,
	canOfferGoogleLogin,
	canShowGoogleBootstrap,
	canShowPasswordLogin,
	GOOGLE_BOOTSTRAP_CONTINUE_TO,
	inputToCents,
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
});
