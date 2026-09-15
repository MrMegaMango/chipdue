import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountBonus, BonusChurn, BonusChurnCondition } from '$lib/types';
import {
	BONUS_CHURN_PRESETS,
	bonusChurnOpenedDate,
	bonusChurnStatusLabel,
	buildBonusChurnTracker,
	formatBonusChurnDate,
	getBonusChurnToday
} from './bonus-churn';

const bonus: AccountBonus = {
	id: '00000000-0000-4000-8000-000000000001',
	accountId: null,
	cardId: null,
	offerTemplateId: null,
	offerDateOverrideConfirmed: false,
	name: 'Business checking bonus',
	institution: 'Wells Fargo',
	rewardCents: 40_000,
	spendTargetCents: null,
	currency: 'USD',
	status: 'paid',
	openedDate: '2024-01-01',
	requirementDeadline: null,
	expectedPayoutDate: '2024-04-01',
	paidDate: '2024-04-15',
	safeToCloseDate: '2024-04-16',
	feeFreeDowngradeDate: null,
	requirements: [],
	notes: null,
	createdAt: '2024-01-01T12:00:00.000Z',
	updatedAt: '2024-04-15T12:00:00.000Z'
};

function churn(changes: Partial<BonusChurn> = {}): BonusChurn {
	return {
		mode: 'rules',
		conditions: [{ anchor: 'paidDate', months: 24, days: 0 }],
		requiresClosed: false,
		closedDate: null,
		manualEligibleDate: null,
		presetId: null,
		sourceUrl: null,
		notes: null,
		...changes
	};
}

afterEach(() => vi.useRealTimers());

describe('repeat bonus eligibility tracking', () => {
	it('prefers the separately recorded actual opening date without changing the offer date', () => {
		const record = {
			...bonus,
			churn: churn({
				openedDate: '2024-02-01',
				conditions: [{ anchor: 'openedDate', months: 24, days: 0 }]
			})
		};
		expect(bonusChurnOpenedDate(record)).toBe('2024-02-01');
		expect(buildBonusChurnTracker(record, '2026-01-31')).toMatchObject({
			status: 'waiting',
			reviewDate: '2026-02-01',
			daysRemaining: 1
		});
		expect(record.openedDate).toBe('2024-01-01');
	});

	it('falls back to the saved account opening date for ordinary offers', () => {
		const record = {
			...bonus,
			churn: churn({
				openedDate: null,
				conditions: [{ anchor: 'openedDate', months: 24, days: 0 }]
			})
		};
		expect(bonusChurnOpenedDate(record)).toBe('2024-01-01');
		expect(buildBonusChurnTracker(record, '2026-01-31')).toMatchObject({
			status: 'ready',
			reviewDate: '2026-01-01'
		});
	});

	it('never uses targeted offer enrollment as the actual account opening date', () => {
		const record = {
			...bonus,
			offerTemplateId: 'etrade-targeted-existing-brokerage-2026-08-19',
			openedDate: '2026-08-19',
			churn: churn({ conditions: [{ anchor: 'openedDate', months: 24, days: 0 }] })
		};
		expect(bonusChurnOpenedDate(record)).toBeNull();
		expect(buildBonusChurnTracker(record, '2026-09-13')).toMatchObject({
			status: 'needs_info',
			reviewDate: null,
			missing: ['Record the actual account opening date.']
		});
		expect(
			buildBonusChurnTracker(
				{ ...record, churn: { ...record.churn, openedDate: '2024-01-01' } },
				'2026-09-13'
			)
		).toMatchObject({
			status: 'ready',
			reviewDate: '2026-01-01'
		});
	});

	it('does not hide an invalid explicit opening date by falling back to the offer date', () => {
		const record = {
			...bonus,
			churn: churn({
				openedDate: '2024-02-30',
				conditions: [{ anchor: 'openedDate', months: 24, days: 0 }]
			})
		};
		expect(buildBonusChurnTracker(record, '2026-09-13')).toMatchObject({
			status: 'needs_info',
			reviewDate: null
		});
	});

	it('leaves both legacy and explicitly cleared records unconfigured', () => {
		for (const record of [bonus, { ...bonus, churn: null }]) {
			expect(buildBonusChurnTracker(record, '2026-09-13')).toMatchObject({
				status: 'unconfigured',
				reviewDate: null,
				daysRemaining: null
			});
		}
	});

	it('requires actual payment and closure dates instead of expected payout or safe-to-close dates', () => {
		const settings = churn({
			conditions: [
				{ anchor: 'paidDate', months: 24, days: 0 },
				{ anchor: 'closedDate', months: 0, days: 90 }
			],
			requiresClosed: true
		});
		expect(
			buildBonusChurnTracker({ ...bonus, paidDate: null, churn: settings }, '2026-09-13')
		).toMatchObject({
			status: 'needs_info',
			reviewDate: null,
			daysRemaining: null,
			missing: ['Record the actual account closure date.', 'Record the actual bonus payment date.']
		});
	});

	it('uses the latest condition, with both payment and closure able to control the review date', () => {
		const settings = churn({
			conditions: [
				{ anchor: 'paidDate', months: 24, days: 0 },
				{ anchor: 'closedDate', months: 0, days: 90 }
			],
			requiresClosed: true,
			closedDate: '2025-01-01'
		});
		expect(buildBonusChurnTracker({ ...bonus, churn: settings }, '2026-04-14')).toMatchObject({
			status: 'waiting',
			reviewDate: '2026-04-15',
			daysRemaining: 1
		});
		expect(
			buildBonusChurnTracker(
				{ ...bonus, churn: { ...settings, closedDate: '2026-04-01' } },
				'2026-04-14'
			)
		).toMatchObject({ status: 'waiting', reviewDate: '2026-06-30', daysRemaining: 77 });
	});

	it('gates a completed cooldown on a real closure when closure is required', () => {
		const settings = churn({ requiresClosed: true });
		expect(
			buildBonusChurnTracker({ ...bonus, status: 'closed', churn: settings }, '2026-09-13')
		).toMatchObject({ status: 'needs_info', reviewDate: null });
		expect(
			buildBonusChurnTracker(
				{ ...bonus, churn: { ...settings, closedDate: '2026-09-13' } },
				'2026-09-13'
			)
		).toMatchObject({ status: 'ready', reviewDate: '2026-09-13', daysRemaining: 0 });
	});

	it('marks the due day and overdue cooldowns for a current-terms review', () => {
		for (const today of ['2026-04-15', '2026-09-13']) {
			const tracker = buildBonusChurnTracker({ ...bonus, churn: churn() }, today);
			expect(tracker).toMatchObject({
				status: 'ready',
				reviewDate: '2026-04-15',
				daysRemaining: 0
			});
			expect(tracker.ruleSummary).toContain('Review current offer terms before applying');
			expect(bonusChurnStatusLabel(tracker.status)).toBe('Review current terms');
		}
	});

	it.each([
		['2024-01-31', 1, 0, '2024-02-29'],
		['2025-01-31', 1, 0, '2025-02-28'],
		['2024-02-29', 12, 0, '2025-02-28'],
		['2025-01-31', 1, 1, '2025-03-01'],
		['2026-03-07', 0, 2, '2026-03-09'],
		['2025-12-31', 2, 1, '2026-03-01']
	])(
		'clamps calendar months before adding days: %s + %i months + %i days',
		(openedDate, months, days, reviewDate) => {
			const tracker = buildBonusChurnTracker(
				{
					...bonus,
					openedDate,
					churn: churn({ conditions: [{ anchor: 'openedDate', months, days }] })
				},
				'2026-09-13'
			);
			expect(tracker.reviewDate).toBe(reviewDate);
		}
	);

	it.each([
		'2025-02-29',
		'2026-04-31',
		'2026-13-01',
		'2026-00-01',
		'2026-1-01',
		'2026-01-01T00:00:00Z',
		'0000-01-01'
	])('rejects invalid actual date %s without normalizing it', (paidDate) => {
		expect(
			buildBonusChurnTracker({ ...bonus, paidDate, churn: churn() }, '2026-09-13')
		).toMatchObject({ status: 'needs_info', reviewDate: null });
	});

	it('does not treat a future entered date as an event that already happened', () => {
		expect(
			buildBonusChurnTracker({ ...bonus, paidDate: '2026-09-14', churn: churn() }, '2026-09-13')
		).toMatchObject({ status: 'needs_info', reviewDate: null });
		expect(
			buildBonusChurnTracker(
				{ ...bonus, churn: churn({ requiresClosed: true, closedDate: '2026-09-14' }) },
				'2026-09-13'
			)
		).toMatchObject({ status: 'needs_info', reviewDate: null });
	});

	it('keeps restricted offers restricted even when stale saved dates have passed', () => {
		const settings = churn({
			mode: 'restricted',
			manualEligibleDate: '2020-01-01',
			notes: 'One bonus per business.'
		});
		expect(buildBonusChurnTracker({ ...bonus, churn: settings }, '2026-09-13')).toEqual({
			status: 'restricted',
			reviewDate: null,
			daysRemaining: null,
			missing: [],
			ruleSummary: 'One bonus per business.'
		});
	});

	it('supports a manual review date while still enforcing a selected closure requirement', () => {
		const settings = churn({ mode: 'manual', manualEligibleDate: '2026-09-14' });
		expect(
			buildBonusChurnTracker({ ...bonus, paidDate: null, churn: settings }, '2026-09-13')
		).toMatchObject({ status: 'waiting', reviewDate: '2026-09-14', daysRemaining: 1 });
		expect(buildBonusChurnTracker({ ...bonus, churn: settings }, '2026-09-14')).toMatchObject({
			status: 'ready',
			daysRemaining: 0
		});
		expect(
			buildBonusChurnTracker(
				{ ...bonus, churn: { ...settings, requiresClosed: true } },
				'2026-09-14'
			)
		).toMatchObject({ status: 'needs_info', reviewDate: null });
	});

	it.each([null, '', '2026-02-30'])(
		'needs a valid manual date instead of %s',
		(manualEligibleDate) => {
			expect(
				buildBonusChurnTracker(
					{ ...bonus, churn: churn({ mode: 'manual', manualEligibleDate }) },
					'2026-09-13'
				)
			).toMatchObject({ status: 'needs_info', reviewDate: null });
		}
	);

	it('fails incomplete or corrupted rules closed', () => {
		for (const conditions of [
			[],
			[{ anchor: 'paidDate', months: -1, days: 0 }],
			[{ anchor: 'paidDate', months: 1.5, days: 0 }],
			[{ anchor: 'paidDate', months: 0, days: Number.POSITIVE_INFINITY }],
			[{ anchor: 'paidDate', months: Number.MAX_SAFE_INTEGER, days: 0 }],
			[{ anchor: 'expectedPayoutDate', months: 24, days: 0 }],
			[null]
		]) {
			expect(
				buildBonusChurnTracker(
					{ ...bonus, churn: churn({ conditions: conditions as BonusChurnCondition[] }) },
					'2026-09-13'
				)
			).toMatchObject({ status: 'needs_info', reviewDate: null });
		}
	});

	it.each([
		[0, 0],
		[1_201, 0],
		[0, 36_501]
	])('does not preview eligibility for an unsavable %i-month, %i-day rule', (months, days) => {
		expect(
			buildBonusChurnTracker(
				{ ...bonus, churn: churn({ conditions: [{ anchor: 'paidDate', months, days }] }) },
				'2026-09-13'
			)
		).toMatchObject({ status: 'needs_info', reviewDate: null, daysRemaining: null });
	});

	it.each([
		[1_200, 0],
		[0, 36_500]
	])('accepts the API duration boundary of %i months and %i days', (months, days) => {
		const tracker = buildBonusChurnTracker(
			{ ...bonus, churn: churn({ conditions: [{ anchor: 'paidDate', months, days }] }) },
			'2026-09-13'
		);
		expect(tracker.status).toBe('waiting');
		expect(tracker.missing).toEqual([]);
	});

	it('requires duplicate date anchors to be combined before previewing eligibility', () => {
		const tracker = buildBonusChurnTracker(
			{
				...bonus,
				churn: churn({
					conditions: [
						{ anchor: 'paidDate', months: 12, days: 0 },
						{ anchor: 'paidDate', months: 24, days: 0 }
					]
				})
			},
			'2026-09-13'
		);
		expect(tracker).toMatchObject({ status: 'needs_info', reviewDate: null });
		expect(tracker.missing).toContain('Use each date only once.');
	});

	it('limits previews to three conditions as required by the API', () => {
		const tracker = buildBonusChurnTracker(
			{
				...bonus,
				churn: churn({
					closedDate: '2024-04-16',
					conditions: [
						{ anchor: 'paidDate', months: 12, days: 0 },
						{ anchor: 'openedDate', months: 12, days: 0 },
						{ anchor: 'closedDate', months: 12, days: 0 },
						{ anchor: 'paidDate', months: 24, days: 0 }
					]
				})
			},
			'2026-09-13'
		);
		expect(tracker).toMatchObject({ status: 'needs_info', reviewDate: null });
		expect(tracker.missing).toContain('Use at most three cooldown rules.');
	});

	it('uses Los Angeles calendar days including UTC midnight and daylight saving boundaries', () => {
		expect(getBonusChurnToday(new Date('2026-09-14T00:30:00.000Z'))).toBe('2026-09-13');
		expect(getBonusChurnToday(new Date('2026-01-01T07:30:00.000Z'))).toBe('2025-12-31');
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-09-14T00:30:00.000Z'));
		expect(
			buildBonusChurnTracker({
				...bonus,
				churn: churn({ mode: 'manual', manualEligibleDate: '2026-09-14' })
			})
		).toMatchObject({ status: 'waiting', daysRemaining: 1 });
	});

	it('rejects an invalid comparison date and formats date-only values without timezone shifting', () => {
		expect(buildBonusChurnTracker({ ...bonus, churn: churn() }, '2026-02-30')).toMatchObject({
			status: 'needs_info',
			reviewDate: null
		});
		expect(formatBonusChurnDate('2026-09-13')).toBe('Sep 13, 2026');
		expect(formatBonusChurnDate('2026-02-30')).toBe('Not set');
	});

	it('keeps restrictive business terms distinct from a verified rolling cooldown', () => {
		const wellsFargo = BONUS_CHURN_PRESETS.find((item) => item.id.startsWith('wells-fargo'))!;
		expect(wellsFargo.churn).toMatchObject({
			mode: 'rules',
			requiresClosed: true,
			conditions: [
				{ anchor: 'paidDate', months: 24, days: 0 },
				{ anchor: 'closedDate', months: 0, days: 90 }
			]
		});
		for (const id of ['us-bank', 'capital-one', 'bmo']) {
			const preset = BONUS_CHURN_PRESETS.find((item) => item.id.startsWith(id))!;
			expect(preset.churn.mode).toBe('restricted');
			expect(preset.sourceUrl).toMatch(/^https:\/\//);
		}
		const targeted = BONUS_CHURN_PRESETS.find((item) => item.id === 'etrade-targeted-review')!;
		expect(targeted.verifiedAt).toBeNull();
		expect(targeted.churn.mode).toBe('restricted');
	});
});
