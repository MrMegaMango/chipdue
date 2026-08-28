import { AppError } from './errors';

const EMAIL_PATTERN =
	/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function adminAccessRequestLocation(
	configuredEmail = process.env.CARDDUE_ADMIN_EMAIL
): string {
	const email = configuredEmail?.trim();
	if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
		throw new AppError(
			'ACCESS_REQUEST_UNAVAILABLE',
			'Admin access requests are not configured.',
			503
		);
	}
	const query = new URLSearchParams({
		subject: 'ChipDue access request',
		body: "Hi,\n\nI'd like to request access to ChipDue.\n\nGoogle account to invite: \n\nThanks."
	});
	return `mailto:${email}?${query.toString()}`;
}
