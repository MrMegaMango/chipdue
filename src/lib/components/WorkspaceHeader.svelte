<script lang="ts">
	import { asset, resolve } from '$app/paths';

	type WorkspaceSection = 'overview' | 'cards' | 'accounts' | 'bonuses' | 'settings';
	type Props = {
		current: WorkspaceSection;
		mode: 'local' | 'cloud' | null;
		loggingOut?: boolean;
		onlogout?: () => void;
	};

	let { current, mode, loggingOut = false, onlogout }: Props = $props();

	const links: {
		id: WorkspaceSection;
		label: string;
		href: '/' | '/cards' | '/accounts' | '/bonuses';
	}[] = [
		{ id: 'overview', label: 'Overview', href: '/' },
		{ id: 'cards', label: 'Cards', href: '/cards' },
		{ id: 'accounts', label: 'Accounts', href: '/accounts' },
		{ id: 'bonuses', label: 'Bonuses', href: '/bonuses' }
	];
</script>

<header class="workspace-header">
	<a class="workspace-brand" href={resolve('/')} aria-label="ChipDue overview">
		<span class="brand-mark" aria-hidden="true">
			<img src={asset('/logo-mark.svg')} alt="" />
		</span>
		<span class="brand-copy">
			<strong>ChipDue</strong>
			<small>Private finance</small>
		</span>
	</a>

	<nav class="workspace-navigation" aria-label="Financial workspace">
		{#each links as link (link.id)}
			<a href={resolve(link.href)} aria-current={current === link.id ? 'page' : undefined}>
				{link.label}
			</a>
		{/each}
	</nav>

	<div class="header-controls">
		<a
			class="settings-link"
			href={resolve('/settings')}
			aria-label="Settings"
			aria-current={current === 'settings' ? 'page' : undefined}
		>
			<svg aria-hidden="true" viewBox="0 0 20 20">
				<circle cx="10" cy="10" r="2.6"></circle>
				<path
					d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4"
				></path>
			</svg>
			<span>Settings</span>
		</a>
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
		grid-template-columns: 1fr minmax(360px, 520px) 1fr;
		gap: 1.5rem;
		align-items: start;
		min-height: 78px;
		border-bottom: 1px solid rgba(187, 180, 168, 0.55);
	}

	.workspace-brand {
		display: inline-flex;
		gap: 0.65rem;
		align-items: center;
		justify-self: start;
		margin-top: 20px;
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

	.workspace-navigation {
		display: flex;
		width: 100%;
		overflow: hidden;
		margin: 15px 0;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: rgba(255, 253, 249, 0.82);
		box-shadow: var(--shadow-sm);
	}

	.workspace-navigation a {
		display: flex;
		min-width: 0;
		min-height: 47px;
		flex: 1 1 0;
		align-items: center;
		justify-content: center;
		padding: 0.55rem 0.45rem;
		border-right: 1px solid var(--line);
		color: var(--muted);
		font-size: clamp(0.65rem, 2.2vw, 0.68rem);
		font-weight: 720;
		text-decoration: none;
		transition:
			flex 150ms ease,
			color 120ms ease,
			background 120ms ease;
	}

	.workspace-navigation a:last-child {
		border-right: 0;
	}

	.workspace-navigation a:hover {
		color: var(--ink);
		background: var(--paper);
	}

	.workspace-navigation a:focus-visible {
		outline-offset: -3px;
	}

	.workspace-navigation a[aria-current='page'] {
		flex: 1.2 1 0;
		color: var(--accent-dark);
		background: var(--accent-soft);
		box-shadow: inset 0 -3px 0 var(--accent);
	}

	.workspace-navigation a[aria-current='page']::before {
		width: 6px;
		height: 6px;
		margin-right: 0.36rem;
		border-radius: 50%;
		background: var(--accent);
		content: '';
	}

	.header-controls {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		justify-self: end;
		margin-top: 20px;
	}

	.settings-link {
		display: inline-flex;
		min-height: 34px;
		gap: 0.4rem;
		align-items: center;
		padding: 0.4rem 0.6rem;
		border: 1px solid transparent;
		border-radius: 8px;
		color: var(--muted);
		font-size: 0.68rem;
		font-weight: 700;
		text-decoration: none;
	}

	.settings-link:hover,
	.settings-link[aria-current='page'] {
		border-color: var(--line);
		color: var(--ink);
		background: rgba(255, 255, 255, 0.65);
	}

	.settings-link svg {
		width: 15px;
		height: 15px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
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
			gap: 0 1rem;
			padding-bottom: 0.75rem;
		}

		.workspace-navigation {
			grid-column: 1 / -1;
			grid-row: 2;
			margin: 12px 0 0;
		}
	}

	@media (max-width: 480px) {
		.brand-copy small {
			display: none;
		}

		.settings-link span {
			display: none;
		}
	}
</style>
