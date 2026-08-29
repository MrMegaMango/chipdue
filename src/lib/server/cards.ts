import { randomUUID } from 'node:crypto';
import {
	automaticCardRewardProfileById,
	matchAutomaticCardRewardProfile,
	type AutomaticCardRewardProfile,
	type CardRewardCalculation
} from '$lib/card-reward-profiles';
import {
	normalizeTransactionHistoryStatus,
	type StoredTransactionHistoryStatus
} from '$lib/financial-data';
import type {
	Card,
	CardRewardCategory,
	CardRewardCategoryMatch,
	CardRewardCategorySpend,
	CardRewardType,
	CardTransaction,
	CardTransactionRewardEstimate,
	FinancialDataProvider,
	TransactionHistoryStatus
} from '$lib/types';
import { cloudQuery, cloudTransaction, type CloudStatement } from './cloud-database';
import { decryptJson, encryptJson, privateUuid } from './crypto';
import { getDatabase } from './database';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';
import type { CreateManualCardData, UpdateCardRewardsData, UpdateManualCardData } from './schemas';
import {
	providerAccountReference,
	providerForStoredSource,
	providerRecordId,
	providerTransactionId,
	publicSourceForStoredSource,
	storedSourceForProvider,
	type StoredRecordSource
} from './provider-storage';
import { payloadBelongsToCurrentTenant, tenantPayloadFields, tenantReference } from './tenant';

interface StoredCardRewardCategory {
	id: string;
	name: string;
	multiplier?: number | null;
	matchCategory?: CardRewardCategoryMatch | null;
	annualSpendCapCents?: number | null;
	rate?: string;
}

interface StoredCardRewards {
	programName: string | null;
	cashValueCents: number | null;
	rewardType?: CardRewardType | null;
	baseRate?: number | null;
	source?: 'automatic' | 'manual';
	profileName?: string | null;
	calculation?: CardRewardCalculation;
	categories: StoredCardRewardCategory[];
}

interface NormalizedCardRewards {
	programName: string | null;
	cashValueCents: number | null;
	rewardType: CardRewardType | null;
	baseRate: number | null;
	source: 'automatic' | 'manual' | null;
	profileName: string | null;
	calculation: CardRewardCalculation | null;
	categories: CardRewardCategory[];
}

interface CardPayload {
	tenantRef?: string;
	nickname: string;
	providerProductName?: string | null;
	issuer: string | null;
	issuerLogoBase64?: string | null;
	last4: string | null;
	currency: string;
	statementBalanceCents: number | null;
	minimumPaymentCents: number | null;
	currentBalanceCents: number | null;
	dueDate: string | null;
	statementDate: string | null;
	isOverdue: boolean | null;
	autopayEnabled: boolean;
	rewards?: StoredCardRewards;
	transactionHistory?: StoredTransactionHistory;
}

export interface StoredFinancialTransaction {
	transactionId: string;
	name: string;
	merchantName: string | null;
	amountCents: number;
	currency: string;
	date: string;
	authorizedDate: string | null;
	pending: boolean;
	categoryPrimary: string | null;
	categoryDetailed: string | null;
	investmentDetails?: {
		type: string;
		subtype: string;
		securityName: string | null;
		tickerSymbol: string | null;
		quantity: number;
		priceMicros: number;
		feesCents: number | null;
	};
}

export interface StoredTransactionHistory {
	enabled: true;
	accountReference?: string;
	cursor: string | null;
	status: TransactionHistoryStatus;
	transactions: StoredFinancialTransaction[];
}

interface CardRow extends Record<string, unknown> {
	id: string;
	source: StoredRecordSource;
	plaid_item_id: string | null;
	external_account_ref: string | null;
	payload_enc: string;
	last_synced_at: string | null;
	created_at: string;
	updated_at: string;
}

interface ConnectedCardRow extends CardRow {
	external_account_ref: string;
}

export interface ConnectedCardSnapshot extends CardPayload {
	accountId: string;
	automaticRewardProfile?: AutomaticCardRewardProfile | null;
}

export interface ConnectionTransactionState {
	enabled: boolean;
	cursor: string | null;
	status: TransactionHistoryStatus;
	byAccountReference: Map<string, StoredFinancialTransaction[]>;
}

const TRANSACTION_HISTORY_STATUSES = new Set<StoredTransactionHistoryStatus>([
	'unknown',
	'preparing',
	'current',
	'historical_complete',
	'TRANSACTIONS_UPDATE_STATUS_UNKNOWN',
	'NOT_READY',
	'INITIAL_UPDATE_COMPLETE',
	'HISTORICAL_UPDATE_COMPLETE'
]);
const CARD_REWARD_TYPES = new Set<CardRewardType>(['points', 'miles', 'cash_back']);
const CARD_REWARD_CATEGORY_MATCHES = new Set<CardRewardCategoryMatch>([
	'dining',
	'groceries',
	'gas',
	'travel',
	'flights_hotels',
	'transit',
	'entertainment',
	'drugstores',
	'streaming',
	'online_shopping',
	'home_improvement',
	'utilities'
]);
const NON_REWARD_TRANSACTION_CATEGORIES = new Set([
	'BANK_FEES',
	'INCOME',
	'LOAN_PAYMENTS',
	'TRANSFER_IN',
	'TRANSFER_OUT'
]);
const MAX_STORED_TRANSACTIONS = 10_000;

function isRewardRate(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100;
}

function isStoredFinancialTransaction(value: unknown): value is StoredFinancialTransaction {
	if (!value || typeof value !== 'object') return false;
	const transaction = value as Partial<StoredFinancialTransaction>;
	const investment = transaction.investmentDetails;
	const validInvestmentDetails =
		investment === undefined ||
		(typeof investment === 'object' &&
			typeof investment.type === 'string' &&
			investment.type.length > 0 &&
			investment.type.length <= 40 &&
			typeof investment.subtype === 'string' &&
			investment.subtype.length > 0 &&
			investment.subtype.length <= 80 &&
			(investment.securityName === null ||
				(typeof investment.securityName === 'string' && investment.securityName.length <= 160)) &&
			(investment.tickerSymbol === null ||
				(typeof investment.tickerSymbol === 'string' && investment.tickerSymbol.length <= 32)) &&
			typeof investment.quantity === 'number' &&
			Number.isFinite(investment.quantity) &&
			Math.abs(investment.quantity) <= 1_000_000_000_000 &&
			Number.isSafeInteger(investment.priceMicros) &&
			Math.abs(investment.priceMicros) <= 100_000_000_000_000 &&
			(investment.feesCents === null ||
				(Number.isSafeInteger(investment.feesCents) &&
					Math.abs(investment.feesCents) <= 100_000_000_000)));
	return (
		validInvestmentDetails &&
		typeof transaction.transactionId === 'string' &&
		transaction.transactionId.length > 0 &&
		transaction.transactionId.length <= 256 &&
		typeof transaction.name === 'string' &&
		transaction.name.length > 0 &&
		transaction.name.length <= 160 &&
		(transaction.merchantName === null ||
			(typeof transaction.merchantName === 'string' && transaction.merchantName.length <= 120)) &&
		typeof transaction.amountCents === 'number' &&
		Number.isSafeInteger(transaction.amountCents) &&
		Math.abs(transaction.amountCents) <= 100_000_000_000 &&
		typeof transaction.currency === 'string' &&
		/^[A-Z]{3}$/.test(transaction.currency) &&
		typeof transaction.date === 'string' &&
		/^\d{4}-\d{2}-\d{2}$/.test(transaction.date) &&
		(transaction.authorizedDate === null ||
			(typeof transaction.authorizedDate === 'string' &&
				/^\d{4}-\d{2}-\d{2}$/.test(transaction.authorizedDate))) &&
		typeof transaction.pending === 'boolean' &&
		(transaction.categoryPrimary === null ||
			(typeof transaction.categoryPrimary === 'string' &&
				transaction.categoryPrimary.length <= 80)) &&
		(transaction.categoryDetailed === null ||
			(typeof transaction.categoryDetailed === 'string' &&
				transaction.categoryDetailed.length <= 120))
	);
}

function normalizeStoredTransactionHistory(value: unknown): StoredTransactionHistory | null {
	if (!value || typeof value !== 'object') return null;
	const history = value as Partial<StoredTransactionHistory> & {
		status?: StoredTransactionHistoryStatus;
	};
	const valid =
		history.enabled === true &&
		(history.accountReference === undefined ||
			(typeof history.accountReference === 'string' &&
				/^[A-Za-z0-9_-]{43}$/.test(history.accountReference))) &&
		(history.cursor === null ||
			(typeof history.cursor === 'string' && history.cursor.length <= 256)) &&
		typeof history.status === 'string' &&
		TRANSACTION_HISTORY_STATUSES.has(history.status as StoredTransactionHistoryStatus) &&
		Array.isArray(history.transactions) &&
		history.transactions.length <= MAX_STORED_TRANSACTIONS &&
		history.transactions.every(isStoredFinancialTransaction);
	if (!valid) return null;
	return {
		enabled: true,
		...(history.accountReference ? { accountReference: history.accountReference } : {}),
		cursor: history.cursor ?? null,
		status: normalizeTransactionHistoryStatus(history.status!),
		transactions: history.transactions as StoredFinancialTransaction[]
	};
}

function transactionHistoryFromRow(row: CardRow): StoredTransactionHistory | undefined {
	const value = decryptJson<unknown>(row.payload_enc, `card:${row.id}`);
	if (value && typeof value === 'object' && !payloadBelongsToCurrentTenant(value)) return undefined;
	if (value && typeof value === 'object' && 'recordType' in value) {
		const record = value as {
			recordType?: unknown;
			accountType?: unknown;
			transactionHistory?: unknown;
		};
		if (record.recordType !== 'account' || record.transactionHistory === undefined)
			return undefined;
		// Plaid investment activity has no cursor relationship to Transactions Sync.
		if (record.accountType === 'brokerage') return undefined;
		const history = normalizeStoredTransactionHistory(record.transactionHistory);
		if (!history) {
			throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
		}
		return history;
	}
	return decodePayload(row)?.transactionHistory;
}

function isStoredIssuerLogo(value: unknown): value is string | null | undefined {
	return (
		value === undefined ||
		value === null ||
		(typeof value === 'string' &&
			value.length > 0 &&
			value.length <= 350_000 &&
			/^[A-Za-z0-9+/]+={0,2}$/.test(value))
	);
}

function isStoredCardRewards(value: unknown): value is StoredCardRewards | undefined {
	if (value === undefined) return true;
	if (!value || typeof value !== 'object') return false;
	const rewards = value as Partial<StoredCardRewards>;
	return (
		(rewards.programName === null ||
			(typeof rewards.programName === 'string' && rewards.programName.length <= 80)) &&
		(rewards.cashValueCents === null ||
			(typeof rewards.cashValueCents === 'number' &&
				Number.isSafeInteger(rewards.cashValueCents) &&
				rewards.cashValueCents >= 0 &&
				rewards.cashValueCents <= 100_000_000_000)) &&
		(rewards.rewardType === undefined ||
			rewards.rewardType === null ||
			(typeof rewards.rewardType === 'string' &&
				CARD_REWARD_TYPES.has(rewards.rewardType as CardRewardType))) &&
		(rewards.baseRate === undefined ||
			rewards.baseRate === null ||
			isRewardRate(rewards.baseRate)) &&
		(rewards.source === undefined ||
			rewards.source === 'automatic' ||
			rewards.source === 'manual') &&
		(rewards.profileName === undefined ||
			rewards.profileName === null ||
			(typeof rewards.profileName === 'string' && rewards.profileName.length <= 80)) &&
		(rewards.calculation === undefined ||
			rewards.calculation === 'static' ||
			rewards.calculation === 'venmo_spend_ranked') &&
		Array.isArray(rewards.categories) &&
		rewards.categories.length <= 12 &&
		rewards.categories.every(
			(category) =>
				category &&
				typeof category === 'object' &&
				typeof category.id === 'string' &&
				/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
					category.id
				) &&
				typeof category.name === 'string' &&
				category.name.length > 0 &&
				category.name.length <= 60 &&
				(((category.multiplier === null || isRewardRate(category.multiplier)) &&
					(category.matchCategory === undefined ||
						category.matchCategory === null ||
						(typeof category.matchCategory === 'string' &&
							CARD_REWARD_CATEGORY_MATCHES.has(
								category.matchCategory as CardRewardCategoryMatch
							))) &&
					(category.annualSpendCapCents === undefined ||
						category.annualSpendCapCents === null ||
						(typeof category.annualSpendCapCents === 'number' &&
							Number.isSafeInteger(category.annualSpendCapCents) &&
							category.annualSpendCapCents > 0 &&
							category.annualSpendCapCents <= 100_000_000_000))) ||
					(typeof category.rate === 'string' &&
						category.rate.length > 0 &&
						category.rate.length <= 20))
		)
	);
}

function parseLegacyRewardRate(value: string | undefined): number | null {
	if (!value) return null;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:x|%)?$/i);
	if (!match) return null;
	const rate = Number(match[1]);
	return isRewardRate(rate) ? rate : null;
}

function inferredRewardMatch(name: string): CardRewardCategoryMatch | null {
	const normalized = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
	if (/\b(dining|restaurant|restaurants|coffee|fast food)\b/.test(normalized)) return 'dining';
	if (/\b(grocery|groceries|supermarket|supermarkets)\b/.test(normalized)) return 'groceries';
	if (/\b(gas|fuel|gas station|gas stations)\b/.test(normalized)) return 'gas';
	if (/\b(travel|hotel|hotels|airfare|flight|flights)\b/.test(normalized)) return 'travel';
	if (/\b(transit|rideshare|taxi|taxis|parking|tolls)\b/.test(normalized)) return 'transit';
	if (/\b(entertainment|events|movies)\b/.test(normalized)) return 'entertainment';
	if (/\b(drugstore|drugstores|pharmacy|pharmacies)\b/.test(normalized)) return 'drugstores';
	if (/\b(streaming|streaming services)\b/.test(normalized)) return 'streaming';
	if (/\b(online shopping|online purchases|online marketplace)\b/.test(normalized)) {
		return 'online_shopping';
	}
	if (/\b(home improvement|hardware)\b/.test(normalized)) return 'home_improvement';
	if (/\b(utilities|utility|internet|cable|phone)\b/.test(normalized)) return 'utilities';
	return null;
}

function normalizeStoredRewards(rewards: StoredCardRewards | undefined): NormalizedCardRewards {
	const hasConfiguredRewards = Boolean(
		rewards?.programName || rewards?.rewardType || rewards?.baseRate || rewards?.categories.length
	);
	return {
		programName: rewards?.programName ?? null,
		cashValueCents: rewards?.cashValueCents ?? null,
		rewardType: rewards?.rewardType ?? null,
		baseRate: rewards?.baseRate ?? null,
		source: rewards?.source ?? (hasConfiguredRewards ? 'manual' : null),
		profileName: rewards?.profileName ?? null,
		calculation: rewards?.calculation ?? (hasConfiguredRewards ? 'static' : null),
		categories: (rewards?.categories ?? []).map((category) => ({
			id: category.id,
			name: category.name,
			multiplier: category.multiplier ?? parseLegacyRewardRate(category.rate),
			matchCategory:
				category.matchCategory === undefined
					? inferredRewardMatch(category.name)
					: category.matchCategory,
			annualSpendCapCents: category.annualSpendCapCents ?? null
		}))
	};
}

function decodePayload(row: CardRow): CardPayload | null {
	const payload = decryptJson<CardPayload & { recordType?: unknown }>(
		row.payload_enc,
		`card:${row.id}`
	);
	if (payload && (payload.recordType === 'account' || payload.recordType === 'bonus')) return null;
	if (
		!payload ||
		typeof payload.nickname !== 'string' ||
		typeof payload.currency !== 'string' ||
		!('dueDate' in payload)
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (!payloadBelongsToCurrentTenant(payload)) return null;
	if (
		payload.providerProductName !== undefined &&
		payload.providerProductName !== null &&
		(typeof payload.providerProductName !== 'string' ||
			payload.providerProductName.length === 0 ||
			payload.providerProductName.length > 160)
	) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (payload.transactionHistory !== undefined) {
		const history = normalizeStoredTransactionHistory(payload.transactionHistory);
		if (!history) {
			throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
		}
		payload.transactionHistory = history;
	}
	if (!isStoredIssuerLogo(payload.issuerLogoBase64)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	if (!isStoredCardRewards(payload.rewards)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return payload;
}

function rowToCard(row: CardRow): Card | null {
	const payload = decodePayload(row);
	if (!payload) return null;
	const rewards = effectiveRewardsForPayload(payload);
	return {
		id: row.id,
		source: publicSourceForStoredSource(row.source),
		nickname: payload.nickname,
		providerProductName: payload.providerProductName ?? null,
		issuer: payload.issuer,
		issuerLogoUrl: payload.issuerLogoBase64
			? `data:image/png;base64,${payload.issuerLogoBase64}`
			: null,
		last4: payload.last4,
		currency: payload.currency,
		statementBalanceCents: payload.statementBalanceCents,
		minimumPaymentCents: payload.minimumPaymentCents,
		currentBalanceCents: payload.currentBalanceCents,
		dueDate: payload.dueDate,
		statementDate: payload.statementDate,
		isOverdue: payload.isOverdue,
		autopayEnabled: payload.autopayEnabled,
		rewardProgramName: rewards.programName,
		rewardValueCents: rewards.cashValueCents,
		rewardType: rewards.rewardType,
		rewardBaseRate: rewards.baseRate,
		rewardCategories: rewards.categories,
		rewardSource: rewards.source,
		rewardProfileName: rewards.profileName,
		rewardCalculation: rewards.calculation,
		transactionHistoryEnabled: payload.transactionHistory?.enabled === true,
		transactionHistoryStatus: payload.transactionHistory?.status ?? null,
		connectionId: row.source === 'manual' ? null : row.plaid_item_id,
		connectionProvider: providerForStoredSource(row.source),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastSyncedAt: row.last_synced_at
	};
}

function sortCards(cards: Card[]): Card[] {
	return cards.sort((left, right) => {
		if (left.dueDate && right.dueDate && left.dueDate !== right.dueDate) {
			return left.dueDate.localeCompare(right.dueDate);
		}
		if (left.dueDate && !right.dueDate) return -1;
		if (!left.dueDate && right.dueDate) return 1;
		return left.nickname.localeCompare(right.nickname);
	});
}

function preferMoreRecentCard(left: Card, right: Card): Card {
	const syncComparison = (left.lastSyncedAt ?? '').localeCompare(right.lastSyncedAt ?? '');
	if (syncComparison !== 0) return syncComparison > 0 ? left : right;

	const updateComparison = left.updatedAt.localeCompare(right.updatedAt);
	if (updateComparison !== 0) return updateComparison > 0 ? left : right;

	return left.id.localeCompare(right.id) > 0 ? left : right;
}

type CardCandidate = { row: CardRow; card: Card };

function preferMoreRecentCandidate(left: CardCandidate, right: CardCandidate): CardCandidate {
	return preferMoreRecentCard(left.card, right.card) === left.card ? left : right;
}

function connectedDisplayIdentity(card: Card): string | null {
	const issuer = card.issuer?.trim().toLocaleLowerCase();
	const nickname = card.nickname.trim().toLocaleLowerCase();
	if (!issuer || !nickname || !card.last4) return null;
	return [issuer, nickname, card.last4, card.currency].join('\u0000');
}

function uniqueCards(rows: CardRow[]): Card[] {
	const cards: Card[] = [];
	const connectedCardsByAccount = new Map<string, CardCandidate>();

	for (const row of rows) {
		const card = rowToCard(row);
		if (!card) continue;
		if (row.source === 'manual' || !row.external_account_ref) {
			cards.push(card);
			continue;
		}

		const existing = connectedCardsByAccount.get(row.external_account_ref);
		connectedCardsByAccount.set(
			row.external_account_ref,
			existing ? preferMoreRecentCandidate(existing, { row, card }) : { row, card }
		);
	}

	const unmatchedConnectedCards: Card[] = [];
	const cardsByDisplayIdentity = new Map<string, Map<string, CardCandidate[]>>();
	for (const candidate of connectedCardsByAccount.values()) {
		const displayIdentity = connectedDisplayIdentity(candidate.card);
		const connectionId = candidate.row.plaid_item_id;
		if (!displayIdentity || !connectionId) {
			unmatchedConnectedCards.push(candidate.card);
			continue;
		}

		const byConnection = cardsByDisplayIdentity.get(displayIdentity) ?? new Map();
		const connectionCards = byConnection.get(connectionId) ?? [];
		connectionCards.push(candidate);
		byConnection.set(connectionId, connectionCards);
		cardsByDisplayIdentity.set(displayIdentity, byConnection);
	}

	for (const byConnection of cardsByDisplayIdentity.values()) {
		let preferredConnection: CardCandidate[] | undefined;
		let preferredCard: CardCandidate | undefined;
		for (const connectionCards of byConnection.values()) {
			const mostRecentCard = connectionCards.reduce(preferMoreRecentCandidate);
			if (
				!preferredCard ||
				preferMoreRecentCandidate(preferredCard, mostRecentCard) === mostRecentCard
			) {
				preferredCard = mostRecentCard;
				preferredConnection = connectionCards;
			}
		}
		cards.push(...(preferredConnection ?? []).map(({ card }) => card));
	}

	return [...cards, ...unmatchedConnectedCards];
}

function automaticStoredRewards(profile: AutomaticCardRewardProfile): StoredCardRewards {
	return {
		programName: profile.programName,
		cashValueCents: null,
		rewardType: profile.rewardType,
		baseRate: profile.baseRate,
		source: 'automatic',
		profileName: profile.cardName,
		calculation: profile.calculation,
		categories: profile.categories.map((category) => ({
			id: privateUuid(
				`${profile.id}:${category.name}:${category.matchCategory ?? 'ranked'}`,
				'automatic-card-reward-category'
			),
			...category
		}))
	};
}

function effectiveRewardsForPayload(payload: CardPayload): NormalizedCardRewards {
	const stored = normalizeStoredRewards(payload.rewards);
	if (stored.source) return stored;
	const inferredProfile = matchAutomaticCardRewardProfile({
		institutionName: payload.issuer,
		accountName: payload.nickname,
		officialName: payload.providerProductName ?? null
	});
	return inferredProfile ? normalizeStoredRewards(automaticStoredRewards(inferredProfile)) : stored;
}

function rewardsForSnapshot(
	profile: AutomaticCardRewardProfile | null | undefined,
	existing: StoredCardRewards | undefined
): StoredCardRewards | undefined {
	const normalized = normalizeStoredRewards(existing);
	if (normalized.source === 'manual') return existing;
	if (profile) return automaticStoredRewards(profile);
	return existing;
}

function snapshotPayload(
	snapshot: ConnectedCardSnapshot,
	rewards?: StoredCardRewards
): CardPayload {
	const resolvedRewards = rewardsForSnapshot(snapshot.automaticRewardProfile, rewards);
	return {
		...tenantPayloadFields(),
		nickname: snapshot.nickname,
		...(snapshot.providerProductName ? { providerProductName: snapshot.providerProductName } : {}),
		issuer: snapshot.issuer,
		...(snapshot.issuerLogoBase64 ? { issuerLogoBase64: snapshot.issuerLogoBase64 } : {}),
		last4: snapshot.last4,
		currency: snapshot.currency,
		statementBalanceCents: snapshot.statementBalanceCents,
		minimumPaymentCents: snapshot.minimumPaymentCents,
		currentBalanceCents: snapshot.currentBalanceCents,
		dueDate: snapshot.dueDate,
		statementDate: snapshot.statementDate,
		isOverdue: snapshot.isOverdue,
		autopayEnabled: snapshot.autopayEnabled,
		...(resolvedRewards ? { rewards: resolvedRewards } : {}),
		...(snapshot.transactionHistory ? { transactionHistory: snapshot.transactionHistory } : {})
	};
}

export async function listCards(): Promise<Card[]> {
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<CardRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards WHERE tenant_ref = $1`,
					[tenantReference()]
				)
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards`
					)
					.all() as CardRow[]);
	return sortCards(uniqueCards(rows));
}

async function findCardRow(id: string): Promise<CardRow | undefined> {
	return getRuntimeMode() === 'cloud'
		? (
				await cloudQuery<CardRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards WHERE tenant_ref = $1 AND id = $2`,
					[tenantReference(), id]
				)
			)[0]
		: (getDatabase()
				.prepare(
					`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE id = ?`
				)
				.get(id) as CardRow | undefined);
}

export async function getCard(id: string): Promise<Card> {
	const row = await findCardRow(id);
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	const card = rowToCard(row);
	if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return card;
}

export async function createManualCard(input: CreateManualCardData): Promise<Card> {
	const id = randomUUID();
	const now = new Date().toISOString();
	const payload: CardPayload = { ...tenantPayloadFields(), ...input };
	const payloadEncrypted = encryptJson(payload, `card:${id}`);

	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`INSERT INTO public.carddue_cards
			 (id, source, plaid_item_id, external_account_ref, payload_enc,
			  last_synced_at, created_at, updated_at, tenant_ref)
			 VALUES ($1, 'manual', NULL, NULL, $2, NULL, $3, $3, $4)`,
			[id, payloadEncrypted, now, tenantReference()]
		);
	} else {
		getDatabase()
			.prepare(
				`INSERT INTO cards
				 (id, source, plaid_item_id, external_account_ref, payload_enc,
				  last_synced_at, created_at, updated_at)
				 VALUES (?, 'manual', NULL, NULL, ?, NULL, ?, ?)`
			)
			.run(id, payloadEncrypted, now, now);
	}
	return getCard(id);
}

export async function updateManualCard(id: string, changes: UpdateManualCardData): Promise<Card> {
	const existing = await getCard(id);
	if (existing.source !== 'manual') {
		throw new AppError(
			'CONNECTED_CARD_READ_ONLY',
			'Synced cards must be changed at their institution.',
			409
		);
	}

	const payload: CardPayload = {
		...tenantPayloadFields(),
		nickname: changes.nickname ?? existing.nickname,
		issuer: changes.issuer === undefined ? existing.issuer : changes.issuer,
		last4: changes.last4 === undefined ? existing.last4 : changes.last4,
		currency: changes.currency ?? existing.currency,
		statementBalanceCents:
			changes.statementBalanceCents === undefined
				? existing.statementBalanceCents
				: changes.statementBalanceCents,
		minimumPaymentCents:
			changes.minimumPaymentCents === undefined
				? existing.minimumPaymentCents
				: changes.minimumPaymentCents,
		currentBalanceCents:
			changes.currentBalanceCents === undefined
				? existing.currentBalanceCents
				: changes.currentBalanceCents,
		dueDate: changes.dueDate === undefined ? existing.dueDate : changes.dueDate,
		statementDate:
			changes.statementDate === undefined ? existing.statementDate : changes.statementDate,
		isOverdue: changes.isOverdue === undefined ? existing.isOverdue : changes.isOverdue,
		autopayEnabled:
			changes.autopayEnabled === undefined ? existing.autopayEnabled : changes.autopayEnabled,
		rewards: {
			programName: existing.rewardProgramName,
			cashValueCents: existing.rewardValueCents,
			rewardType: existing.rewardType,
			baseRate: existing.rewardBaseRate,
			source: existing.rewardSource ?? 'manual',
			profileName: existing.rewardProfileName,
			calculation: existing.rewardCalculation ?? 'static',
			categories: existing.rewardCategories.map((category) => ({
				id: category.id,
				name: category.name,
				multiplier: category.multiplier,
				matchCategory: category.matchCategory
			}))
		}
	};
	const encrypted = encryptJson(payload, `card:${id}`);
	const now = new Date().toISOString();

	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<CardRow>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE tenant_ref = $3 AND id = $4 AND source = 'manual'
			 RETURNING id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			           last_synced_at, created_at, updated_at`,
			[encrypted, now, tenantReference(), id]
		);
		if (!rows[0]) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		const card = rowToCard(rows[0]);
		if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		return card;
	}

	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ? AND source = 'manual'`)
		.run(encrypted, now, id);
	if (result.changes !== 1) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return getCard(id);
}

export async function updateCardRewards(id: string, changes: UpdateCardRewardsData): Promise<Card> {
	const row = await findCardRow(id);
	const payload = row ? decodePayload(row) : null;
	if (!row || !payload) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);

	const existing = normalizeStoredRewards(payload.rewards);
	payload.tenantRef = tenantPayloadFields().tenantRef;
	payload.rewards = {
		programName:
			changes.rewardProgramName === undefined ? existing.programName : changes.rewardProgramName,
		cashValueCents:
			changes.rewardValueCents === undefined ? existing.cashValueCents : changes.rewardValueCents,
		rewardType: changes.rewardType === undefined ? existing.rewardType : changes.rewardType,
		baseRate: changes.rewardBaseRate === undefined ? existing.baseRate : changes.rewardBaseRate,
		source: 'manual',
		profileName: null,
		calculation: 'static',
		categories:
			changes.rewardCategories === undefined
				? existing.categories
				: changes.rewardCategories.map((category) => ({
						id: category.id ?? randomUUID(),
						name: category.name,
						multiplier: category.multiplier,
						matchCategory: category.matchCategory
					}))
	};
	const encrypted = encryptJson(payload, `card:${id}`);
	const now = new Date().toISOString();

	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<CardRow>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE tenant_ref = $3 AND id = $4
			 RETURNING id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			           last_synced_at, created_at, updated_at`,
			[encrypted, now, tenantReference(), id]
		);
		const card = rows[0] ? rowToCard(rows[0]) : null;
		if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		return card;
	}

	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ?`)
		.run(encrypted, now, id);
	if (result.changes !== 1) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return getCard(id);
}

export async function applyAutomaticCardRewardProfile(
	id: string,
	profileId: string
): Promise<Card> {
	const profile = automaticCardRewardProfileById(profileId);
	if (!profile) throw new AppError('INVALID_REQUEST', 'The reward profile is invalid.', 400);

	const row = await findCardRow(id);
	const payload = row ? decodePayload(row) : null;
	if (!row || !payload) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);

	payload.tenantRef = tenantPayloadFields().tenantRef;
	payload.rewards = automaticStoredRewards(profile);
	const encrypted = encryptJson(payload, `card:${id}`);
	const now = new Date().toISOString();

	if (getRuntimeMode() === 'cloud') {
		const rows = await cloudQuery<CardRow>(
			`UPDATE public.carddue_cards SET payload_enc = $1, updated_at = $2
			 WHERE tenant_ref = $3 AND id = $4
			 RETURNING id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
			           last_synced_at, created_at, updated_at`,
			[encrypted, now, tenantReference(), id]
		);
		const card = rows[0] ? rowToCard(rows[0]) : null;
		if (!card) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
		return card;
	}

	const result = getDatabase()
		.prepare(`UPDATE cards SET payload_enc = ?, updated_at = ? WHERE id = ?`)
		.run(encrypted, now, id);
	if (result.changes !== 1) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	return getCard(id);
}

export async function deleteManualCard(id: string): Promise<void> {
	const existing = await getCard(id);
	if (existing.source !== 'manual') {
		throw new AppError(
			'CONNECTED_CARD_READ_ONLY',
			'Disconnect the institution to remove synced cards.',
			409
		);
	}
	if (getRuntimeMode() === 'cloud') {
		await cloudQuery(
			`DELETE FROM public.carddue_cards
			 WHERE tenant_ref = $1 AND id = $2 AND source = 'manual'`,
			[tenantReference(), id]
		);
	} else {
		getDatabase().prepare(`DELETE FROM cards WHERE id = ? AND source = 'manual'`).run(id);
	}
}

async function replaceCloudConnectedCards(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedCardSnapshot[],
	syncedAt: string
): Promise<void> {
	const storedSource = storedSourceForProvider(provider);
	const tenantRef = tenantReference();
	const existingRows = await cloudQuery<CardRow>(
		`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
		        last_synced_at, created_at, updated_at
		 FROM public.carddue_cards
		 WHERE tenant_ref = $1 AND plaid_item_id = $2 AND source = $3`,
		[tenantRef, connectionId, storedSource]
	);
	const existingCards = existingRows.flatMap((row) => {
		const payload = decodePayload(row);
		return payload ? [{ row, payload }] : [];
	});
	const rewardsByReference = new Map(
		existingCards.flatMap(({ row, payload }) => {
			const rewards = payload.rewards;
			return row.external_account_ref && rewards
				? [[row.external_account_ref, rewards] as const]
				: [];
		})
	);
	const references = new Set<string>();
	const statements: CloudStatement[] = snapshots.map((snapshot) => {
		const reference = providerAccountReference(provider, snapshot.accountId, 'card');
		const id = providerRecordId(provider, snapshot.accountId, connectionId, 'card');
		references.add(reference);
		return {
			text: `INSERT INTO public.carddue_cards
			       (id, source, plaid_item_id, external_account_ref, payload_enc,
			        last_synced_at, created_at, updated_at, tenant_ref)
			       VALUES ($1, $2, $3, $4, $5, $6, $6, $6, $7)
			       ON CONFLICT (plaid_item_id, external_account_ref) DO UPDATE SET
			       payload_enc = EXCLUDED.payload_enc,
			       last_synced_at = EXCLUDED.last_synced_at,
			       tenant_ref = EXCLUDED.tenant_ref,
			       updated_at = EXCLUDED.updated_at`,
			params: [
				id,
				storedSource,
				connectionId,
				reference,
				encryptJson(snapshotPayload(snapshot, rewardsByReference.get(reference)), `card:${id}`),
				syncedAt,
				tenantRef
			]
		};
	});
	for (const { row } of existingCards) {
		if (row.external_account_ref && !references.has(row.external_account_ref)) {
			statements.push({
				text: `DELETE FROM public.carddue_cards
				       WHERE tenant_ref = $1 AND id = $2 AND source = $3`,
				params: [tenantRef, row.id, storedSource]
			});
		}
	}
	if (statements.length > 0) await cloudTransaction(statements);
}

function replaceLocalConnectedCards(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedCardSnapshot[],
	syncedAt: string
): void {
	const storedSource = storedSourceForProvider(provider);
	const database = getDatabase();
	const transaction = database.transaction(() => {
		const existingRows = database
			.prepare(
				`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
				        last_synced_at, created_at, updated_at
				 FROM cards WHERE plaid_item_id = ? AND source = ?`
			)
			.all(connectionId, storedSource) as ConnectedCardRow[];
		const existingCards = existingRows.flatMap((row) => {
			const payload = decodePayload(row);
			return payload ? [{ row, payload }] : [];
		});
		const existingByReference = new Map(
			existingCards.map(({ row, payload }) => [row.external_account_ref, { row, payload }])
		);
		const seenReferences = new Set<string>();

		for (const snapshot of snapshots) {
			const reference = providerAccountReference(provider, snapshot.accountId, 'card');
			seenReferences.add(reference);
			const current = existingByReference.get(reference);
			const id = current?.row.id ?? randomUUID();
			const rewards = current?.payload.rewards;
			const encrypted = encryptJson(snapshotPayload(snapshot, rewards), `card:${id}`);
			if (current) {
				database
					.prepare(
						`UPDATE cards SET payload_enc = ?, last_synced_at = ?, updated_at = ?
						 WHERE id = ?`
					)
					.run(encrypted, syncedAt, syncedAt, id);
			} else {
				database
					.prepare(
						`INSERT INTO cards
						 (id, source, plaid_item_id, external_account_ref, payload_enc,
						  last_synced_at, created_at, updated_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
					)
					.run(id, storedSource, connectionId, reference, encrypted, syncedAt, syncedAt, syncedAt);
			}
		}

		for (const { row } of existingCards) {
			if (!seenReferences.has(row.external_account_ref)) {
				database.prepare(`DELETE FROM cards WHERE id = ? AND source = ?`).run(row.id, storedSource);
			}
		}
	});
	transaction();
}

export async function replaceConnectedCards(
	provider: FinancialDataProvider,
	connectionId: string,
	snapshots: ConnectedCardSnapshot[],
	syncedAt: string
): Promise<void> {
	if (getRuntimeMode() === 'cloud') {
		await replaceCloudConnectedCards(provider, connectionId, snapshots, syncedAt);
	} else {
		replaceLocalConnectedCards(provider, connectionId, snapshots, syncedAt);
	}
}

export async function readConnectionTransactionState(
	provider: FinancialDataProvider,
	connectionId: string
): Promise<ConnectionTransactionState> {
	const storedSource = storedSourceForProvider(provider);
	const rows =
		getRuntimeMode() === 'cloud'
			? await cloudQuery<CardRow>(
					`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
					        last_synced_at, created_at, updated_at
					 FROM public.carddue_cards
					 WHERE tenant_ref = $1 AND plaid_item_id = $2 AND source = $3`,
					[tenantReference(), connectionId, storedSource]
				)
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE plaid_item_id = ? AND source = ?`
					)
					.all(connectionId, storedSource) as CardRow[]);
	const enabledRows = rows
		.map((row) => ({ row, history: transactionHistoryFromRow(row) }))
		.filter(
			(value): value is { row: CardRow; history: StoredTransactionHistory } =>
				value.history !== undefined
		);
	if (enabledRows.length === 0) {
		return {
			enabled: false,
			cursor: null,
			status: 'unknown',
			byAccountReference: new Map()
		};
	}

	const cursor = enabledRows[0].history.cursor;
	const status = enabledRows[0].history.status;
	if (enabledRows.some(({ history }) => history.cursor !== cursor || history.status !== status)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return {
		enabled: true,
		cursor,
		status,
		byAccountReference: new Map(
			enabledRows.flatMap(({ row, history }) =>
				history.accountReference || row.external_account_ref
					? [[history.accountReference ?? row.external_account_ref!, history.transactions] as const]
					: []
			)
		)
	};
}

function transactionMatchesRewardCategory(
	transaction: StoredFinancialTransaction,
	matchCategory: CardRewardCategoryMatch
): boolean {
	const primary = transaction.categoryPrimary?.toUpperCase() ?? '';
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	const category = `${primary} ${detailed}`;

	switch (matchCategory) {
		case 'dining':
			return /(RESTAURANT|FAST_FOOD|FOOD_TRUCK|COFFEE|BAR)/.test(detailed);
		case 'groceries':
			return /(GROCER|SUPERMARKET)/.test(detailed);
		case 'gas':
			return /(GAS|FUEL)/.test(detailed);
		case 'travel':
			return primary === 'TRAVEL';
		case 'flights_hotels':
			return primary === 'TRAVEL' && /(FLIGHT|AIRLINE|LODGING|HOTEL|MOTEL|RESORT)/.test(detailed);
		case 'transit':
			return (
				primary === 'TRANSPORTATION' &&
				!/(GAS|FUEL)/.test(detailed) &&
				/(PUBLIC_TRANSIT|TAXI|RIDESHARE|PARKING|TOLL|TRANSPORTATION)/.test(category)
			);
		case 'entertainment':
			return primary === 'ENTERTAINMENT';
		case 'drugstores':
			return /(PHARMAC|DRUGSTORE)/.test(detailed);
		case 'streaming':
			return /(STREAMING|MUSIC_AND_AUDIO|TV_AND_MOVIES)/.test(detailed);
		case 'online_shopping':
			return /(ONLINE_MARKETPLACE|ONLINE_RETAIL)/.test(detailed);
		case 'home_improvement':
			return /(HOME_IMPROVEMENT|HARDWARE|BUILDING_SUPPLIES)/.test(detailed);
		case 'utilities':
			return (
				primary === 'RENT_AND_UTILITIES' &&
				/(UTILIT|ELECTRIC|INTERNET|CABLE|TELEPHONE|WATER|SEWAGE|GARBAGE)/.test(detailed)
			);
	}
}

function transactionMatchesVenmoCostcoWarehouse(transaction: StoredFinancialTransaction): boolean {
	const detailed = transaction.categoryDetailed?.toUpperCase() ?? '';
	if (detailed !== 'GENERAL_MERCHANDISE_SUPERSTORES') return false;

	const merchant = `${transaction.merchantName ?? ''} ${transaction.name}`
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ');
	return /\bCOSTCO\b/.test(merchant);
}

interface RankedRewardRate {
	rate: number;
	categoryName: string;
}

function venmoEligibleCategory(
	transaction: StoredFinancialTransaction
): { key: string; label: string } | null {
	if (transactionMatchesRewardCategory(transaction, 'transit')) {
		return { key: 'transportation', label: 'Transportation' };
	}
	if (transactionMatchesRewardCategory(transaction, 'travel')) {
		return { key: 'travel', label: 'Travel' };
	}
	if (
		transactionMatchesRewardCategory(transaction, 'groceries') ||
		transactionMatchesVenmoCostcoWarehouse(transaction)
	) {
		return { key: 'groceries', label: 'Groceries' };
	}
	if (transactionMatchesRewardCategory(transaction, 'entertainment')) {
		return { key: 'entertainment', label: 'Entertainment' };
	}
	if (transactionMatchesRewardCategory(transaction, 'dining')) {
		return { key: 'dining', label: 'Dining & nightlife' };
	}
	if (transactionMatchesRewardCategory(transaction, 'utilities')) {
		return { key: 'utilities', label: 'Bills & utilities' };
	}
	if (
		transactionMatchesRewardCategory(transaction, 'drugstores') ||
		transaction.categoryPrimary?.toUpperCase() === 'PERSONAL_CARE'
	) {
		return { key: 'health_beauty', label: 'Health & beauty' };
	}
	if (transactionMatchesRewardCategory(transaction, 'gas')) {
		return { key: 'gas', label: 'Gas' };
	}
	return null;
}

function rewardPeriodKey(transactionDate: string, statementDate: string | null): string {
	if (!statementDate) return transactionDate.slice(0, 7);
	const [year, month, day] = transactionDate.split('-').map(Number);
	const statementDay = Number(statementDate.slice(8, 10));
	const periodEnd = new Date(Date.UTC(year, month - 1 + (day > statementDay ? 1 : 0), 1));
	return `${periodEnd.getUTCFullYear()}-${String(periodEnd.getUTCMonth() + 1).padStart(2, '0')}`;
}

function venmoRankedRewardRates(
	transactions: StoredFinancialTransaction[],
	statementDate: string | null
): Map<string, RankedRewardRate> {
	const totalsByMonth = new Map<string, Map<string, { amountCents: number; label: string }>>();
	for (const transaction of transactions) {
		if (transaction.amountCents <= 0) continue;
		const category = venmoEligibleCategory(transaction);
		if (!category) continue;
		const month = rewardPeriodKey(transaction.date, statementDate);
		const totals = totalsByMonth.get(month) ?? new Map();
		const current = totals.get(category.key) ?? { amountCents: 0, label: category.label };
		current.amountCents += transaction.amountCents;
		totals.set(category.key, current);
		totalsByMonth.set(month, totals);
	}

	const rankingByMonth = new Map<string, Map<string, number>>();
	for (const [month, totals] of totalsByMonth) {
		const ranking = new Map<string, number>();
		[...totals.entries()]
			.sort(
				([leftKey, left], [rightKey, right]) =>
					right.amountCents - left.amountCents || leftKey.localeCompare(rightKey)
			)
			.forEach(([key], index) => ranking.set(key, index === 0 ? 3 : index === 1 ? 2 : 1));
		rankingByMonth.set(month, ranking);
	}

	return new Map(
		transactions.flatMap((transaction) => {
			const category = venmoEligibleCategory(transaction);
			if (!category) return [];
			const rate = rankingByMonth
				.get(rewardPeriodKey(transaction.date, statementDate))
				?.get(category.key);
			return rate
				? [
						[
							transaction.transactionId,
							{
								rate,
								categoryName: `${category.label} · ${rate === 3 ? 'top' : rate === 2 ? 'second' : 'other'} category`
							}
						] as const
					]
				: [];
		})
	);
}

function transactionRewardEstimate(
	transaction: StoredFinancialTransaction,
	rewards: NormalizedCardRewards,
	rankedRate?: RankedRewardRate
): CardTransactionRewardEstimate | null {
	if (
		!rewards.rewardType ||
		transaction.amountCents <= 0 ||
		(transaction.categoryPrimary !== null &&
			NON_REWARD_TRANSACTION_CATEGORIES.has(transaction.categoryPrimary.toUpperCase()))
	) {
		return null;
	}

	let rate = rankedRate?.rate ?? rewards.baseRate;
	let categoryName: string | null = rankedRate?.categoryName ?? null;
	for (const category of rewards.categories) {
		if (
			category.multiplier !== null &&
			category.matchCategory &&
			transactionMatchesRewardCategory(transaction, category.matchCategory) &&
			(rate === null || category.multiplier > rate)
		) {
			rate = category.multiplier;
			categoryName = category.name;
		}
	}
	if (rate === null) return null;

	return {
		type: rewards.rewardType,
		amount: Math.round((transaction.amountCents * rate) / 100),
		rate,
		categoryName,
		currency: transaction.currency
	};
}

function rewardCategorySpending(
	transactions: StoredFinancialTransaction[],
	rewards: NormalizedCardRewards,
	year: number
): CardRewardCategorySpend[] {
	const yearPrefix = `${year}-`;
	return rewards.categories.flatMap((category) => {
		const capCents = category.annualSpendCapCents;
		const matchCategory = category.matchCategory;
		if (!capCents || !matchCategory) return [];

		const spentCents = Math.max(
			0,
			transactions.reduce((total, transaction) => {
				if (
					transaction.pending ||
					!transaction.date.startsWith(yearPrefix) ||
					(transaction.categoryPrimary !== null &&
						NON_REWARD_TRANSACTION_CATEGORIES.has(transaction.categoryPrimary.toUpperCase())) ||
					!transactionMatchesRewardCategory(transaction, matchCategory)
				) {
					return total;
				}
				return total + transaction.amountCents;
			}, 0)
		);

		return [
			{
				categoryId: category.id,
				year,
				spentCents,
				capCents,
				remainingCents: Math.max(0, capCents - spentCents)
			}
		];
	});
}

export async function listCardTransactions(
	cardId: string,
	limit = 500
): Promise<{
	transactions: CardTransaction[];
	rewardCategorySpending: CardRewardCategorySpend[];
	status: TransactionHistoryStatus;
	lastSyncedAt: string | null;
}> {
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
		throw new AppError('INVALID_REQUEST', 'The request is invalid.', 400);
	}
	const row =
		getRuntimeMode() === 'cloud'
			? (
					await cloudQuery<CardRow>(
						`SELECT id::text, source, plaid_item_id::text, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM public.carddue_cards WHERE tenant_ref = $1 AND id = $2`,
						[tenantReference(), cardId]
					)
				)[0]
			: (getDatabase()
					.prepare(
						`SELECT id, source, plaid_item_id, external_account_ref, payload_enc,
						        last_synced_at, created_at, updated_at
						 FROM cards WHERE id = ?`
					)
					.get(cardId) as CardRow | undefined);
	if (!row) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	const payload = decodePayload(row);
	if (!payload) throw new AppError('CARD_NOT_FOUND', 'Card not found.', 404);
	if (row.source === 'manual') {
		throw new AppError(
			'TRANSACTION_HISTORY_UNAVAILABLE',
			'Transaction history is available for connected cards only.',
			409
		);
	}
	const history = payload?.transactionHistory;
	if (!history) {
		throw new AppError(
			'TRANSACTION_HISTORY_NOT_ENABLED',
			'Transaction history has not been enabled for this connection.',
			409
		);
	}
	const rewards = effectiveRewardsForPayload(payload);
	const rewardCategorySpend = rewardCategorySpending(
		history.transactions,
		rewards,
		new Date().getUTCFullYear()
	);
	const rankedRates =
		rewards.calculation === 'venmo_spend_ranked'
			? venmoRankedRewardRates(history.transactions, payload.statementDate)
			: new Map<string, RankedRewardRate>();
	const transactions = history.transactions
		.map<CardTransaction>((transaction) => ({
			id: providerTransactionId(
				providerForStoredSource(row.source)!,
				transaction.transactionId,
				cardId
			),
			name: transaction.name,
			merchantName: transaction.merchantName,
			amountCents: transaction.amountCents,
			currency: transaction.currency,
			date: transaction.date,
			authorizedDate: transaction.authorizedDate,
			pending: transaction.pending,
			categoryPrimary: transaction.categoryPrimary,
			categoryDetailed: transaction.categoryDetailed,
			rewardEstimate: transactionRewardEstimate(
				transaction,
				rewards,
				rankedRates.get(transaction.transactionId)
			)
		}))
		.sort(
			(left, right) => right.date.localeCompare(left.date) || left.name.localeCompare(right.name)
		)
		.slice(0, limit);
	return {
		transactions,
		rewardCategorySpending: rewardCategorySpend,
		status: history.status,
		lastSyncedAt: row.last_synced_at
	};
}
