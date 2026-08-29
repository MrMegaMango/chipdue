<script lang="ts">
	import { asset } from '$app/paths';
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>ChipDue — Your private financial command center</title>
	<meta
		name="description"
		content="A private, local-first dashboard for financial accounts, signup bonuses, brokerage performance, and credit-card deadlines."
	/>
	<meta name="theme-color" content="#f7f6f1" />
	<meta name="application-name" content="ChipDue" />
	<meta name="apple-mobile-web-app-title" content="ChipDue" />
	<link rel="apple-touch-icon" sizes="180x180" href={asset('/apple-touch-icon.png')} />
	<link rel="manifest" href={asset('/manifest.webmanifest')} />
	<link rel="icon" href={asset('/logo-mark.svg')} type="image/svg+xml" />
</svelte:head>

{@render children()}
