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

export interface ConnectionsSyncResult {
	syncedConnections: number;
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
	async syncAllTenants() {
		const result = await syncAllPlaidItems();
		return {
			syncedConnections: result.syncedItems,
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

export async function syncCurrentTenantFinancialConnections(): Promise<ConnectionsSyncResult> {
	const connections = await listFinancialConnections();
	return summarize(
		await Promise.all(
			connections.map(async (connection) => {
				try {
					return await syncFinancialConnection(connection.id);
				} catch (error) {
					const safeError = asAppError(error);
					const institutionName =
						connection.institutionName?.trim() || FINANCIAL_PROVIDER_NAMES[connection.provider];
					throw new AppError(
						safeError.code,
						`Sync failed for ${institutionName}: ${safeError.message}`,
						safeError.status
					);
				}
			})
		)
	);
}

export async function syncAllTenantFinancialConnections(): Promise<ConnectionsSyncResult> {
	const results = await Promise.all(PROVIDERS.map((adapter) => adapter.syncAllTenants()));
	return {
		syncedConnections: results.reduce((total, result) => total + result.syncedConnections, 0),
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
