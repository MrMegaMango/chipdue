import { readable } from 'svelte/store';

export type TimestampAction = 'Checked' | 'Synced' | 'Updated';

export const currentTime = readable(Date.now(), (set) => {
	if (typeof window === 'undefined') return;

	const update = (): void => set(Date.now());
	update();
	const timer = window.setInterval(update, 30_000);
	return () => window.clearInterval(timer);
});

export function relativeTimestampLabel(
	value: string | null | undefined,
	now: number,
	action: TimestampAction = 'Synced',
	fallback?: string
): string {
	if (!value) return fallback ?? `${action} time unavailable`;
	const timestamp = new Date(value).getTime();
	if (!Number.isFinite(timestamp)) return fallback ?? `${action} time unavailable`;

	const elapsed = Math.max(0, now - timestamp);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return `${action} just now`;
	if (minutes < 60) return `${action} ${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${action} ${hours}h ago`;
	return `${action} ${Math.floor(hours / 24)}d ago`;
}

export function exactTimestampLabel(
	value: string | null | undefined,
	action: TimestampAction = 'Synced'
): string | null {
	if (!value) return null;
	const timestamp = new Date(value);
	if (!Number.isFinite(timestamp.getTime())) return null;

	const exact = new Intl.DateTimeFormat('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short'
	}).format(timestamp);
	return `${action} ${exact}`;
}
