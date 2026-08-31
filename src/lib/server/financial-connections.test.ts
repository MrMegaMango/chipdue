import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialConnection } from '$lib/types';
import { AppError } from './errors';

const connectionMocks = vi.hoisted(() => ({
	listPlaidConnections: vi.fn(),
	syncPlaidItem: vi.fn(),
	plaidConfigurationStatus: vi.fn(),
	syncAllPlaidItems: vi.fn(),
	disconnectPlaidItem: vi.fn()
}));

vi.mock('./plaid-store', () => ({
	listPlaidConnections: connectionMocks.listPlaidConnections
}));

vi.mock('./plaid-config', () => ({
	isInstallationPlaidConfigured: () => true
}));

vi.mock('./plaid', () => ({
	disconnectPlaidItem: connectionMocks.disconnectPlaidItem,
	plaidConfigurationStatus: connectionMocks.plaidConfigurationStatus,
	syncAllPlaidItems: connectionMocks.syncAllPlaidItems,
	syncPlaidItem: connectionMocks.syncPlaidItem
}));

import { syncCurrentTenantFinancialConnections } from './financial-connections';

function connection(id: string, institutionName: string | null): FinancialConnection {
	return {
		id,
		provider: 'plaid',
		institutionName,
		status: 'healthy',
		lastSyncedAt: null,
		createdAt: '2026-08-31T12:00:00.000Z'
	};
}

describe('current-tenant financial connection sync', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		connectionMocks.plaidConfigurationStatus.mockResolvedValue({ configured: true });
	});

	it('identifies the institution when a connection requires repair', async () => {
		const connections = [connection('amex', 'American Express'), connection('chase', 'Chase')];
		connectionMocks.listPlaidConnections.mockResolvedValue(connections);
		connectionMocks.syncPlaidItem.mockImplementation(async (id: string) => {
			if (id === 'chase') {
				throw new AppError('PLAID_LOGIN_REQUIRED', 'This connection needs to be updated.', 409);
			}
			return {
				syncedAt: '2026-08-31T12:30:00.000Z',
				count: 1,
				accountCount: 0,
				transactionCount: 3
			};
		});

		await expect(syncCurrentTenantFinancialConnections()).rejects.toMatchObject({
			code: 'PLAID_LOGIN_REQUIRED',
			message: 'Sync failed for Chase: This connection needs to be updated.',
			status: 409
		});
	});

	it('uses the provider name when the institution name is unavailable', async () => {
		connectionMocks.listPlaidConnections.mockResolvedValue([connection('unknown', null)]);
		connectionMocks.syncPlaidItem.mockRejectedValue(
			new AppError('PLAID_UNAVAILABLE', 'Plaid could not complete the request.', 502)
		);

		await expect(syncCurrentTenantFinancialConnections()).rejects.toMatchObject({
			message: 'Sync failed for Plaid: Plaid could not complete the request.'
		});
	});
});
