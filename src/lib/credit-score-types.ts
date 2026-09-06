export type CreditBureau = 'experian' | 'equifax' | 'transunion' | 'other';

export interface CreditScoreEntry {
	id: string;
	score: number;
	bureau: CreditBureau;
	model: string | null;
	source: string | null;
	recordedDate: string;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}
