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

	const currentLabel = $derived(
		current === 'settings'
			? 'Settings'
			: (links.find((link) => link.id === current)?.label ?? 'Workspace')
	);
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

	<details class="workspace-navigation">
		<summary aria-label={`Workspace navigation. Current section: ${currentLabel}.`}>
			<span class="current-section">
				<span class="current-indicator" aria-hidden="true"></span>
				<span>
					<small>Current section</small>
					<strong>{currentLabel}</strong>
				</span>
			</span>
			<span class="navigation-action" aria-hidden="true">
				<span>Browse</span>
				<svg viewBox="0 0 16 16">
					<path d="m4 6 4 4 4-4"></path>
				</svg>
			</span>
		</summary>

		<nav aria-label="Financial workspace">
			{#each links as link (link.id)}
				<a href={resolve(link.href)} aria-current={current === link.id ? 'page' : undefined}>
					<span>{link.label}</span>
					{#if current === link.id}
						<small>Current</small>
					{:else}
						<svg aria-hidden="true" viewBox="0 0 16 16">
							<path d="m6 3 5 5-5 5"></path>
						</svg>
					{/if}
				</a>
			{/each}
		</nav>
	</details>

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
		grid-template-columns: 1fr minmax(260px, 380px) 1fr;
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
		width: 100%;
		margin: 15px 0;
	}

	.workspace-navigation summary {
		display: flex;
		min-height: 47px;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0.72rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: rgba(255, 253, 249, 0.82);
		box-shadow: var(--shadow-sm);
		cursor: pointer;
		list-style: none;
		transition:
			border-color 120ms ease,
			background 120ms ease;
	}

	.workspace-navigation summary::-webkit-details-marker {
		display: none;
	}

	.workspace-navigation summary:hover {
		border-color: var(--line-strong);
		background: var(--paper);
	}

	.current-section {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
	}

	.current-section > span:last-child {
		display: grid;
		gap: 0.08rem;
		min-width: 0;
	}

	.current-indicator {
		width: 8px;
		height: 8px;
		flex: 0 0 auto;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 4px var(--accent-soft);
	}

	.current-section small {
		color: var(--faint);
		font-size: 0.54rem;
		font-weight: 720;
		letter-spacing: 0.08em;
		line-height: 1.1;
		text-transform: uppercase;
	}

	.current-section strong {
		overflow: hidden;
		color: var(--ink-soft);
		font-size: 0.76rem;
		font-weight: 760;
		line-height: 1.15;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.navigation-action {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		color: var(--muted);
		font-size: 0.62rem;
		font-weight: 700;
	}

	.navigation-action svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
		transition: transform 150ms ease;
	}

	.workspace-navigation[open] .navigation-action svg {
		transform: rotate(180deg);
	}

	nav {
		display: grid;
		overflow: hidden;
		margin-top: 0.45rem;
	}

	nav a {
		display: flex;
		min-height: 45px;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.65rem 0.78rem;
		border: 1px solid var(--line);
		border-bottom: 0;
		color: var(--muted);
		font-size: 0.7rem;
		font-weight: 720;
		background: rgba(255, 253, 249, 0.72);
		text-decoration: none;
		transition:
			color 120ms ease,
			background 120ms ease,
			padding 120ms ease;
	}

	nav a:first-child {
		border-radius: 10px 10px 0 0;
	}

	nav a:last-child {
		border-bottom: 1px solid var(--line);
		border-radius: 0 0 10px 10px;
	}

	nav a:hover {
		color: var(--ink);
		background: var(--paper);
		padding-left: 0.95rem;
	}

	nav a[aria-current='page'] {
		color: var(--accent-dark);
		background: var(--accent-soft);
		box-shadow: inset 3px 0 0 var(--accent);
	}

	nav a small {
		color: var(--accent-dark);
		font-size: 0.54rem;
		font-weight: 760;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	nav a svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
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

		.navigation-action > span {
			display: none;
		}

		.settings-link span {
			display: none;
		}
	}
</style>
