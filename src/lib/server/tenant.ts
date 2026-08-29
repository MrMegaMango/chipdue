import { AsyncLocalStorage } from 'node:async_hooks';
import { privateFingerprint, secretsEqual } from './crypto';
import { AppError } from './errors';
import { getRuntimeMode } from './runtime';

export const LEGACY_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_REFERENCE_PURPOSE = 'carddue-tenant-owner-v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const tenantStorage = new AsyncLocalStorage<string>();

export function isTenantId(value: unknown): value is string {
	return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function runAsTenant<T>(tenantId: string, operation: () => T): T {
	if (!isTenantId(tenantId)) {
		throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
	}
	return tenantStorage.run(tenantId, operation);
}

export function currentTenantId(): string {
	const tenantId = tenantStorage.getStore();
	if (tenantId) return tenantId;
	if (getRuntimeMode() === 'local' || process.env.NODE_ENV === 'test') return LEGACY_TENANT_ID;
	throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
}

export function tenantReference(tenantId = currentTenantId()): string {
	if (!isTenantId(tenantId)) {
		throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
	}
	return privateFingerprint(tenantId, TENANT_REFERENCE_PURPOSE);
}

export function tenantPayloadFields(): { tenantRef: string } {
	return { tenantRef: tenantReference() };
}

export function payloadBelongsToCurrentTenant(payload: { tenantRef?: unknown }): boolean {
	if (payload.tenantRef === undefined) return currentTenantId() === LEGACY_TENANT_ID;
	if (typeof payload.tenantRef !== 'string' || !OPAQUE_REFERENCE_PATTERN.test(payload.tenantRef)) {
		throw new AppError('ENCRYPTED_DATA_UNREADABLE', 'Encrypted data could not be read.', 500);
	}
	return secretsEqual(payload.tenantRef, tenantReference());
}

export function plaidItemReference(itemId: string, tenantId = currentTenantId()): string {
	const itemReference = privateFingerprint(itemId, 'plaid-item');
	return tenantId === LEGACY_TENANT_ID ? itemReference : `${tenantId}:${itemReference}`;
}

export function tenantIdFromPlaidItemReference(reference: string): string | null {
	if (OPAQUE_REFERENCE_PATTERN.test(reference)) return LEGACY_TENANT_ID;
	const separator = reference.indexOf(':');
	if (separator < 1) return null;
	const tenantId = reference.slice(0, separator);
	const itemReference = reference.slice(separator + 1);
	return isTenantId(tenantId) && OPAQUE_REFERENCE_PATTERN.test(itemReference) ? tenantId : null;
}

export function plaidItemBelongsToCurrentTenant(reference: string): boolean {
	return tenantIdFromPlaidItemReference(reference) === currentTenantId();
}
