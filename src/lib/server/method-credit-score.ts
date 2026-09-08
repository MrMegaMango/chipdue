import { z } from 'zod';
import type {
	CreditBureau,
	CreditScoreConnectionStatus,
	CreditScoreFactor
} from '$lib/credit-score-types';
import { upsertConnectedCreditScore } from './credit-scores';
import { AppError } from './errors';
import {
	getMethodCreditScoreState,
	listMethodCreditScoreTenantIds,
	saveMethodCreditScoreState,
	type MethodCreditScoreState
} from './method-credit-score-store';
import type { StartMethodCreditScoreData } from './method-credit-score-schemas';
import { runAsTenant } from './tenant';

export type MethodEnvironment = 'development' | 'sandbox' | 'production';

interface MethodConfiguration {
	apiKey: string;
	environment: MethodEnvironment;
	apiBaseUrl: string;
	opalOrigin: string;
}

export interface MethodOpalSession {
	token: string;
	sessionId: string;
	opalUrl: string;
	opalOrigin: string;
}

type Fetcher = typeof fetch;

const METHOD_VERSION = '2026-03-30';
const methodId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9]+$`));
const entitySchema = z
	.object({
		id: methodId('ent'),
		status: z.string().optional(),
		verification: z
			.object({
				identity: z.object({ verified: z.boolean().optional() }).passthrough().optional(),
				phone: z.object({ verified: z.boolean().optional() }).passthrough().optional()
			})
			.passthrough()
			.optional()
	})
	.passthrough();
const opalTokenSchema = z.object({
	token: methodId('otkn'),
	session_id: methodId('osess')
});
const subscriptionSchema = z
	.object({
		id: methodId('sub'),
		name: z.string().min(1).max(80),
		status: z.string()
	})
	.passthrough();
const subscriptionMapSchema = z.record(z.string(), subscriptionSchema);
const factorSchema = z.union([
	z.string().min(1).max(500),
	z.object({
		code: z.string().max(40).nullable().optional(),
		description: z.string().min(1).max(500)
	})
]);
const creditScoreRecordSchema = z
	.object({
		id: methodId('crs'),
		entity_id: methodId('ent'),
		status: z.string(),
		scores: z
			.array(
				z.object({
					score: z.number().int().min(300).max(850),
					source: z.string().min(1).max(40),
					model: z.string().min(1).max(80),
					factors: z.array(factorSchema).max(12).default([]),
					created_at: z.string().datetime()
				})
			)
			.nullable()
	})
	.passthrough();

function methodEnvironment(value: string | undefined): MethodEnvironment {
	const normalized = value?.trim().toLowerCase() || 'development';
	if (normalized === 'dev') return 'development';
	if (normalized === 'development' || normalized === 'sandbox' || normalized === 'production') {
		return normalized;
	}
	throw new AppError(
		'METHOD_NOT_CONFIGURED',
		'Automatic credit score sync is not configured.',
		503
	);
}

export function getMethodConfiguration(): MethodConfiguration | null {
	const apiKey = process.env.METHOD_API_KEY?.trim();
	if (!apiKey) return null;
	if (!/^sk_[A-Za-z0-9_-]{12,300}$/.test(apiKey)) {
		throw new AppError(
			'METHOD_NOT_CONFIGURED',
			'Automatic credit score sync is not configured.',
			503
		);
	}
	const environment = methodEnvironment(process.env.METHOD_ENV);
	const host = environment === 'development' ? 'dev' : environment;
	return {
		apiKey,
		environment,
		apiBaseUrl: `https://${host}.methodfi.com`,
		opalOrigin: `https://opal.${host}.methodfi.com`
	};
}

function requireMethodConfiguration(): MethodConfiguration {
	const configuration = getMethodConfiguration();
	if (!configuration) {
		throw new AppError(
			'METHOD_NOT_CONFIGURED',
			'Automatic credit score sync is not configured.',
			503
		);
	}
	return configuration;
}

function responseData(value: unknown): unknown {
	if (value && typeof value === 'object' && 'data' in value) {
		return (value as { data?: unknown }).data;
	}
	return value;
}

function providerMessage(value: unknown): string | null {
	if (!value || typeof value !== 'object') return null;
	const message = (value as { message?: unknown }).message;
	if (typeof message === 'string' && message.trim()) return message.slice(0, 300);
	const error = (value as { error?: unknown }).error;
	if (error && typeof error === 'object') {
		const errorMessage = (error as { message?: unknown }).message;
		if (typeof errorMessage === 'string' && errorMessage.trim()) return errorMessage.slice(0, 300);
	}
	return null;
}

async function methodRequest(
	path: string,
	init: RequestInit = {},
	fetcher: Fetcher = fetch
): Promise<unknown> {
	const configuration = requireMethodConfiguration();
	let response: Response;
	try {
		response = await fetcher(`${configuration.apiBaseUrl}${path}`, {
			...init,
			headers: {
				accept: 'application/json',
				authorization: `Bearer ${configuration.apiKey}`,
				'Method-Version': METHOD_VERSION,
				...(init.body ? { 'content-type': 'application/json' } : {}),
				...init.headers
			}
		});
	} catch {
		throw new AppError(
			'METHOD_UNAVAILABLE',
			'The automatic credit score provider could not be reached.',
			503
		);
	}
	const payload = (await response.json().catch(() => null)) as unknown;
	if (
		!response.ok ||
		(payload && typeof payload === 'object' && (payload as { success?: unknown }).success === false)
	) {
		throw new AppError(
			'METHOD_REQUEST_FAILED',
			providerMessage(payload) ??
				'The automatic credit score provider could not complete the request.',
			response.status >= 400 && response.status < 500 ? 409 : 503
		);
	}
	return payload;
}

function opalSession(value: unknown, configuration: MethodConfiguration): MethodOpalSession {
	const parsed = opalTokenSchema.parse(responseData(value));
	return {
		token: parsed.token,
		sessionId: parsed.session_id,
		opalUrl: `${configuration.opalOrigin}?token=${encodeURIComponent(parsed.token)}`,
		opalOrigin: configuration.opalOrigin
	};
}

export async function startMethodCreditScoreOnboarding(
	input: StartMethodCreditScoreData,
	fetcher: Fetcher = fetch
): Promise<MethodOpalSession> {
	const configuration = requireMethodConfiguration();
	const current = await getMethodCreditScoreState();
	if (current.state === 'connected') {
		throw new AppError(
			'METHOD_ALREADY_CONNECTED',
			'Automatic credit score sync is already connected.',
			409
		);
	}
	if (current.state === 'onboarding') return resumeMethodCreditScoreOnboarding(fetcher);

	const entity = entitySchema.parse(
		responseData(
			await methodRequest(
				'/entities',
				{
					method: 'POST',
					body: JSON.stringify({
						type: 'individual',
						individual: {
							first_name: input.firstName,
							last_name: input.lastName,
							phone: input.phone
						}
					})
				},
				fetcher
			)
		)
	);
	const session = opalSession(
		await methodRequest(
			'/opal/token',
			{
				method: 'POST',
				body: JSON.stringify({
					entity_id: entity.id,
					mode: 'identity_verification',
					identity_verification: {}
				})
			},
			fetcher
		),
		configuration
	);
	await saveMethodCreditScoreState({
		state: 'onboarding',
		entityId: entity.id,
		sessionId: session.sessionId,
		startedAt: new Date().toISOString()
	});
	return session;
}

export async function resumeMethodCreditScoreOnboarding(
	fetcher: Fetcher = fetch
): Promise<MethodOpalSession> {
	const configuration = requireMethodConfiguration();
	const current = await getMethodCreditScoreState();
	if (current.state !== 'onboarding') {
		throw new AppError('METHOD_ONBOARDING_NOT_FOUND', 'Start automatic score setup first.', 409);
	}
	return opalSession(
		await methodRequest(
			'/opal/token',
			{ method: 'POST', body: JSON.stringify({ session_id: current.sessionId }) },
			fetcher
		),
		configuration
	);
}

function entityIsVerified(entity: z.infer<typeof entitySchema>): boolean {
	return (
		entity.status === 'active' ||
		(entity.verification?.identity?.verified === true &&
			entity.verification?.phone?.verified === true)
	);
}

async function ensureCreditScoreSubscription(
	entityId: string,
	fetcher: Fetcher
): Promise<z.infer<typeof subscriptionSchema>> {
	const existingPayload = responseData(
		await methodRequest(`/entities/${encodeURIComponent(entityId)}/subscriptions`, {}, fetcher)
	);
	const existing = subscriptionMapSchema.safeParse(existingPayload);
	const active = existing.success
		? Object.values(existing.data).find(
				(subscription) => subscription.name === 'credit_score' && subscription.status === 'active'
			)
		: undefined;
	if (active) return active;
	const created = subscriptionSchema.parse(
		responseData(
			await methodRequest(
				`/entities/${encodeURIComponent(entityId)}/subscriptions`,
				{ method: 'POST', body: JSON.stringify({ enroll: 'credit_score' }) },
				fetcher
			)
		)
	);
	if (created.name !== 'credit_score') {
		throw new AppError(
			'METHOD_REQUEST_FAILED',
			'The automatic credit score subscription could not be activated.',
			503
		);
	}
	return created;
}

export async function activateMethodCreditScoreConnection(fetcher: Fetcher = fetch): Promise<void> {
	const current = await getMethodCreditScoreState();
	if (current.state === 'connected') {
		await syncMethodCreditScores(fetcher);
		return;
	}
	if (current.state !== 'onboarding') {
		throw new AppError('METHOD_ONBOARDING_NOT_FOUND', 'Start automatic score setup first.', 409);
	}
	const entity = entitySchema.parse(
		responseData(
			await methodRequest(`/entities/${encodeURIComponent(current.entityId)}`, {}, fetcher)
		)
	);
	if (!entityIsVerified(entity)) {
		throw new AppError(
			'METHOD_VERIFICATION_INCOMPLETE',
			'Finish the secure identity check before activating automatic score sync.',
			409
		);
	}
	const subscription = await ensureCreditScoreSubscription(current.entityId, fetcher);
	const connectedAt = new Date().toISOString();
	await saveMethodCreditScoreState({
		state: 'connected',
		entityId: current.entityId,
		subscriptionId: subscription.id,
		pendingRequestId: null,
		connectedAt,
		lastSyncedAt: null,
		lastError: null
	});
	try {
		const request = creditScoreRecordSchema.parse(
			responseData(
				await methodRequest(
					`/entities/${encodeURIComponent(current.entityId)}/credit_scores`,
					{ method: 'POST' },
					fetcher
				)
			)
		);
		await saveMethodCreditScoreState({
			state: 'connected',
			entityId: current.entityId,
			subscriptionId: subscription.id,
			pendingRequestId: request.id,
			connectedAt,
			lastSyncedAt: null,
			lastError: null
		});
		if (request.status === 'completed') await syncMethodCreditScores(fetcher);
	} catch (error) {
		await saveConnectedError(await getMethodCreditScoreState(), error);
		throw error;
	}
}

function bureauForMethodSource(source: string): CreditBureau {
	const normalized = source.toLowerCase();
	if (normalized === 'equifax' || normalized === 'experian' || normalized === 'transunion') {
		return normalized;
	}
	return 'other';
}

function methodModelLabel(model: string): string {
	return (
		{
			vantage_3: 'VantageScore 3.0',
			vantage_4: 'VantageScore 4.0',
			fico_8: 'FICO Score 8'
		}[model.toLowerCase()] ?? model.replaceAll('_', ' ')
	);
}

function normalizedFactors(factors: z.infer<typeof factorSchema>[]): CreditScoreFactor[] {
	return factors.map((factor) =>
		typeof factor === 'string'
			? { code: null, description: factor }
			: { code: factor.code ?? null, description: factor.description }
	);
}

async function saveConnectedError(state: MethodCreditScoreState, error: unknown): Promise<void> {
	if (state.state !== 'connected') return;
	await saveMethodCreditScoreState({
		state: 'connected',
		entityId: state.entityId,
		subscriptionId: state.subscriptionId,
		pendingRequestId: state.pendingRequestId,
		connectedAt: state.connectedAt,
		lastSyncedAt: state.lastSyncedAt,
		lastError:
			error instanceof AppError
				? error.message.slice(0, 300)
				: 'Automatic credit score sync needs attention.'
	});
}

export async function syncMethodCreditScores(
	fetcher: Fetcher = fetch
): Promise<{ imported: number; newestRecordedDate: string | null }> {
	const state = await getMethodCreditScoreState();
	if (state.state !== 'connected') {
		throw new AppError('METHOD_NOT_CONNECTED', 'Connect automatic credit score sync first.', 409);
	}
	try {
		const response = await methodRequest(
			`/entities/${encodeURIComponent(state.entityId)}/credit_scores`,
			{},
			fetcher
		);
		const records = z.array(creditScoreRecordSchema).parse(responseData(response));
		let imported = 0;
		let newestRecordedDate: string | null = null;
		for (const record of records) {
			if (record.status !== 'completed' || !record.scores) continue;
			for (const score of record.scores) {
				const recordedDate = score.created_at.slice(0, 10);
				const result = await upsertConnectedCreditScore({
					externalId: `${record.id}:${score.source}:${score.model}`,
					score: score.score,
					bureau: bureauForMethodSource(score.source),
					model: methodModelLabel(score.model),
					source: 'Method',
					recordedDate,
					factors: normalizedFactors(score.factors)
				});
				if (result.created) imported += 1;
				if (!newestRecordedDate || recordedDate > newestRecordedDate) {
					newestRecordedDate = recordedDate;
				}
			}
		}
		await saveMethodCreditScoreState({
			state: 'connected',
			entityId: state.entityId,
			subscriptionId: state.subscriptionId,
			pendingRequestId: null,
			connectedAt: state.connectedAt,
			lastSyncedAt: new Date().toISOString(),
			lastError: null
		});
		return { imported, newestRecordedDate };
	} catch (error) {
		await saveConnectedError(state, error);
		throw error;
	}
}

export async function methodCreditScoreStatus(): Promise<CreditScoreConnectionStatus> {
	let configuration: MethodConfiguration | null;
	try {
		configuration = getMethodConfiguration();
	} catch {
		configuration = null;
	}
	if (!configuration) {
		return {
			provider: 'method',
			providerName: 'Method',
			state: 'not_configured',
			environment: null,
			lastSyncedAt: null,
			message: 'Automatic score sync is waiting for the secure provider connection.'
		};
	}
	const state = await getMethodCreditScoreState();
	if (state.state === 'disconnected') {
		return {
			provider: 'method',
			providerName: 'Method',
			state: 'disconnected',
			environment: configuration.environment,
			lastSyncedAt: null,
			message: 'Connect once, then score changes are imported automatically.'
		};
	}
	if (state.state === 'onboarding') {
		return {
			provider: 'method',
			providerName: 'Method',
			state: 'onboarding',
			environment: configuration.environment,
			lastSyncedAt: null,
			message: 'Finish the secure identity check to start automatic monitoring.'
		};
	}
	return {
		provider: 'method',
		providerName: 'Method',
		state: state.lastError ? 'needs_attention' : 'connected',
		environment: configuration.environment,
		lastSyncedAt: state.lastSyncedAt,
		message: state.lastError ?? 'Score changes are monitored and imported automatically.'
	};
}

export async function syncAllTenantMethodCreditScores(): Promise<{
	configured: boolean;
	connected: number;
	synced: number;
	failed: number;
}> {
	if (!getMethodConfiguration()) return { configured: false, connected: 0, synced: 0, failed: 0 };
	const tenantIds = await listMethodCreditScoreTenantIds();
	let connected = 0;
	let synced = 0;
	let failed = 0;
	for (const tenantId of tenantIds) {
		await runAsTenant(tenantId, async () => {
			const state = await getMethodCreditScoreState();
			if (state.state !== 'connected') return;
			connected += 1;
			try {
				await syncMethodCreditScores();
				synced += 1;
			} catch {
				failed += 1;
			}
		});
	}
	return { configured: true, connected, synced, failed };
}
