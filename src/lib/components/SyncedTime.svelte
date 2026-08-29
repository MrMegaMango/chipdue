<script lang="ts">
	import {
		currentTime,
		exactTimestampLabel,
		relativeTimestampLabel,
		type TimestampAction
	} from '$lib/sync-time';

	type Props = {
		value: string | null | undefined;
		action?: TimestampAction;
		fallback?: string;
	};

	let { value, action = 'Synced', fallback }: Props = $props();
	const exactLabel = $derived(exactTimestampLabel(value, action));
	const isoTimestamp = $derived(exactLabel && value ? new Date(value).toISOString() : undefined);
	const relativeLabel = $derived(relativeTimestampLabel(value, $currentTime, action, fallback));
</script>

<time
	datetime={isoTimestamp}
	title={exactLabel ?? undefined}
	aria-label={exactLabel ?? relativeLabel}
>
	{relativeLabel}
</time>

<style>
	time[title] {
		cursor: help;
		text-decoration: underline dotted color-mix(in srgb, currentColor 45%, transparent);
		text-decoration-thickness: 1px;
		text-underline-offset: 0.2em;
	}
</style>
