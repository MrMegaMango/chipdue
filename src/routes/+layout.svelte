<script lang="ts">
	import { asset } from '$app/paths';
	import './layout.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>CardDue — Credit card due dates, kept private</title>
	<meta
		name="description"
		content="A private, local-first dashboard for credit card statement balances and due dates."
	/>
	<meta name="theme-color" content="#f7f6f1" />
	<link rel="icon" href={asset('/favicon.svg')} />
</svelte:head>

{@render children()}
