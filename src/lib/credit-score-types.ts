export type CreditBureau = 'experian' | 'equifax' | 'transunion' | 'other';

export interface CreditScoreFactor {
	code: string | null;
	description: string;
}

export type CreditScoreEntryOrigin = 'manual' | 'automatic';

export interface CreditScoreEntry {
	id: string;
	score: number;
	bureau: CreditBureau;
	model: string | null;
	source: string | null;
	origin: CreditScoreEntryOrigin;
	factors: CreditScoreFactor[];
	recordedDate: string;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
}

export type CreditScoreConnectionState =
	'not_configured' | 'disconnected' | 'onboarding' | 'connected' | 'needs_attention';

export interface CreditScoreConnectionStatus {
	provider: 'method';
	providerName: 'Method';
	state: CreditScoreConnectionState;
	environment: 'development' | 'sandbox' | 'production' | null;
	lastSyncedAt: string | null;
	message: string;
}
