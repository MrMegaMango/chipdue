import type { CreditBureau, CreditScoreEntry } from '$lib/credit-score-types';

export type CreditScoreRange = 'Poor' | 'Fair' | 'Good' | 'Very good' | 'Exceptional';

export function creditBureauLabel(bureau: CreditBureau): string {
	return {
		experian: 'Experian',
		equifax: 'Equifax',
		transunion: 'TransUnion',
		other: 'Other'
	}[bureau];
}

export function creditScoreRange(score: number): CreditScoreRange {
	if (score >= 800) return 'Exceptional';
	if (score >= 740) return 'Very good';
	if (score >= 670) return 'Good';
	if (score >= 580) return 'Fair';
	return 'Poor';
}

export function previousComparableScore(
	entries: CreditScoreEntry[],
	latest: CreditScoreEntry | null
): CreditScoreEntry | null {
	if (!latest) return null;
	return (
		entries
			.filter(
				(entry) =>
					entry.id !== latest.id &&
					entry.bureau === latest.bureau &&
					(entry.recordedDate < latest.recordedDate ||
						(entry.recordedDate === latest.recordedDate && entry.createdAt < latest.createdAt))
			)
			.toSorted(
				(left, right) =>
					right.recordedDate.localeCompare(left.recordedDate) ||
					right.createdAt.localeCompare(left.createdAt)
			)[0] ?? null
	);
}

export function creditScoreChange(
	entries: CreditScoreEntry[],
	latest: CreditScoreEntry | null
): number | null {
	const previous = previousComparableScore(entries, latest);
	return previous ? latest!.score - previous.score : null;
}
