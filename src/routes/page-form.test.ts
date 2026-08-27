import { describe, expect, it } from 'vitest';
import {
	authorizeGoogleCallbackResult,
	canOfferGoogleLogin,
	inputToCents,
	isValidOptionalAmount,
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
