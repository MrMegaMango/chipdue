<script lang="ts">
	import { asset, resolve } from '$app/paths';

	type WorkspaceSection = 'dashboard' | 'accounts' | 'bonuses';
	type Props = {
		current: WorkspaceSection;
		mode: 'local' | 'cloud' | null;
		loggingOut?: boolean;
		onlogout?: () => void;
	};

	let { current, mode, loggingOut = false, onlogout }: Props = $props();

	const links: { id: WorkspaceSection; label: string; href: '/' | '/accounts' | '/bonuses' }[] = [
		{ id: 'dashboard', label: 'Dashboard', href: '/' },
		{ id: 'accounts', label: 'Accounts', href: '/accounts' },
		{ id: 'bonuses', label: 'Bonuses', href: '/bonuses' }
	];
</script>

<header class="workspace-header">
	<a class="workspace-brand" href={resolve('/')} aria-label="ChipDue dashboard">
		<span class="brand-mark" aria-hidden="true">
			<img src={asset('/logo-mark.svg')} alt="" />
		</span>
		<span class="brand-copy">
			<strong>ChipDue</strong>
			<small>Private finance</small>
		</span>
	</a>

	<nav aria-label="Financial workspace">
		{#each links as link (link.id)}
			<a href={resolve(link.href)} aria-current={current === link.id ? 'page' : undefined}>
				{link.label}
			</a>
		{/each}
	</nav>

	<div class="header-controls">
		{#if mode === 'cloud' && onlogout}
			<button type="button" onclick={onlogout} disabled={loggingOut}>
				{loggingOut ? 'Logging out…' : 'Log out'}
			</button>
		{/if}
	</div>
</header>

<style>
	.workspace-header {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 1.5rem;
		align-items: center;
		min-height: 78px;
		border-bottom: 1px solid rgba(187, 180, 168, 0.55);
	}

	.workspace-brand {
		display: inline-flex;
		gap: 0.65rem;
		align-items: center;
		justify-self: start;
		color: var(--ink);
		text-decoration: none;
	}

	.brand-mark {
		display: block;
		width: 38px;
		height: 38px;
		filter: drop-shadow(3px 3px 0 rgba(39, 58, 165, 0.24));
	}

	.brand-mark img {
		display: block;
		width: 100%;
		height: 100%;
	}

	.brand-copy {
		display: grid;
		line-height: 1.05;
	}

	.brand-copy strong {
		font-size: 1.08rem;
		font-weight: 790;
		letter-spacing: -0.035em;
	}

	.brand-copy small {
		margin-top: 0.25rem;
		color: var(--faint);
		font-size: 0.58rem;
		font-weight: 680;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	nav {
		display: flex;
		gap: 0.25rem;
		align-items: center;
		padding: 0.24rem;
		border: 1px solid var(--line);
		border-radius: 11px;
		background: rgba(255, 253, 249, 0.72);
	}

	nav a {
		padding: 0.48rem 0.72rem;
		border-radius: 8px;
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 720;
		text-decoration: none;
		transition:
			color 120ms ease,
			background 120ms ease;
	}

	nav a:hover {
		color: var(--ink);
		background: var(--paper-soft);
	}

	nav a[aria-current='page'] {
		color: white;
		background: var(--ink-soft);
		box-shadow: 2px 2px 0 rgba(17, 24, 39, 0.18);
	}

	.header-controls {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		justify-self: end;
	}

	button {
		min-height: 34px;
		padding: 0.4rem 0.65rem;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 700;
		background: rgba(255, 255, 255, 0.65);
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		color: var(--red);
		border-color: #d7aaa6;
		background: white;
	}

	button:disabled {
		cursor: wait;
		opacity: 0.6;
	}

	@media (max-width: 820px) {
		.workspace-header {
			grid-template-columns: 1fr auto;
			padding: 0.75rem 0;
		}

		nav {
			grid-column: 1 / -1;
			grid-row: 2;
			justify-content: center;
			order: 3;
		}
	}

	@media (max-width: 480px) {
		.brand-copy small {
			display: none;
		}

		nav {
			display: grid;
			width: 100%;
			grid-template-columns: repeat(3, 1fr);
		}

		nav a {
			text-align: center;
		}
	}
</style>
