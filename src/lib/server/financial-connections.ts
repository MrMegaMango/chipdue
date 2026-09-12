import { FINANCIAL_PROVIDER_NAMES } from '$lib/financial-data';
import type {
	FinancialConnection,
	FinancialDataProvider,
	FinancialProviderStatus
} from '$lib/types';
import { AppError, asAppError } from './errors';
import {
	disconnectPlaidItem,
	plaidConfigurationStatus,
	refreshPlaidTransactions,
	syncAllPlaidItems,
	syncPlaidItem
} from './plaid';
import { isInstallationPlaidConfigured } from './plaid-config';
import { listPlaidConnections } from './plaid-store';

export interface ConnectionSyncResult {
	syncedAt: string;
	cardCount: number;
	accountCount: number;
	transactionCount: number;
}

export type ConnectionTransactionRefreshResult = ConnectionSyncResult & {
	availability: 'refreshed' | 'unsupported';
};

export interface ConnectionSyncFailure {
	connectionId: string;
	institutionName: string | null;
	code: string;
	message: string;
}

export interface ConnectionsSyncResult {
	syncedConnections: number;
	failedConnections: number;
	skippedConnections: number;
	failures?: ConnectionSyncFailure[];
	cardCount: number;
	accountCount: number;
	transactionCount: number;
	lastSyncedAt: string | null;
}

interface FinancialProviderAdapter {
	provider: FinancialDataProvider;
	displayName: string;
	isInstallationConfigured(): boolean;
	isConfigured(): Promise<boolean>;
	listConnections(): Promise<FinancialConnection[]>;
	syncConnection(
		connectionId: string,
		options?: { enableTransactions?: boolean }
	): Promise<ConnectionSyncResult>;
	refreshTransactions(connectionId: string): Promise<ConnectionTransactionRefreshResult>;
	syncAllTenants(): Promise<ConnectionsSyncResult>;
	disconnectConnection(connectionId: string): Promise<void>;
}

const plaidAdapter: FinancialProviderAdapter = {
	provider: 'plaid',
	displayName: FINANCIAL_PROVIDER_NAMES.plaid,
	isInstallationConfigured: isInstallationPlaidConfigured,
	async isConfigured() {
		return (await plaidConfigurationStatus()).configured;
	},
	listConnections: listPlaidConnections,
	async syncConnection(connectionId, options) {
		const result = await syncPlaidItem(connectionId, options);
		return {
			syncedAt: result.syncedAt,
			cardCount: result.count,
			accountCount: result.accountCount,
			transactionCount: result.transactionCount
		};
	},
	async refreshTransactions(connectionId) {
		return refreshPlaidTransactions(connectionId);
	},
	async syncAllTenants() {
		const result = await syncAllPlaidItems();
		return {
			syncedConnections: result.syncedItems,
			failedConnections: result.failedItems,
			skippedConnections: result.skippedItems,
			cardCount: result.cardCount,
			accountCount: result.accountCount,
			transactionCount: result.transactionCount,
			lastSyncedAt: result.lastSyncedAt
		};
	},
	disconnectConnection: disconnectPlaidItem
};

const PROVIDERS = Object.freeze([plaidAdapter] satisfies FinancialProviderAdapter[]);

export function installationFinancialConnectionsStatus(): {
	adapterCount: number;
	configuredAdapterCount: number;
} {
	return {
		adapterCount: PROVIDERS.length,
		configuredAdapterCount: PROVIDERS.filter((adapter) => adapter.isInstallationConfigured()).length
	};
}

function summarize(results: ConnectionSyncResult[]): ConnectionsSyncResult {
	return {
		syncedConnections: results.length,
		failedConnections: 0,
		skippedConnections: 0,
		cardCount: results.reduce((total, result) => total + result.cardCount, 0),
		accountCount: results.reduce((total, result) => total + result.accountCount, 0),
		transactionCount: results.reduce((total, result) => total + result.transactionCount, 0),
		lastSyncedAt:
			results
				.map((result) => result.syncedAt)
				.sort()
				.at(-1) ?? null
	};
}

async function adapterForConnection(
	connectionId: string
): Promise<{ adapter: FinancialProviderAdapter; connection: FinancialConnection }> {
	for (const adapter of PROVIDERS) {
		const connection = (await adapter.listConnections()).find(
			(candidate) => candidate.id === connectionId
		);
		if (connection) return { adapter, connection };
	}
	throw new AppError('CONNECTION_NOT_FOUND', 'Connection not found.', 404);
}

export async function listFinancialConnections(): Promise<FinancialConnection[]> {
	return (await Promise.all(PROVIDERS.map((adapter) => adapter.listConnections()))).flat();
}

export async function listFinancialProviderStatuses(): Promise<FinancialProviderStatus[]> {
	return Promise.all(
		PROVIDERS.map(async (adapter) => {
			const [configured, connections] = await Promise.all([
				adapter.isConfigured(),
				adapter.listConnections()
			]);
			return {
				provider: adapter.provider,
				displayName: adapter.displayName,
				configured,
				connectionCount: connections.length,
				lastSyncedAt:
					connections
						.map((connection) => connection.lastSyncedAt)
						.filter((value): value is string => value !== null)
						.sort()
						.at(-1) ?? null
			};
		})
	);
}

export async function financialConnectionsStatus(): Promise<{
	providers: FinancialProviderStatus[];
	connections: FinancialConnection[];
}> {
	const [providers, connections] = await Promise.all([
		listFinancialProviderStatuses(),
		listFinancialConnections()
	]);
	return { providers, connections };
}

export async function syncFinancialConnection(
	connectionId: string,
	options: { enableTransactions?: boolean } = {}
): Promise<ConnectionSyncResult> {
	const { adapter } = await adapterForConnection(connectionId);
	return adapter.syncConnection(connectionId, options);
}

export async function refreshFinancialConnectionTransactions(
	connectionId: string
): Promise<ConnectionTransactionRefreshResult> {
	const { adapter } = await adapterForConnection(connectionId);
	return adapter.refreshTransactions(connectionId);
}

export async function syncCurrentTenantFinancialConnections(
	options: { enableTransactions?: boolean } = {}
): Promise<ConnectionsSyncResult> {
	const connections = await listFinancialConnections();
	const eligibleConnections = connections.filter(
		(connection) => connection.syncPaused !== true && connection.status !== 'needs_update'
	);
	const outcomes = await Promise.allSettled(
		eligibleConnections.map(async (connection) => {
			const adapter = PROVIDERS.find((candidate) => candidate.provider === connection.provider);
			if (!adapter) throw new AppError('CONNECTION_NOT_FOUND', 'Connection not found.', 404);
			return adapter.syncConnection(connection.id, options);
		})
	);
	const results: ConnectionSyncResult[] = [];
	const failures: ConnectionSyncFailure[] = [];
	let firstFailure: AppError | undefined;
	for (const [index, outcome] of outcomes.entries()) {
		if (outcome.status === 'fulfilled') {
			results.push(outcome.value);
			continue;
		}
		const connection = eligibleConnections[index];
		const safeError = asAppError(outcome.reason);
		const institutionName =
			connection.institutionName?.trim() || FINANCIAL_PROVIDER_NAMES[connection.provider];
		firstFailure ??= new AppError(
			safeError.code,
			`Sync failed for ${institutionName}: ${safeError.message}`,
			safeError.status
		);
		failures.push({
			connectionId: connection.id,
			institutionName: connection.institutionName,
			code: safeError.code,
			message: safeError.message
		});
	}
	if (firstFailure && results.length === 0) throw firstFailure;
	return {
		...summarize(results),
		failedConnections: failures.length,
		skippedConnections: connections.length - eligibleConnections.length,
		failures
	};
}

export async function syncAllTenantFinancialConnections(): Promise<ConnectionsSyncResult> {
	const results = await Promise.all(PROVIDERS.map((adapter) => adapter.syncAllTenants()));
	return {
		syncedConnections: results.reduce((total, result) => total + result.syncedConnections, 0),
		failedConnections: results.reduce((total, result) => total + result.failedConnections, 0),
		skippedConnections: results.reduce((total, result) => total + result.skippedConnections, 0),
		cardCount: results.reduce((total, result) => total + result.cardCount, 0),
		accountCount: results.reduce((total, result) => total + result.accountCount, 0),
		transactionCount: results.reduce((total, result) => total + result.transactionCount, 0),
		lastSyncedAt:
			results
				.map((result) => result.lastSyncedAt)
				.filter((value): value is string => value !== null)
				.sort()
				.at(-1) ?? null
	};
}

export async function disconnectFinancialConnection(connectionId: string): Promise<void> {
	const { adapter } = await adapterForConnection(connectionId);
	await adapter.disconnectConnection(connectionId);
}
