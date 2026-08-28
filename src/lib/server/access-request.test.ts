import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../../routes/api/access-request/+server';
import { adminAccessRequestLocation } from './access-request';

const previousAdminEmail = process.env.CARDDUE_ADMIN_EMAIL;

afterEach(() => {
	if (previousAdminEmail === undefined) delete process.env.CARDDUE_ADMIN_EMAIL;
	else process.env.CARDDUE_ADMIN_EMAIL = previousAdminEmail;
});

describe('admin access requests', () => {
	it('creates a pre-addressed request without exposing the recipient in client source', () => {
		const recipient = ['owner', 'example.test'].join('@');
		const location = adminAccessRequestLocation(`  ${recipient}  `);
		expect(location).toContain(`mailto:${recipient}?`);
		expect(decodeURIComponent(location)).toContain('subject=ChipDue+access+request');
		expect(decodeURIComponent(location)).toContain('Google+account+to+invite:');
	});

	it.each([undefined, '', 'not-an-address', 'owner@localhost'])(
		'rejects a missing or invalid recipient (%s)',
		(value) => {
			expect(() => adminAccessRequestLocation(value)).toThrow(
				'Admin access requests are not configured.'
			);
		}
	);

	it('redirects from the public endpoint to the configured email request', async () => {
		const recipient = ['admin', 'example.test'].join('@');
		process.env.CARDDUE_ADMIN_EMAIL = recipient;
		const response = await GET({} as never);
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toContain(`mailto:${recipient}?`);
		expect(response.headers.get('cache-control')).toContain('no-store');
	});

	it('fails closed when the deployment recipient is absent', async () => {
		delete process.env.CARDDUE_ADMIN_EMAIL;
		const response = await GET({} as never);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: 'ACCESS_REQUEST_UNAVAILABLE',
				message: 'Admin access requests are not configured.'
			}
		});
	});
});
