import { json } from '@sveltejs/kit';
import { z, type ZodType } from 'zod';
import { AppError, asAppError } from './errors';
import { expectedRequestOrigin } from './request-security';
import { getRuntimeMode } from './runtime';
import { idSchema } from './schemas';

const JSON_BODY_LIMIT = 64 * 1024;

export const privateResponseHeaders = {
	'cache-control': 'no-store, max-age=0',
	pragma: 'no-cache',
	'x-content-type-options': 'nosniff'
};

export function apiJson(data: unknown, status = 200): Response {
	return json(data, { status, headers: privateResponseHeaders });
}

export function apiError(error: unknown): Response {
	const safeError =
		error instanceof z.ZodError
			? new AppError('INVALID_REQUEST', 'The request is invalid.', 400)
			: asAppError(error);
	return apiJson(
		{
			error: {
				code: safeError.code,
				message: safeError.message
			}
		},
		safeError.status
	);
}

export function assertSameOrigin(request: Request, url: URL): void {
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite === 'cross-site') {
		throw new AppError('CROSS_ORIGIN_REQUEST', 'Cross-origin changes are not allowed.', 403);
	}
	const origin = request.headers.get('origin');
	const cloud = getRuntimeMode() === 'cloud';
	const expectedOrigin = expectedRequestOrigin(request, url, cloud);
	if ((cloud && !origin) || (origin && origin !== expectedOrigin)) {
		throw new AppError('CROSS_ORIGIN_REQUEST', 'Cross-origin changes are not allowed.', 403);
	}
}

export async function readJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
		throw new AppError('INVALID_CONTENT_TYPE', 'A JSON request body is required.', 415);
	}

	const declaredLength = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(declaredLength) && declaredLength > JSON_BODY_LIMIT) {
		throw new AppError('REQUEST_TOO_LARGE', 'The request body is too large.', 413);
	}

	const body = await request.text();
	if (Buffer.byteLength(body, 'utf8') > JSON_BODY_LIMIT) {
		throw new AppError('REQUEST_TOO_LARGE', 'The request body is too large.', 413);
	}

	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new AppError('INVALID_JSON', 'The JSON request body is invalid.', 400);
	}
	return schema.parse(value);
}

export function parseId(value: string): string {
	const result = idSchema.safeParse(value);
	if (!result.success) throw new AppError('INVALID_ID', 'The identifier is invalid.', 400);
	return result.data;
}

export function noContent(): Response {
	return new Response(null, { status: 204, headers: privateResponseHeaders });
}
