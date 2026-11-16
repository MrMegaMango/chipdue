import type { RequestHandler } from './$types';
import { z } from 'zod';
import { loginWithPassword, setSessionCookie } from '#lib/server/auth.ts';
import { apiError, apiJson, assertSameOrigin, noContent, readJson } from '#lib/server/http.ts';
import { getRuntimeAuthMode } from '#lib/server/runtime.ts';

const loginSchema = z.object({ password: z.string().min(1).max(1024) }).strict();

export const POST: RequestHandler = async ({ cookies, request, url }) => {
	try {
		if (getRuntimeAuthMode() === 'google') {
			return apiJson(
				{ error: { code: 'NOT_FOUND', message: 'The requested endpoint is unavailable.' } },
				404
			);
		}
		assertSameOrigin(request, url);
		const { password } = await readJson(request, loginSchema);
		setSessionCookie(cookies, await loginWithPassword(request, password));
		return noContent();
	} catch (error) {
		return apiError(error);
	}
};
