import type { FinancialDataProvider, FinancialRecordSource } from '$lib/types';
import { privateFingerprint, privateUuid } from './crypto';

// The deployed schema predates provider adapters, so its synced source value and
// foreign-key column still use Plaid-era names. Keep that compatibility detail
// isolated here until the next coordinated database migration.
export type StoredRecordSource = 'manual' | 'plaid';

export function storedSourceForProvider(provider: FinancialDataProvider): StoredRecordSource {
	return provider;
}

export function publicSourceForStoredSource(source: StoredRecordSource): FinancialRecordSource {
	return source === 'manual' ? 'manual' : 'connected';
}

export function providerForStoredSource(source: StoredRecordSource): FinancialDataProvider | null {
	return source === 'manual' ? null : source;
}

export function providerAccountReference(
	provider: FinancialDataProvider,
	externalAccountId: string,
	record: 'card' | 'account'
): string {
	const purpose =
		provider === 'plaid'
			? record === 'card'
				? 'plaid-account'
				: 'plaid-financial-account'
			: `financial-provider:${provider}:${record}`;
	return privateFingerprint(externalAccountId, purpose);
}

export function providerRecordId(
	provider: FinancialDataProvider,
	externalAccountId: string,
	connectionId: string,
	record: 'card' | 'account'
): string {
	const purpose =
		provider === 'plaid'
			? record === 'card'
				? `plaid-card:${connectionId}`
				: `plaid-account:${connectionId}`
			: `financial-provider:${provider}:${record}:${connectionId}`;
	return privateUuid(externalAccountId, purpose);
}

export function providerTransactionId(
	provider: FinancialDataProvider,
	externalTransactionId: string,
	recordId: string
): string {
	const purpose =
		provider === 'plaid'
			? `plaid-transaction:${recordId}`
			: `financial-provider:${provider}:transaction:${recordId}`;
	return privateUuid(externalTransactionId, purpose);
}
