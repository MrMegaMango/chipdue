import { createHash } from 'node:crypto';

/** @type {ReadonlyArray<readonly [string, RegExp]>} */
export const googleCredentialRules = Object.freeze([
	[
		'configured-google-client-id',
		/CARDDUE_GOOGLE_CLIENT_ID["']?\s*(?:=|:)\s*["']?(?!(?:replace|example|your|<))[0-9]{6,}-[A-Za-z0-9_-]{8,}\.apps\.googleusercontent\.com/i
	],
	[
		'configured-google-client-secret',
		/CARDDUE_GOOGLE_CLIENT_SECRET["']?\s*(?:=|:)\s*["']?(?!(?:replace|example|your|<))(?:GOCSPX-)?[A-Za-z0-9_-]{16,}/i
	]
]);

const reviewedPaymentCardScanExemptions = new Map([
	['static/google-sign-in.svg', '41deee3fd8e1b69421fbf57fdd756e36ae75c3b21cdd41d49dae8c7b70950298']
]);

/**
 * @param {string} file
 * @param {Buffer} buffer
 */
export function isReviewedPaymentCardScanExempt(file, buffer) {
	const expected = reviewedPaymentCardScanExemptions.get(file);
	if (!expected) return false;
	return createHash('sha256').update(buffer).digest('hex') === expected;
}
