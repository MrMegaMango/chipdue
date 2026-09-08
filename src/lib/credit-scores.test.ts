import { describe, expect, it } from 'vitest';
import type { CreditScoreEntry } from '$lib/credit-score-types';
import {
	creditBureauLabel,
	creditScoreChange,
	creditScoreRange,
	previousComparableScore
} from './credit-scores';

function entry(
	id: string,
	score: number,
	bureau: CreditScoreEntry['bureau'],
	recordedDate: string
): CreditScoreEntry {
	return {
		id,
		score,
		bureau,
		model: 'FICO Score 8',
		source: 'Issuer',
		origin: 'manual',
		factors: [],
		recordedDate,
		notes: null,
		createdAt: `${recordedDate}T12:00:00.000Z`,
		updatedAt: `${recordedDate}T12:00:00.000Z`
	};
}

describe('credit score tracking', () => {
	it('labels the standard 300–850 score bands', () => {
		expect(creditScoreRange(579)).toBe('Poor');
		expect(creditScoreRange(580)).toBe('Fair');
		expect(creditScoreRange(670)).toBe('Good');
		expect(creditScoreRange(740)).toBe('Very good');
		expect(creditScoreRange(800)).toBe('Exceptional');
	});

	it('compares a reading only with the previous score from the same bureau', () => {
		const latest = entry('latest', 760, 'experian', '2026-09-01');
		const olderExperian = entry('older-experian', 744, 'experian', '2026-08-01');
		const newerTransUnion = entry('transunion', 799, 'transunion', '2026-08-20');
		const entries = [latest, newerTransUnion, olderExperian];

		expect(previousComparableScore(entries, latest)?.id).toBe('older-experian');
		expect(creditScoreChange(entries, latest)).toBe(16);
	});

	it('uses clear bureau labels', () => {
		expect(creditBureauLabel('transunion')).toBe('TransUnion');
	});
});
