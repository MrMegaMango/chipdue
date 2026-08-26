import { describe, expect, it } from 'vitest';
import { createManualCardSchema, isoDateSchema, updateManualCardSchema } from './schemas';

describe('card request validation', () => {
	it('rejects impossible calendar dates', () => {
		expect(isoDateSchema.safeParse('2027-02-29').success).toBe(false);
		expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
	});

	it('accepts only the last four characters rather than a full card number', () => {
		const tooManyDigits = Array.from({ length: 4 }, () => '4111').join('');
		expect(createManualCardSchema.safeParse({ nickname: 'Card', last4: '1234' }).success).toBe(
			true
		);
		expect(
			createManualCardSchema.safeParse({ nickname: 'Card', last4: tooManyDigits }).success
		).toBe(false);
	});

	it('requires at least one field for updates', () => {
		expect(updateManualCardSchema.safeParse({}).success).toBe(false);
	});
});
