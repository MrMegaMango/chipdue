import { timingSafeEqual } from 'node:crypto';
import { cloudQuery } from './cloud-database';
import { AppError } from './errors';

export type ScheduledSyncPeriod = 'morning' | 'evening';
export type ScheduledSyncCandidate = 'morning-pdt' | 'morning-pst' | 'evening-pdt' | 'evening-pst';

export type ScheduledSyncWindow = {
	period: ScheduledSyncPeriod;
	localDate: string;
};

const PACIFIC_TIME_ZONE = 'America/Los_Angeles';
const CRON_SECRET_MINIMUM_LENGTH = 16;
const CRON_SECRET_MAXIMUM_LENGTH = 512;
const CANDIDATES: Record<
	ScheduledSyncCandidate,
	{ period: ScheduledSyncPeriod; localHour: number }
> = {
	'morning-pdt': { period: 'morning', localHour: 8 },
	'morning-pst': { period: 'morning', localHour: 8 },
	'evening-pdt': { period: 'evening', localHour: 17 },
	'evening-pst': { period: 'evening', localHour: 17 }
};

const pacificParts = new Intl.DateTimeFormat('en-US', {
	timeZone: PACIFIC_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	hourCycle: 'h23'
});

function fixedPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
	return parts.find((part) => part.type === type)?.value ?? '';
}

export function scheduledSyncWindow(
	candidate: string,
	now = new Date()
): ScheduledSyncWindow | null {
	if (!Object.hasOwn(CANDIDATES, candidate) || !Number.isFinite(now.getTime())) return null;
	const configuration = CANDIDATES[candidate as ScheduledSyncCandidate];

	const parts = pacificParts.formatToParts(now);
	const year = fixedPart(parts, 'year');
	const month = fixedPart(parts, 'month');
	const day = fixedPart(parts, 'day');
	const hour = Number(fixedPart(parts, 'hour'));
	if (!year || !month || !day || hour < configuration.localHour) return null;

	return {
		period: configuration.period,
		localDate: `${year}-${month}-${day}`
	};
}

export function assertScheduledSyncRequest(
	request: Request,
	expectedSecret = process.env.CRON_SECRET
): void {
	if (
		!expectedSecret ||
		expectedSecret.length < CRON_SECRET_MINIMUM_LENGTH ||
		expectedSecret.length > CRON_SECRET_MAXIMUM_LENGTH ||
		/\s/.test(expectedSecret)
	) {
		throw new AppError(
			'SCHEDULED_SYNC_MISCONFIGURED',
			'Scheduled synchronization is unavailable.',
			503
		);
	}
	if (request.headers.get('user-agent') !== 'vercel-cron/1.0') {
		throw new AppError('NOT_FOUND', 'The requested endpoint is unavailable.', 404);
	}

	const authorization = request.headers.get('authorization') ?? '';
	const expected = Buffer.from(`Bearer ${expectedSecret}`, 'utf8');
	const actual = Buffer.from(authorization, 'utf8');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
		throw new AppError('AUTH_REQUIRED', 'Authentication is required.', 401);
	}
}

function metadataKey(period: ScheduledSyncPeriod): string {
	return `scheduled_plaid_sync_${period}`;
}

export async function claimScheduledSync(window: ScheduledSyncWindow): Promise<boolean> {
	const key = metadataKey(window.period);
	const running = `${window.localDate}|running`;
	const done = `${window.localDate}|done`;
	const rows = await cloudQuery<{ value: string }>(
		`INSERT INTO public.carddue_metadata (key, value)
		 VALUES ($1, $2)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
		 WHERE public.carddue_metadata.value <> $2
		   AND public.carddue_metadata.value <> $3
		 RETURNING value`,
		[key, running, done]
	);
	return rows.length === 1;
}

export async function completeScheduledSync(window: ScheduledSyncWindow): Promise<void> {
	await setScheduledSyncState(window, 'done');
}

export async function failScheduledSync(window: ScheduledSyncWindow): Promise<void> {
	await setScheduledSyncState(window, 'failed');
}

async function setScheduledSyncState(
	window: ScheduledSyncWindow,
	state: 'done' | 'failed'
): Promise<void> {
	const key = metadataKey(window.period);
	const running = `${window.localDate}|running`;
	await cloudQuery(
		`UPDATE public.carddue_metadata
		 SET value = $1
		 WHERE key = $2 AND value = $3`,
		[`${window.localDate}|${state}`, key, running]
	);
}
