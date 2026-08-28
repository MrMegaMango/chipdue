import { createHash, randomBytes } from 'node:crypto';
import type { Cookies } from '@sveltejs/kit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import {
	authenticateSession,
	consumeGoogleOidcBootstrapRateLimit,
	consumeGoogleOidcStartRateLimit,
	issueGoogleOidcSession,
	SESSION_COOKIE_NAME
} from './auth';
import { cloudQuery } from './cloud-database';
import { decryptJson, encryptJson, privateFingerprint, secretsEqual } from './crypto';
import { AppError } from './errors';
import { assertSecureCloudRequest, expectedRequestOrigin } from './request-security';
import { getCloudRuntimeConfig, getRuntimeMode, type GoogleOidcConfig } from './runtime';

export const GOOGLE_TRANSACTION_COOKIE_NAME = '__Host-carddue_google_tx';
export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_BOOTSTRAP_CONTINUE_PATH = '/api/auth/google/bootstrap/continue';
export const GOOGLE_ISSUER = 'https://accounts.google.com';

const GOOGLE_BARE_ISSUER = 'accounts.google.com';
const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_LINK_METADATA_KEY = 'google_oidc_subject_ref_v1';
const GOOGLE_BOOTSTRAP_CLAIM_METADATA_KEY = 'google_oidc_bootstrap_claim_ref_v1';
const TRANSACTION_COOKIE_PURPOSE = 'google-oidc-transaction-cookie-v1';
const TRANSACTION_REFERENCE_PURPOSE = 'google-oidc-transaction-reference-v1';
const GOOGLE_SUBJECT_PURPOSE = 'google-oidc-subject-v1';
const GOOGLE_BOOTSTRAP_CLAIM_PURPOSE = 'google-oidc-bootstrap-claim-v1';
const GOOGLE_BOOTSTRAP_CONSUMED_PURPOSE = 'google-oidc-bootstrap-consumed-v1';
const GOOGLE_BOOTSTRAP_TOKEN_DOMAIN = 'carddue:google-oidc-bootstrap-token:v1\0';
const ACTIVE_BOOTSTRAP_CLAIM_PREFIX = 'active:v1:';
const CONSUMED_BOOTSTRAP_CLAIM_PREFIX = 'consumed:v1:';
const TRANSACTION_TTL_SECONDS = 10 * 60;
const MAX_CALLBACK_QUERY_BYTES = 8 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_ID_TOKEN_BYTES = 16 * 1024;
const OUTBOUND_TIMEOUT_MS = 8_000;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export type GoogleOidcIntent = 'login' | 'link';
type GoogleTransactionIntent = GoogleOidcIntent | 'bootstrap';

interface GoogleTransaction {
	version: 2;
	transactionToken: string;
	intent: GoogleTransactionIntent;
	state: string;
	nonce: string;
	codeVerifier: string;
	redirectUri: string;
	expiresAt: number;
	linkSessionToken: string | null;
	bootstrapClaimRef: string | null;
}

interface MetadataRow extends Record<string, unknown> {
	value: string;
}

interface TransactionRow extends Record<string, unknown> {
	bucket_ref: string;
}

const transactionSchema = z
	.object({
		version: z.literal(2),
		transactionToken: z.string().regex(OPAQUE_TOKEN_PATTERN),
		intent: z.enum(['login', 'link', 'bootstrap']),
		state: z.string().regex(OPAQUE_TOKEN_PATTERN),
		nonce: z.string().regex(OPAQUE_TOKEN_PATTERN),
		codeVerifier: z.string().regex(OPAQUE_TOKEN_PATTERN),
		redirectUri: z.string().url().max(512),
		expiresAt: z.number().int().positive(),
		linkSessionToken: z.string().regex(OPAQUE_TOKEN_PATTERN).nullable(),
		bootstrapClaimRef: z.string().regex(OPAQUE_TOKEN_PATTERN).nullable()
	})
	.strict();

const remoteGoogleKeySet = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
	timeoutDuration: OUTBOUND_TIMEOUT_MS,
	cooldownDuration: 30_000,
	cacheMaxAge: 60 * 60 * 1000
});
let googleKeyResolver: Parameters<typeof jwtVerify>[1] = remoteGoogleKeySet;
let tokenFetch: typeof globalThis.fetch = (...arguments_) => globalThis.fetch(...arguments_);

function googleConfig(): GoogleOidcConfig {
	if (getRuntimeMode() !== 'cloud') {
		throw new AppError('GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not available.', 409);
	}
	const config = getCloudRuntimeConfig().googleOidc;
	if (!config) {
		throw new AppError('GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not configured.', 409);
	}
	return config;
}

function randomOpaqueToken(): string {
	return randomBytes(32).toString('base64url');
}

function isCanonicalOpaqueToken(value: string): boolean {
	if (!OPAQUE_TOKEN_PATTERN.test(value)) return false;
	const decoded = Buffer.from(value, 'base64url');
	return decoded.length === 32 && decoded.toString('base64url') === value;
}

function bootstrapHashForToken(token: string): string {
	return `sha256$${createHash('sha256')
		.update(GOOGLE_BOOTSTRAP_TOKEN_DOMAIN, 'utf8')
		.update(token, 'ascii')
		.digest('base64url')}`;
}

function currentBootstrapClaimReference(): string {
	const config = getCloudRuntimeConfig();
	if (config.authMode !== 'google' || !config.googleBootstrapHash) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	return privateFingerprint(config.googleBootstrapHash, GOOGLE_BOOTSTRAP_CLAIM_PURPOSE);
}

function verifyBootstrapToken(token: string): string {
	const config = getCloudRuntimeConfig();
	if (
		config.authMode !== 'google' ||
		!config.googleBootstrapHash ||
		!isCanonicalOpaqueToken(token) ||
		!secretsEqual(bootstrapHashForToken(token), config.googleBootstrapHash)
	) {
		throw new AppError('GOOGLE_BOOTSTRAP_FAILED', 'Google setup could not be started.', 401);
	}
	return currentBootstrapClaimReference();
}

function activeBootstrapClaimValue(claimReference: string): string {
	return `${ACTIVE_BOOTSTRAP_CLAIM_PREFIX}${claimReference}`;
}

function consumedBootstrapClaimValue(claimReference: string): string {
	return `${CONSUMED_BOOTSTRAP_CLAIM_PREFIX}${privateFingerprint(
		claimReference,
		GOOGLE_BOOTSTRAP_CONSUMED_PURPOSE
	)}`;
}

function transactionReference(transactionToken: string): string {
	return privateFingerprint(transactionToken, TRANSACTION_REFERENCE_PURPOSE);
}

function canonicalGoogleIssuer(issuer: unknown): string {
	if (issuer === GOOGLE_ISSUER || issuer === GOOGLE_BARE_ISSUER) return GOOGLE_ISSUER;
	throw new Error('invalid Google issuer');
}

function googleSubjectReference(issuer: unknown, subject: unknown): string {
	const canonicalIssuer = canonicalGoogleIssuer(issuer);
	if (typeof subject !== 'string' || !SUBJECT_PATTERN.test(subject)) {
		throw new Error('invalid Google subject');
	}
	return privateFingerprint(`${canonicalIssuer}\0${subject}`, GOOGLE_SUBJECT_PURPOSE);
}

function callbackUri(request: Request, url: URL): string {
	const authority = assertSecureCloudRequest(request, url);
	return `https://${authority}${GOOGLE_CALLBACK_PATH}`;
}

function assertStartRequestOrigin(request: Request, url: URL): void {
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
		throw new AppError('CROSS_ORIGIN_REQUEST', 'Cross-origin changes are not allowed.', 403);
	}
	const origin = request.headers.get('origin');
	if (origin && origin !== expectedRequestOrigin(request, url, true)) {
		throw new AppError('CROSS_ORIGIN_REQUEST', 'Cross-origin changes are not allowed.', 403);
	}
}

async function readLinkedSubjectReference(): Promise<string | null> {
	const rows = await cloudQuery<MetadataRow>(
		`SELECT value FROM public.carddue_metadata WHERE key = $1`,
		[GOOGLE_LINK_METADATA_KEY]
	);
	return rows.length === 1 && isCanonicalOpaqueToken(rows[0].value) ? rows[0].value : null;
}

async function readBootstrapClaimReference(): Promise<string | null> {
	const rows = await cloudQuery<MetadataRow>(
		`SELECT value FROM public.carddue_metadata WHERE key = $1`,
		[GOOGLE_BOOTSTRAP_CLAIM_METADATA_KEY]
	);
	if (rows.length !== 1 || !rows[0].value.startsWith(ACTIVE_BOOTSTRAP_CLAIM_PREFIX)) {
		return null;
	}
	const reference = rows[0].value.slice(ACTIVE_BOOTSTRAP_CLAIM_PREFIX.length);
	return isCanonicalOpaqueToken(reference) ? reference : null;
}

async function requireCurrentBootstrapClaim(expectedClaimReference: string): Promise<void> {
	const current = currentBootstrapClaimReference();
	const stored = await readBootstrapClaimReference();
	if (
		!secretsEqual(current, expectedClaimReference) ||
		!stored ||
		!secretsEqual(stored, expectedClaimReference)
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
}

async function requireMatchingLinkedSubject(subjectReference: string): Promise<void> {
	const linked = await readLinkedSubjectReference();
	if (!linked || !secretsEqual(linked, subjectReference)) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
}

async function linkSubject(subjectReference: string): Promise<void> {
	const rows = await cloudQuery<MetadataRow>(
		`INSERT INTO public.carddue_metadata AS linked_identity (key, value)
		 VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = linked_identity.value
		 WHERE linked_identity.value = EXCLUDED.value
		 RETURNING value`,
		[GOOGLE_LINK_METADATA_KEY, subjectReference]
	);
	if (
		rows.length !== 1 ||
		typeof rows[0].value !== 'string' ||
		!secretsEqual(rows[0].value, subjectReference)
	) {
		throw new AppError(
			'GOOGLE_LINK_CONFLICT',
			'A different Google identity is already linked.',
			409
		);
	}
}

async function claimBootstrap(claimReference: string): Promise<void> {
	const activeClaim = activeBootstrapClaimValue(claimReference);
	const rows = await cloudQuery<MetadataRow>(
		`INSERT INTO public.carddue_metadata AS bootstrap_claim (key, value)
		 SELECT $1, $2
		 WHERE NOT EXISTS (
		   SELECT 1 FROM public.carddue_metadata WHERE key = $3
		 )
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
		 WHERE bootstrap_claim.value LIKE 'active:v1:%'
		   AND bootstrap_claim.value <> EXCLUDED.value
		   AND NOT EXISTS (
		     SELECT 1 FROM public.carddue_metadata WHERE key = $3
		   )
		 RETURNING value`,
		[GOOGLE_BOOTSTRAP_CLAIM_METADATA_KEY, activeClaim, GOOGLE_LINK_METADATA_KEY]
	);
	if (
		rows.length !== 1 ||
		typeof rows[0].value !== 'string' ||
		!secretsEqual(rows[0].value, activeClaim)
	) {
		throw new AppError('GOOGLE_BOOTSTRAP_FAILED', 'Google setup could not be started.', 401);
	}
}

async function bootstrapSubject(subjectReference: string, claimReference: string): Promise<void> {
	const rows = await cloudQuery<MetadataRow>(
		`WITH consumed_claim AS (
		   UPDATE public.carddue_metadata
		   SET value = $5
		   WHERE key = $3 AND value = $4
		   RETURNING value
		 ), inserted_identity AS (
		   INSERT INTO public.carddue_metadata (key, value)
		   SELECT $1, $2 FROM consumed_claim
		   ON CONFLICT (key) DO NOTHING
		   RETURNING value
		 )
		 SELECT value FROM inserted_identity`,
		[
			GOOGLE_LINK_METADATA_KEY,
			subjectReference,
			GOOGLE_BOOTSTRAP_CLAIM_METADATA_KEY,
			activeBootstrapClaimValue(claimReference),
			consumedBootstrapClaimValue(claimReference)
		]
	);
	if (
		rows.length !== 1 ||
		typeof rows[0].value !== 'string' ||
		!secretsEqual(rows[0].value, subjectReference)
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
}

async function pruneExpiredTransactions(now: number): Promise<void> {
	await cloudQuery(
		`DELETE FROM public.carddue_auth_rate_limits
		 WHERE attempts = 0 AND blocked_until < $1`,
		[now]
	);
}

async function saveTransaction(transaction: GoogleTransaction, now: number): Promise<void> {
	const rows = await cloudQuery<TransactionRow>(
		`INSERT INTO public.carddue_auth_rate_limits
		 (bucket_ref, window_started_at, attempts, blocked_until, updated_at)
		 VALUES ($1, $2, 0, $3, $2)
		 ON CONFLICT (bucket_ref) DO NOTHING
		 RETURNING bucket_ref`,
		[transactionReference(transaction.transactionToken), now, transaction.expiresAt]
	);
	if (rows.length !== 1) {
		throw new AppError(
			'GOOGLE_AUTH_UNAVAILABLE',
			'Google sign-in is temporarily unavailable.',
			503
		);
	}
}

async function consumeTransaction(transaction: GoogleTransaction, now: number): Promise<void> {
	const rows = await cloudQuery<TransactionRow>(
		`DELETE FROM public.carddue_auth_rate_limits
		 WHERE bucket_ref = $1 AND attempts = 0 AND blocked_until >= $2
		 RETURNING bucket_ref`,
		[transactionReference(transaction.transactionToken), now]
	);
	if (rows.length !== 1) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
}

async function requireActiveTransaction(
	transaction: GoogleTransaction,
	now: number
): Promise<void> {
	const rows = await cloudQuery<TransactionRow>(
		`SELECT bucket_ref FROM public.carddue_auth_rate_limits
		 WHERE bucket_ref = $1 AND attempts = 0 AND blocked_until >= $2`,
		[transactionReference(transaction.transactionToken), now]
	);
	if (rows.length !== 1) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
}

function setTransactionCookie(cookies: Cookies, transaction: GoogleTransaction): void {
	cookies.set(
		GOOGLE_TRANSACTION_COOKIE_NAME,
		encryptJson(transaction, TRANSACTION_COOKIE_PURPOSE),
		{
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: TRANSACTION_TTL_SECONDS
		}
	);
}

export function clearGoogleTransactionCookie(cookies: Cookies): void {
	cookies.delete(GOOGLE_TRANSACTION_COOKIE_NAME, {
		path: '/',
		httpOnly: true,
		secure: true,
		sameSite: 'lax'
	});
}

function readTransactionCookie(cookies: Cookies): GoogleTransaction {
	const envelope = cookies.get(GOOGLE_TRANSACTION_COOKIE_NAME);
	if (!envelope || envelope.length > 2_048) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	const transaction = transactionSchema.parse(
		decryptJson<unknown>(envelope, TRANSACTION_COOKIE_PURPOSE)
	);
	if (
		(transaction.intent === 'link') !== Boolean(transaction.linkSessionToken) ||
		(transaction.intent === 'bootstrap') !== Boolean(transaction.bootstrapClaimRef) ||
		(transaction.intent !== 'bootstrap' && transaction.bootstrapClaimRef !== null) ||
		transaction.expiresAt <= Date.now()
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	return transaction;
}

function authorizationUrl(config: GoogleOidcConfig, transaction: GoogleTransaction): string {
	const challenge = createHash('sha256')
		.update(transaction.codeVerifier, 'ascii')
		.digest('base64url');
	const authorization = new URL(GOOGLE_AUTHORIZATION_URL);
	authorization.searchParams.set('client_id', config.clientId);
	authorization.searchParams.set('redirect_uri', transaction.redirectUri);
	authorization.searchParams.set('response_type', 'code');
	authorization.searchParams.set('scope', 'openid');
	authorization.searchParams.set('access_type', 'online');
	authorization.searchParams.set('state', transaction.state);
	authorization.searchParams.set('nonce', transaction.nonce);
	authorization.searchParams.set('code_challenge', challenge);
	authorization.searchParams.set('code_challenge_method', 'S256');
	if (transaction.intent === 'link' || transaction.intent === 'bootstrap') {
		authorization.searchParams.set('prompt', 'select_account');
	}
	return authorization.toString();
}

export async function getGoogleAuthStatus(authenticated: boolean): Promise<{
	configured: boolean;
	linked: boolean | null;
	bootstrapAvailable: boolean;
}> {
	if (getRuntimeMode() !== 'cloud') {
		return { configured: false, linked: false, bootstrapAvailable: false };
	}
	const runtimeConfig = getCloudRuntimeConfig();
	const configured = Boolean(runtimeConfig.googleOidc);
	const bootstrapAvailable =
		runtimeConfig.authMode === 'google' && Boolean(runtimeConfig.googleBootstrapHash);
	if (!authenticated) return { configured, linked: null, bootstrapAvailable };
	return {
		configured,
		linked: configured && Boolean(await readLinkedSubjectReference()),
		bootstrapAvailable
	};
}

export async function beginGoogleOidc(
	request: Request,
	url: URL,
	cookies: Cookies,
	intent: GoogleOidcIntent
): Promise<string> {
	const config = googleConfig();
	const runtimeConfig = getCloudRuntimeConfig();
	assertStartRequestOrigin(request, url);
	const redirectUri = callbackUri(request, url);
	let linkSessionToken: string | null = null;

	if (intent === 'link') {
		if (runtimeConfig.authMode !== 'password') {
			throw new AppError('GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not available.', 409);
		}
		linkSessionToken = cookies.get(SESSION_COOKIE_NAME) ?? null;
		if (!(await authenticateSession(linkSessionToken ?? undefined))) {
			throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
		}
	}

	await consumeGoogleOidcStartRateLimit(request, intent);
	if (intent === 'login' && !(await readLinkedSubjectReference())) {
		throw new AppError('GOOGLE_NOT_LINKED', 'Google sign-in has not been linked.', 409);
	}

	const now = Date.now();
	await pruneExpiredTransactions(now);
	const transaction: GoogleTransaction = {
		version: 2,
		transactionToken: randomOpaqueToken(),
		intent,
		state: randomOpaqueToken(),
		nonce: randomOpaqueToken(),
		codeVerifier: randomOpaqueToken(),
		redirectUri,
		expiresAt: now + TRANSACTION_TTL_SECONDS * 1000,
		linkSessionToken,
		bootstrapClaimRef: null
	};
	await saveTransaction(transaction, now);
	setTransactionCookie(cookies, transaction);
	return authorizationUrl(config, transaction);
}

export async function beginGoogleOidcBootstrap(
	request: Request,
	url: URL,
	cookies: Cookies,
	setupToken: string
): Promise<typeof GOOGLE_BOOTSTRAP_CONTINUE_PATH> {
	googleConfig();
	if (getCloudRuntimeConfig().authMode !== 'google') {
		throw new AppError('GOOGLE_BOOTSTRAP_FAILED', 'Google setup could not be started.', 401);
	}
	assertStartRequestOrigin(request, url);
	const redirectUri = callbackUri(request, url);
	const claimReference = verifyBootstrapToken(setupToken);
	await consumeGoogleOidcBootstrapRateLimit(request);
	await claimBootstrap(claimReference);

	const now = Date.now();
	await pruneExpiredTransactions(now);
	const transaction: GoogleTransaction = {
		version: 2,
		transactionToken: randomOpaqueToken(),
		intent: 'bootstrap',
		state: randomOpaqueToken(),
		nonce: randomOpaqueToken(),
		codeVerifier: randomOpaqueToken(),
		redirectUri,
		expiresAt: now + TRANSACTION_TTL_SECONDS * 1000,
		linkSessionToken: null,
		bootstrapClaimRef: claimReference
	};
	await saveTransaction(transaction, now);
	setTransactionCookie(cookies, transaction);
	return GOOGLE_BOOTSTRAP_CONTINUE_PATH;
}

export async function continueGoogleOidcBootstrap(
	request: Request,
	url: URL,
	cookies: Cookies
): Promise<string> {
	const config = googleConfig();
	if (getCloudRuntimeConfig().authMode !== 'google') {
		throw new AppError('GOOGLE_AUTH_UNAVAILABLE', 'Google sign-in is not available.', 409);
	}
	assertStartRequestOrigin(request, url);
	const transaction = readTransactionCookie(cookies);
	if (
		transaction.intent !== 'bootstrap' ||
		!transaction.bootstrapClaimRef ||
		!secretsEqual(callbackUri(request, url), transaction.redirectUri)
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	await requireCurrentBootstrapClaim(transaction.bootstrapClaimRef);
	await requireActiveTransaction(transaction, Date.now());
	return authorizationUrl(config, transaction);
}

function exactQueryParameter(url: URL, name: string): string | null {
	const values = url.searchParams.getAll(name);
	return values.length === 1 ? values[0] : null;
}

function hasAsciiControl(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x1f || code === 0x7f;
	});
}

function validateCallbackQuery(
	url: URL,
	transaction: GoogleTransaction
): {
	code: string | null;
	providerError: boolean;
} {
	if (Buffer.byteLength(url.search, 'utf8') > MAX_CALLBACK_QUERY_BYTES) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	const state = exactQueryParameter(url, 'state');
	const responseIssuer = exactQueryParameter(url, 'iss');
	if (
		!state ||
		!OPAQUE_TOKEN_PATTERN.test(state) ||
		!secretsEqual(state, transaction.state) ||
		responseIssuer !== GOOGLE_ISSUER
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}

	const codes = url.searchParams.getAll('code');
	const errors = url.searchParams.getAll('error');
	const hasCode = codes.length === 1;
	const hasError = errors.length === 1;
	if (
		hasCode === hasError ||
		(hasCode && codes[0].length === 0) ||
		(hasError && errors[0].length === 0) ||
		(hasCode && (codes[0].length > 4_096 || hasAsciiControl(codes[0]))) ||
		(hasError && errors[0].length > 256)
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	return { code: hasCode ? codes[0] : null, providerError: hasError };
}

async function readBoundedText(response: Response): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length') ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_RESPONSE_BYTES) {
		throw new Error('oversized token response');
	}
	if (!response.body) throw new Error('missing token response');

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_TOKEN_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error('oversized token response');
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

async function exchangeCode(
	config: GoogleOidcConfig,
	code: string,
	transaction: GoogleTransaction
): Promise<string> {
	const body = new URLSearchParams({
		client_id: config.clientId,
		client_secret: config.clientSecret,
		code,
		code_verifier: transaction.codeVerifier,
		grant_type: 'authorization_code',
		redirect_uri: transaction.redirectUri
	});
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
	try {
		const response = await tokenFetch(GOOGLE_TOKEN_URL, {
			method: 'POST',
			headers: {
				accept: 'application/json',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body,
			redirect: 'error',
			signal: controller.signal
		});
		if (
			!response.ok ||
			!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')
		) {
			throw new Error('token exchange failed');
		}
		const payload = JSON.parse(await readBoundedText(response)) as unknown;
		const idToken =
			typeof payload === 'object' && payload !== null && 'id_token' in payload
				? (payload as { id_token?: unknown }).id_token
				: undefined;
		if (
			typeof idToken !== 'string' ||
			idToken.length === 0 ||
			Buffer.byteLength(idToken, 'utf8') > MAX_ID_TOKEN_BYTES
		) {
			throw new Error('missing ID token');
		}
		return idToken;
	} finally {
		clearTimeout(timeout);
	}
}

export async function verifyGoogleIdToken(
	idToken: string,
	clientId: string,
	expectedNonce: string
): Promise<string> {
	const { payload, protectedHeader } = await jwtVerify(idToken, googleKeyResolver, {
		algorithms: ['RS256'],
		issuer: [GOOGLE_ISSUER, GOOGLE_BARE_ISSUER],
		audience: clientId,
		requiredClaims: ['iss', 'aud', 'exp', 'iat', 'sub', 'nonce'],
		clockTolerance: 5,
		maxTokenAge: '10 minutes'
	});
	if (
		protectedHeader.alg !== 'RS256' ||
		!Number.isSafeInteger(payload.exp) ||
		!Number.isSafeInteger(payload.iat) ||
		typeof payload.nonce !== 'string' ||
		!secretsEqual(payload.nonce, expectedNonce)
	) {
		throw new Error('invalid Google ID token');
	}
	const audience = payload.aud;
	if (
		(payload.azp !== undefined && payload.azp !== clientId) ||
		(Array.isArray(audience) && audience.length > 1 && payload.azp !== clientId)
	) {
		throw new Error('invalid Google authorized party');
	}
	return googleSubjectReference(payload.iss, payload.sub);
}

export async function completeGoogleOidc(
	request: Request,
	url: URL,
	cookies: Cookies
): Promise<
	{ outcome: 'login'; sessionToken: string } | { outcome: 'linked'; sessionToken?: string }
> {
	const config = googleConfig();
	const runtimeConfig = getCloudRuntimeConfig();
	const transaction = readTransactionCookie(cookies);
	if (
		(transaction.intent === 'link' && runtimeConfig.authMode !== 'password') ||
		(transaction.intent === 'bootstrap' && runtimeConfig.authMode !== 'google')
	) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	const currentCallbackUri = callbackUri(request, url);
	if (!secretsEqual(currentCallbackUri, transaction.redirectUri)) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}
	const callback = validateCallbackQuery(url, transaction);
	if (transaction.intent === 'bootstrap') {
		if (!transaction.bootstrapClaimRef) {
			throw new AppError(
				'GOOGLE_AUTH_FAILED',
				'Google authentication could not be completed.',
				401
			);
		}
		await requireCurrentBootstrapClaim(transaction.bootstrapClaimRef);
	}
	const now = Date.now();
	await consumeTransaction(transaction, now);
	if (callback.providerError || !callback.code) {
		throw new AppError('GOOGLE_AUTH_FAILED', 'Google authentication could not be completed.', 401);
	}

	if (
		transaction.intent === 'link' &&
		!(await authenticateSession(transaction.linkSessionToken ?? undefined))
	) {
		throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
	}
	const idToken = await exchangeCode(config, callback.code, transaction);
	const subjectReference = await verifyGoogleIdToken(idToken, config.clientId, transaction.nonce);

	if (transaction.intent === 'link') {
		if (!(await authenticateSession(transaction.linkSessionToken ?? undefined))) {
			throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
		}
		await linkSubject(subjectReference);
		return { outcome: 'linked' };
	}
	if (transaction.intent === 'bootstrap') {
		if (!transaction.bootstrapClaimRef) {
			throw new AppError(
				'GOOGLE_AUTH_FAILED',
				'Google authentication could not be completed.',
				401
			);
		}
		await requireCurrentBootstrapClaim(transaction.bootstrapClaimRef);
		await bootstrapSubject(subjectReference, transaction.bootstrapClaimRef);
		return { outcome: 'linked', sessionToken: await issueGoogleOidcSession() };
	}

	await requireMatchingLinkedSubject(subjectReference);
	return { outcome: 'login', sessionToken: await issueGoogleOidcSession() };
}

export function resetGoogleOidcStateForTests(): void {
	googleKeyResolver = remoteGoogleKeySet;
	tokenFetch = (...arguments_) => globalThis.fetch(...arguments_);
}

export function setGoogleOidcDependenciesForTests(options: {
	keyResolver?: Parameters<typeof jwtVerify>[1];
	fetch?: typeof globalThis.fetch;
}): void {
	if (options.keyResolver) googleKeyResolver = options.keyResolver;
	if (options.fetch) tokenFetch = options.fetch;
}
