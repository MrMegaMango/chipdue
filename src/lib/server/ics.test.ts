import { describe, expect, it } from 'vitest';
import type { Card } from '$lib/types';
import { createCalendar } from './ics';

const card: Card = {
	id: '67f7bfb3-cafb-4522-a151-38807138230a',
	source: 'manual',
	nickname: 'Daily, card',
	issuer: null,
	last4: '1234',
	currency: 'USD',
	statementBalanceCents: 12_345,
	minimumPaymentCents: 2_000,
	currentBalanceCents: null,
	dueDate: '2027-02-28',
	statementDate: null,
	isOverdue: false,
	autopayEnabled: false,
	createdAt: '2027-01-01T00:00:00.000Z',
	updatedAt: '2027-01-01T00:00:00.000Z',
	lastSyncedAt: null
};

describe('calendar export', () => {
	it('exports an all-day reminder without amounts by default', () => {
		const calendar = createCalendar([card], new Date('2027-01-01T00:00:00.000Z'));
		expect(calendar).toContain('DTSTART;VALUE=DATE:20270228');
		expect(calendar).toContain('DTEND;VALUE=DATE:20270301');
		expect(calendar).toContain('SUMMARY:Daily\\, card payment due');
		expect(calendar).not.toContain('$123.45');
	});

	it('includes amounts only when explicitly requested', () => {
		const calendar = createCalendar([card], new Date('2027-01-01T00:00:00.000Z'), true);
		expect(calendar).toContain('Statement balance: $123.45');
		expect(calendar).toContain('Minimum due: $20.00');
	});

	it('escapes bare carriage returns rather than allowing calendar line injection', () => {
		const calendar = createCalendar(
			[{ ...card, nickname: 'Safe card\rX-INJECTED:YES' }],
			new Date('2027-01-01T00:00:00.000Z')
		);
		expect(calendar).toContain('SUMMARY:Safe card\\nX-INJECTED:YES payment due');
		expect(calendar).not.toContain('\rX-INJECTED:YES');
	});
});
