import { describe, expect, it } from 'vitest';
import { preservesDisconnectedOffer } from './+page.svelte';

const acceptedOffer = {
	offerTemplateId: 'capital-one-business-checking-sboffer500-2026',
	accountId: '00000000-0000-4000-8000-000000000001',
	openedDate: '2026-05-01',
	offerDateOverrideConfirmed: false
};

describe('editing a bonus after its account is disconnected', () => {
	it('allows recording payment while retaining the accepted offer', () => {
		const paymentUpdate = { ...acceptedOffer, status: 'paid', paidDate: '2026-10-06' };
		expect(preservesDisconnectedOffer(acceptedOffer, paymentUpdate, null)).toBe(true);
	});

	it('keeps validation for new offers and accounts that are still available', () => {
		expect(preservesDisconnectedOffer(null, acceptedOffer, null)).toBe(false);
		expect(
			preservesDisconnectedOffer(acceptedOffer, acceptedOffer, { id: acceptedOffer.accountId })
		).toBe(false);
	});

	it.each([
		{ offerTemplateId: 'different-offer' },
		{ accountId: '00000000-0000-4000-8000-000000000002' },
		{ accountId: '' },
		{ openedDate: '2026-05-02' },
		{ offerDateOverrideConfirmed: true }
	])('keeps validation when the accepted context changes: %o', (change) => {
		expect(preservesDisconnectedOffer(acceptedOffer, { ...acceptedOffer, ...change }, null)).toBe(
			false
		);
	});

	it.each(['offerTemplateId', 'accountId', 'openedDate'] as const)(
		'requires a saved %s before preserving an accepted offer',
		(field) => {
			expect(
				preservesDisconnectedOffer({ ...acceptedOffer, [field]: null }, acceptedOffer, null)
			).toBe(false);
		}
	);
});
