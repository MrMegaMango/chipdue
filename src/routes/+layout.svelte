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
	<link rel="icon" href={asset('/logo-mark.svg')} type="image/svg+xml" />
</svelte:head>

{@render children()}
