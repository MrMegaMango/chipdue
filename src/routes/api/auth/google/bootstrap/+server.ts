import type { RequestHandler } from './$types';
import { z } from 'zod';
import { apiJson, assertSameOrigin, readJson } from '$lib/server/http';
import {
	beginGoogleOidcBootstrap,
	clearGoogleTransactionCookie,
	GOOGLE_BOOTSTRAP_CONTINUE_PATH
} from '$lib/server/google-oidc';
import { getRuntimeAuthMode } from '$lib/server/runtime';

const BOOTSTRAP_BODY_LIMIT = 256;
const bootstrapSchema = z.object({ setupToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	try {
		if (getRuntimeAuthMode() !== 'google') {
			return apiJson(
				{ error: { code: 'NOT_FOUND', message: 'The requested endpoint is unavailable.' } },
				404
			);
		}
		assertSameOrigin(request, url);
		const { setupToken } = await readJson(request, bootstrapSchema, BOOTSTRAP_BODY_LIMIT);
		const continueTo = await beginGoogleOidcBootstrap(request, url, cookies, setupToken);
		if (continueTo !== GOOGLE_BOOTSTRAP_CONTINUE_PATH) throw new Error('invalid continuation');
		return apiJson({ continueTo: GOOGLE_BOOTSTRAP_CONTINUE_PATH });
	} catch {
		clearGoogleTransactionCookie(cookies);
		return apiJson(
			{ error: { code: 'GOOGLE_BOOTSTRAP_FAILED', message: 'Google setup could not be started.' } },
			401
		);
	}
};
