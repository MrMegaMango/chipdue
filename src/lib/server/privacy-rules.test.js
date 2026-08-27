import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	googleCredentialRules,
	isReviewedPaymentCardScanExempt
} from '../../../scripts/privacy-rules.mjs';

/** @param {string} value */
function matchingRules(value) {
	return googleCredentialRules.filter(([, pattern]) => pattern.test(value)).map(([name]) => name);
}

const clientIdName = ['CARDDUE', 'GOOGLE', 'CLIENT', 'ID'].join('_');
const clientSecretName = ['CARDDUE', 'GOOGLE', 'CLIENT', 'SECRET'].join('_');

describe('Google credential privacy rules', () => {
	it('rejects configured client identifiers and secrets', () => {
		const clientId =
			['123456789012', 'syntheticclientvalue'].join('-') + '.apps.googleusercontent.com';
		const clientSecret = ['GOCSPX', 'syntheticSecretValue123456'].join('-');

		expect(matchingRules(`${clientIdName}=${clientId}`)).toContain('configured-google-client-id');
		expect(matchingRules(`"${clientSecretName}": "${clientSecret}"`)).toContain(
			'configured-google-client-secret'
		);
	});

	it('allows documentation placeholders', () => {
		expect(matchingRules(`${clientIdName}=replace_with_google_web_client_id`)).toEqual([]);
		expect(matchingRules(`${clientSecretName}=<google-client-secret>`)).toEqual([]);
		expect(matchingRules(`${clientSecretName}=example_google_client_secret`)).toEqual([]);
	});

	it('exempts only the byte-exact reviewed Google asset from card-number heuristics', () => {
		const asset = readFileSync(new URL('../../../static/google-sign-in.svg', import.meta.url));

		expect(isReviewedPaymentCardScanExempt('static/google-sign-in.svg', asset)).toBe(true);
		expect(
			isReviewedPaymentCardScanExempt(
				'static/google-sign-in.svg',
				Buffer.concat([asset, Buffer.from('\n')])
			)
		).toBe(false);
		expect(isReviewedPaymentCardScanExempt('static/other.svg', asset)).toBe(false);
	});
});
