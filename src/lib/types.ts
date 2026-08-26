export type CardSource = 'manual' | 'plaid';

export interface Card {
	id: string;
	source: CardSource;
	nickname: string;
	issuer: string | null;
	last4: string | null;
	currency: string;
	statementBalanceCents: number | null;
	minimumPaymentCents: number | null;
	currentBalanceCents: number | null;
	dueDate: string | null;
	statementDate: string | null;
	isOverdue: boolean | null;
	autopayEnabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastSyncedAt: string | null;
}

export interface ManualCardInput {
	nickname: string;
	issuer?: string | null;
	last4?: string | null;
	currency?: string;
	statementBalanceCents?: number | null;
	minimumPaymentCents?: number | null;
	currentBalanceCents?: number | null;
	dueDate?: string | null;
	statementDate?: string | null;
	isOverdue?: boolean | null;
	autopayEnabled?: boolean;
}

export interface PlaidConnection {
	id: string;
	institutionName: string | null;
	status: 'healthy' | 'needs_update';
	lastSyncedAt: string | null;
	createdAt: string;
}
