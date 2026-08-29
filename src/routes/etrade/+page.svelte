<script lang="ts">
	import { resolve } from '$app/paths';
	import { onMount } from 'svelte';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import '$lib/finance-pages.css';

	type RuntimeMode = 'local' | 'cloud';
	type EtradeStatus = {
		configured: boolean;
		authorization: 'not_configured' | 'disconnected' | 'pending' | 'connected' | 'expired';
		accountCount: number;
		authorizedAt: string | null;
		authorizationUrl: string | null;
	};

	let mode = $state<RuntimeMode | null>(null);
	let status = $state<EtradeStatus | null>(null);
	let loading = $state(true);
	let busy = $state<'credentials' | 'start' | 'verify' | 'disconnect' | 'forget' | null>(null);
	let loggingOut = $state(false);
	let consumerKey = $state('');
	let consumerSecret = $state('');
	let verifier = $state('');
	let errorMessage = $state('');
	let notice = $state('');
	let replacingCredentials = $state(false);

	onMount(() => {
		void initialize();
	});

	async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
		const response = await fetch(url, {
			...init,
			headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers
		});
		if (response.status === 401) {
			window.location.assign(resolve('/'));
			throw new Error('Your private session has ended.');
		}
		if (!response.ok) {
			const payload = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			throw new Error(payload?.error?.message || 'The request could not be completed.');
		}
		return (await response.json()) as T;
	}

	async function initialize(): Promise<void> {
		loading = true;
		try {
			const session = await requestJson<{ mode: RuntimeMode; authenticated: boolean }>(
				resolve('/api/auth/session')
			);
			mode = session.mode;
			if (!session.authenticated) {
				window.location.assign(resolve('/'));
				return;
			}
			status = await requestJson<EtradeStatus>(resolve('/api/etrade/status'));
		} catch (error) {
			errorMessage = readableError(error, 'E*TRADE setup could not be loaded.');
		} finally {
			loading = false;
		}
	}

	function readableError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	function resetMessages(): void {
		errorMessage = '';
		notice = '';
	}

	async function saveCredentials(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!consumerKey || !consumerSecret) return;
		resetMessages();
		busy = 'credentials';
		try {
			status = await requestJson<EtradeStatus>(resolve('/api/etrade/config'), {
				method: 'PUT',
				body: JSON.stringify({ consumerKey, consumerSecret })
			});
			consumerKey = '';
			consumerSecret = '';
			replacingCredentials = false;
			notice = 'Live API credentials saved securely. Start authorization when you are ready.';
		} catch (error) {
			errorMessage = readableError(error, 'The E*TRADE credentials could not be saved.');
		} finally {
			busy = null;
		}
	}

	async function startAuthorization(): Promise<void> {
		resetMessages();
		busy = 'start';
		try {
			status = await requestJson<EtradeStatus>(resolve('/api/etrade/authorization'), {
				method: 'POST'
			});
			notice = 'Authorization is ready for five minutes. Open E*TRADE and copy its code.';
		} catch (error) {
			errorMessage = readableError(error, 'E*TRADE authorization could not be started.');
		} finally {
			busy = null;
		}
	}

	async function confirmAuthorization(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!verifier.trim()) return;
		resetMessages();
		busy = 'verify';
		try {
			status = await requestJson<EtradeStatus>(resolve('/api/etrade/authorization'), {
				method: 'PUT',
				body: JSON.stringify({ verifier: verifier.trim() })
			});
			verifier = '';
			notice =
				'E*TRADE is connected for today. ChipDue can now read open orders and build estimated history.';
		} catch (error) {
			errorMessage = readableError(error, 'The E*TRADE verification code was not accepted.');
		} finally {
			busy = null;
		}
	}

	async function disconnect(): Promise<void> {
		if (!window.confirm('Disconnect today’s E*TRADE authorization from ChipDue?')) return;
		resetMessages();
		busy = 'disconnect';
		try {
			const response = await requestJson<{ status: EtradeStatus }>(
				resolve('/api/etrade/authorization'),
				{ method: 'DELETE' }
			);
			status = response.status;
			notice = 'E*TRADE authorization disconnected.';
		} catch (error) {
			errorMessage = readableError(error, 'E*TRADE could not be disconnected.');
		} finally {
			busy = null;
		}
	}

	async function forgetCredentials(): Promise<void> {
		if (
			!window.confirm(
				'Forget the encrypted E*TRADE API key and secret stored for this ChipDue account?'
			)
		) {
			return;
		}
		resetMessages();
		busy = 'forget';
		try {
			status = await requestJson<EtradeStatus>(resolve('/api/etrade/config'), {
				method: 'DELETE'
			});
			notice = 'Stored E*TRADE credentials were removed.';
		} catch (error) {
			errorMessage = readableError(error, 'The E*TRADE credentials could not be removed.');
		} finally {
			busy = null;
		}
	}

	async function logout(): Promise<void> {
		loggingOut = true;
		try {
			await requestJson(resolve('/api/auth/logout'), { method: 'POST' });
			window.location.assign(resolve('/'));
		} catch (error) {
			errorMessage = readableError(error, 'Could not log out.');
			loggingOut = false;
		}
	}

	function authorizationLabel(value: EtradeStatus['authorization']): string {
		switch (value) {
			case 'connected':
				return 'Connected today';
			case 'pending':
				return 'Waiting for code';
			case 'expired':
				return 'Reconnect for today';
			case 'disconnected':
				return 'Ready to authorize';
			default:
				return 'Setup required';
		}
	}
</script>

<svelte:head>
	<title>E*TRADE data — ChipDue</title>
	<meta
		name="description"
		content="Connect the official E*TRADE API to read open brokerage orders and build estimated history in ChipDue."
	/>
</svelte:head>

<a class="skip-link" href="#etrade-main">Skip to E*TRADE setup</a>

<div class="finance-shell">
	<WorkspaceHeader current="accounts" {mode} {loggingOut} onlogout={logout} />

	<main id="etrade-main" class="finance-main etrade-main">
		<section class="finance-toolbar" aria-labelledby="etrade-title">
			<div>
				<p class="finance-kicker">Official brokerage connection</p>
				<h1 id="etrade-title">E*TRADE data</h1>
				<p>
					ChipDue uses E*TRADE’s official API to read account names, open orders, positions, and up
					to two years of activity. It can build clearly labeled historical estimates, but does not
					include code for placing, changing, or cancelling trades.
				</p>
			</div>
			<a class="finance-button secondary" href={resolve('/accounts')}>Back to accounts</a>
		</section>

		{#if loading}
			<section class="etrade-card loading-card" aria-busy="true">
				<span></span><span></span><span></span>
			</section>
		{:else}
			{#if errorMessage}
				<p class="etrade-message error" role="alert">{errorMessage}</p>
			{/if}
			{#if notice}
				<p class="etrade-message success" role="status">{notice}</p>
			{/if}

			<section class="etrade-card status-card" aria-labelledby="connection-status-title">
				<div>
					<p class="finance-kicker">Connection status</p>
					<h2 id="connection-status-title">
						{status ? authorizationLabel(status.authorization) : 'Unavailable'}
					</h2>
					<p>
						{status?.authorization === 'connected'
							? `${status.accountCount} E*TRADE ${status.accountCount === 1 ? 'account' : 'accounts'} available. Authorization expires at midnight Eastern.`
							: status?.authorization === 'expired'
								? 'E*TRADE requires a fresh sign-in each calendar day.'
								: status?.configured
									? 'Your API credentials are encrypted and ready for authorization.'
									: 'Add an individual Live API key from your E*TRADE developer account.'}
					</p>
				</div>
				<span class:connected={status?.authorization === 'connected'} class="status-badge">
					{status?.authorization === 'connected' ? 'Read only' : 'Offline'}
				</span>
			</section>

			{#if !status?.configured || replacingCredentials}
				<section class="etrade-card" aria-labelledby="api-key-title">
					<div class="section-heading">
						<div>
							<p class="finance-kicker">Step 1</p>
							<h2 id="api-key-title">
								{status?.configured ? 'Replace API credentials' : 'Add your Live API credentials'}
							</h2>
						</div>
						<span class="encrypted-badge">Encrypted</span>
					</div>
					<p>
						Use an individual, personal-use key—not a vendor key. E*TRADE provides Live keys after
						its developer agreement and intent survey.
					</p>
					<a
						class="official-link"
						href="https://developer.etrade.com/getting-started"
						target="_blank"
						rel="noopener noreferrer"
					>
						Open official E*TRADE setup ↗
					</a>
					<form class="credential-form" autocomplete="off" onsubmit={saveCredentials}>
						<label>
							<span>Live consumer key</span>
							<input
								bind:value={consumerKey}
								name="etrade-consumer-key"
								autocomplete="off"
								autocapitalize="none"
								spellcheck="false"
								maxlength="256"
								required
							/>
						</label>
						<label>
							<span>Live consumer secret</span>
							<input
								bind:value={consumerSecret}
								name="etrade-consumer-secret"
								type="password"
								autocomplete="new-password"
								autocapitalize="none"
								spellcheck="false"
								maxlength="256"
								required
							/>
						</label>
						<div class="form-actions">
							<button
								class="finance-button"
								type="submit"
								disabled={busy !== null || !consumerKey || !consumerSecret}
							>
								{busy === 'credentials' ? 'Saving…' : 'Encrypt and save'}
							</button>
							{#if status?.configured}
								<button
									class="finance-button secondary"
									type="button"
									disabled={busy !== null}
									onclick={() => (replacingCredentials = false)}>Cancel</button
								>
							{/if}
						</div>
					</form>
					<small>
						The secret is sent only to your authenticated ChipDue server over HTTPS, encrypted
						there, and never returned to the browser.
					</small>
				</section>
			{:else}
				<section class="etrade-card" aria-labelledby="authorize-title">
					<p class="finance-kicker">Step 2</p>
					<h2 id="authorize-title">Authorize today’s read access</h2>
					<p>
						E*TRADE makes access tokens expire at midnight Eastern. Starting authorization creates a
						five-minute window to approve access and copy its verification code.
					</p>

					{#if status.authorization !== 'connected' && status.authorization !== 'pending'}
						<button
							class="finance-button"
							type="button"
							disabled={busy !== null}
							onclick={startAuthorization}
						>
							{busy === 'start' ? 'Contacting E*TRADE…' : 'Start E*TRADE authorization'}
						</button>
					{/if}

					{#if status.authorization === 'pending' && status.authorizationUrl}
						<div class="authorization-steps">
							<!-- eslint-disable svelte/no-navigation-without-resolve -- E*TRADE returns this validated external authorization URL. -->
							<a
								class="finance-button"
								href={status.authorizationUrl}
								target="_blank"
								rel="noopener noreferrer">Open E*TRADE authorization ↗</a
							>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							<form class="verifier-form" autocomplete="off" onsubmit={confirmAuthorization}>
								<label>
									<span>Verification code from E*TRADE</span>
									<input
										bind:value={verifier}
										name="etrade-verifier"
										autocomplete="one-time-code"
										autocapitalize="characters"
										spellcheck="false"
										maxlength="64"
										required
									/>
								</label>
								<button
									class="finance-button"
									type="submit"
									disabled={busy !== null || !verifier.trim()}
								>
									{busy === 'verify' ? 'Verifying…' : 'Connect read access'}
								</button>
							</form>
							<button
								class="text-button"
								type="button"
								disabled={busy !== null}
								onclick={startAuthorization}>Start over with a new code</button
							>
						</div>
					{:else if status.authorization === 'connected'}
						<div class="connected-actions">
							<a class="finance-button" href={resolve('/accounts')}>View open orders</a>
							<button
								class="finance-button secondary"
								type="button"
								disabled={busy !== null}
								onclick={disconnect}
							>
								{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect today'}
							</button>
						</div>
					{/if}
				</section>

				<section class="etrade-card compact-card" aria-labelledby="credential-controls-title">
					<div>
						<h2 id="credential-controls-title">Stored API credentials</h2>
						<p>Replace a rotated key or remove the encrypted key and secret from ChipDue.</p>
					</div>
					<div class="connected-actions">
						<button
							class="finance-button secondary"
							type="button"
							disabled={busy !== null}
							onclick={() => (replacingCredentials = true)}>Replace</button
						>
						<button
							class="danger-button"
							type="button"
							disabled={busy !== null}
							onclick={forgetCredentials}
						>
							{busy === 'forget' ? 'Removing…' : 'Forget credentials'}
						</button>
					</div>
				</section>
			{/if}
		{/if}
	</main>
</div>

<style>
	.etrade-main {
		max-width: 980px;
	}

	.etrade-card {
		margin-top: 1.25rem;
		padding: clamp(1.25rem, 3vw, 2rem);
		border: 1px solid var(--finance-border, #d9d4ca);
		border-radius: 1.25rem;
		background: #fffefa;
		box-shadow: 0 18px 45px rgb(42 39 31 / 6%);
	}

	.etrade-card h2 {
		margin: 0.15rem 0 0.55rem;
		font-size: 1.35rem;
	}

	.etrade-card p {
		color: #5e6473;
		line-height: 1.6;
	}

	.status-card,
	.section-heading,
	.compact-card {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1.5rem;
	}

	.status-badge,
	.encrypted-badge {
		flex: none;
		padding: 0.4rem 0.7rem;
		border-radius: 999px;
		background: #eeeae1;
		color: #626775;
		font-size: 0.75rem;
		font-weight: 800;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.status-badge.connected,
	.encrypted-badge {
		background: #e6f4e8;
		color: #27623d;
	}

	.official-link {
		display: inline-flex;
		margin: 0.25rem 0 1.15rem;
		color: #253b9a;
		font-weight: 750;
	}

	.credential-form,
	.verifier-form {
		display: grid;
		gap: 1rem;
		margin-top: 1rem;
	}

	.credential-form label,
	.verifier-form label {
		display: grid;
		gap: 0.45rem;
		font-weight: 750;
		color: #343947;
	}

	.credential-form input,
	.verifier-form input {
		width: 100%;
		box-sizing: border-box;
		padding: 0.8rem 0.9rem;
		border: 1px solid #c9c5ba;
		border-radius: 0.7rem;
		background: #fff;
		font: inherit;
	}

	.form-actions,
	.connected-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		align-items: center;
	}

	.authorization-steps {
		display: grid;
		gap: 1rem;
		margin-top: 1rem;
		padding: 1rem;
		border-radius: 0.9rem;
		background: #f6f3eb;
	}

	.etrade-message {
		margin: 1rem 0 0;
		padding: 0.85rem 1rem;
		border-radius: 0.75rem;
	}

	.etrade-message.error {
		background: #fff0ed;
		color: #8e3027;
	}

	.etrade-message.success {
		background: #eaf6ec;
		color: #275f3b;
	}

	.text-button,
	.danger-button {
		border: 0;
		background: transparent;
		font: inherit;
		font-weight: 750;
		cursor: pointer;
	}

	.text-button {
		justify-self: start;
		color: #253b9a;
	}

	.danger-button {
		padding: 0.65rem 0.75rem;
		color: #9a3028;
	}

	button:disabled {
		cursor: wait;
		opacity: 0.62;
	}

	.loading-card span {
		display: block;
		width: 100%;
		height: 0.8rem;
		margin: 0.6rem 0;
		border-radius: 999px;
		background: #ece8df;
	}

	.loading-card span:nth-child(2) {
		width: 72%;
	}

	.loading-card span:nth-child(3) {
		width: 48%;
	}

	@media (max-width: 700px) {
		.status-card,
		.section-heading,
		.compact-card {
			flex-direction: column;
		}
	}
</style>
