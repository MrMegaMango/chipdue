import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const accountsSource = readFileSync(new URL('./accounts/+page.svelte', import.meta.url), 'utf8');
const financePagesStylesSource = readFileSync(
	new URL('../lib/finance-pages.css', import.meta.url),
	'utf8'
);
const balanceHistoryChartSource = readFileSync(
	new URL('../lib/components/BalanceHistoryChart.svelte', import.meta.url),
	'utf8'
);
const netWorthChartSource = readFileSync(
	new URL('../lib/components/NetWorthChart.svelte', import.meta.url),
	'utf8'
);
const bonusesSource = readFileSync(new URL('./bonuses/+page.svelte', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const etradeSource = readFileSync(new URL('./etrade/+page.svelte', import.meta.url), 'utf8');
const headerSource = readFileSync(
	new URL('../lib/components/WorkspaceHeader.svelte', import.meta.url),
	'utf8'
);
const cardsRouteSource = readFileSync(new URL('./cards/+page.svelte', import.meta.url), 'utf8');
const settingsRouteSource = readFileSync(
	new URL('./settings/+page.svelte', import.meta.url),
	'utf8'
);

describe('financial workspace navigation', () => {
	it('offers overview, cards, accounts, and bonuses as first-class tabs', () => {
		for (const marker of [
			"label: 'Overview'",
			"label: 'Cards'",
			"label: 'Accounts'",
			"label: 'Bonuses'"
		]) {
			expect(headerSource).toContain(marker);
		}
		expect(headerSource).toContain("href: '/cards'");
		expect(headerSource).toContain("href={resolve('/settings')}");
		expect(cardsRouteSource).toContain('<DashboardPage />');
		expect(settingsRouteSource).toContain('<DashboardPage />');
		expect(dashboardSource).toContain("page.route.id === '/cards'");
		expect(dashboardSource).toContain("page.route.id === '/settings'");
		expect(dashboardSource).toContain("{:else if currentSection === 'cards'}");
	});

	it('keeps connection management in settings while exposing direct connection actions', () => {
		expect(dashboardSource).toContain("hidden={currentSection === 'overview'}");
		expect(dashboardSource).toContain("hidden={currentSection !== 'settings'}");
		expect(dashboardSource).toContain("hidden={currentSection !== 'cards'}");
		expect(dashboardSource).toContain('Account and data connections');
		expect(dashboardSource).toContain('Manage sign-in, privacy, and data connections.');
		expect(accountsSource).toContain('onclick={connectPlaid}');
		expect(dashboardSource).toContain("resolve('/settings#plaid-setup')");
	});

	it('makes accounts and bonuses first-class parts of the dashboard', () => {
		expect(dashboardSource).toContain("href={resolve('/accounts')}");
		expect(dashboardSource).toContain("href={resolve('/bonuses')}");
		expect(dashboardSource).toContain('Payments &amp; deadlines');
		expect(dashboardSource).toContain('activeBonusValueCents');
	});

	it('shows net worth history on the overview', () => {
		expect(dashboardSource).toContain('NetWorthChart');
		expect(dashboardSource).toContain('accounts={workspaceAccounts}');
		expect(dashboardSource).toContain('cardBalanceCents={trackedCardBalanceCents}');
		expect(netWorthChartSource).toContain('Net worth over time');
		expect(netWorthChartSource).toContain('Current net worth');
		expect(netWorthChartSource).toContain('Net worth history range');
		expect(netWorthChartSource).toContain('Older gaps use the earliest known balance');
	});

	it('supports personal, business, and brokerage account tracking', () => {
		expect(accountsSource).toContain('<option value="business">Business</option>');
		expect(accountsSource).toContain('<option value="brokerage">Brokerage</option>');
		expect(accountsSource).toContain('Net contributions');
		expect(accountsSource).toContain('Investment return');
		expect(accountsSource).toContain('Current price');
		expect(accountsSource).toContain('account.holdings');
		expect(accountsSource).toContain('BalanceHistoryChart');
		expect(accountsSource).toContain('points={account.balanceHistory}');
		expect(accountsSource).toContain('netContributionsCents={account.netContributionsCents}');
	});

	it('stacks brokerage contributions beneath gain and loss returns', () => {
		expect(balanceHistoryChartSource).toContain('class="contributions-area"');
		expect(balanceHistoryChartSource).toContain("class:return-gain={area.kind === 'gain'}");
		expect(balanceHistoryChartSource).toContain("class:return-loss={area.kind === 'loss'}");
		expect(balanceHistoryChartSource).toContain('Portfolio value');
		expect(balanceHistoryChartSource).toContain('Investment return');
		expect(balanceHistoryChartSource).toContain('Estimated history');
		expect(balanceHistoryChartSource).toContain('Observed snapshot');
		expect(balanceHistoryChartSource).toContain('automaticContributions');
		expect(balanceHistoryChartSource).toContain('first estimated value plus synced');
	});

	it('calculates connected brokerage contributions without requiring manual entry', () => {
		expect(accountsSource).toContain('effectiveNetContributions(account)');
		expect(accountsSource).toContain('needsEstimatedContributionHistory(account)');
		expect(accountsSource).toContain('Net contributions are calculated automatically');
		expect(accountsSource).toContain('Lifetime net contributions (optional)');
		expect(accountsSource).toContain('Enter a lifetime total only to override it.');
		expect(accountsSource).toContain(
			'editingAccount.netContributionsCents !== savedAccount.netContributionsCents'
		);
	});

	it('shows institution branding on account cards', () => {
		expect(accountsSource).toContain('account.institutionLogoUrl');
		expect(accountsSource).toContain("asset('/brands/wells-fargo.svg')");
		expect(accountsSource).toContain('class="institution-mark"');
		expect(accountsSource).toContain('alt={`${account.institution ?? account.nickname} logo`}');
	});

	it('separates cash and brokerage accounts into distinct groups', () => {
		expect(accountsSource).toContain("title: 'Cash accounts'");
		expect(accountsSource).toContain("account.accountType !== 'brokerage'");
		expect(accountsSource).toContain("title: 'Brokerage accounts'");
		expect(accountsSource).toContain("account.accountType === 'brokerage'");
		expect(accountsSource).toContain('{#each accountGroups as accountGroup');
	});

	it('separates cash accounts by owner without splitting brokerage accounts', () => {
		expect(accountsSource).toContain(
			'splitAccountsByOwner(accountGroup.accounts, accountGroup.separateByOwner)'
		);
		expect(accountsSource).toContain('separateByOwner: true');
		expect(accountsSource).toContain('separateByOwner: false');
		expect(accountsSource).toContain("return [{ id: 'all', title: null");
		expect(accountsSource).toContain("title: 'Business'");
		expect(accountsSource).toContain("account.ownerType === 'business'");
		expect(accountsSource).toContain("title: 'Personal'");
		expect(accountsSource).toContain("account.ownerType === 'personal'");
		expect(accountsSource).not.toContain('<dt>Ownership</dt>');
		expect(accountsSource).toContain('class="account-ownership-heading"');
		expect(accountsSource).toContain('border-bottom: 1px solid var(--line);');
		expect(accountsSource).not.toContain('class:business={ownershipGroup.id');
		expect(accountsSource).not.toContain('.account-ownership-heading.business');
		expect(accountsSource).not.toContain('border-left: 3px solid var(--accent);');
		expect(accountsSource).toContain('<label for="account-owner">Ownership</label>');
		expect(accountsSource).toContain("{#if form.accountType !== 'brokerage'}");
		expect(accountsSource.indexOf("id: 'personal'")).toBeLessThan(
			accountsSource.indexOf("id: 'business'")
		);
	});

	it('orders account cards by value within each ownership group', () => {
		expect(accountsSource).toContain('sortAccountsByValue(');
		expect(accountsSource).toContain(
			'return right.currentBalanceCents - left.currentBalanceCents;'
		);
		expect(accountsSource).toContain(
			'if (left.currentBalanceCents === null) return right.currentBalanceCents === null ? 0 : 1;'
		);
	});

	it('shows APY only for accounts with an entered interest rate', () => {
		expect(accountsSource).toContain('{#if account.apyBasisPoints !== null}');
		expect(accountsSource).toContain('<dt>APY</dt>');
		expect(accountsSource).toContain('formatApy(account.apyBasisPoints)');
		expect(accountsSource).toContain('Institution rate via');
		expect(accountsSource).toContain('formatApyFreshness(account)');
		expect(accountsSource).toContain("dialogAccount?.apySource === 'published'");
		expect(accountsSource).toContain('Published Wealthfront base rate');
		expect(accountsSource).toContain(
			'Updated automatically from the institution during each Plaid sync.'
		);
		expect(accountsSource).toContain('<label for="account-apy">APY (%)</label>');
		expect(accountsSource).toContain('Enter a manual fallback if needed.');
	});

	it('only shows an account opening date when one is available', () => {
		expect(accountsSource).toContain('{#if account.openedDate}');
		expect(accountsSource).toContain('<dd>{formatDate(account.openedDate)}</dd>');
	});

	it('replaces connected account pills with low-emphasis sync freshness', () => {
		expect(accountsSource).not.toContain('<dt>Data source</dt>');
		expect(accountsSource).toContain('class="account-sync-time"');
		expect(accountsSource).toContain('{formatSyncTime(account.lastSyncedAt)}</span');
		expect(accountsSource).toContain("account.source === 'manual' || account.status !== 'active'");
		expect(accountsSource).toContain('<span class="finance-pill source">Manual</span>');
		expect(accountsSource).not.toContain("class:connected={account.source === 'connected'}");
		expect(accountsSource).not.toContain('<small>{formatSyncTime(account.lastSyncedAt)}</small>');
		expect(accountsSource).toContain('.account-sync-time {');
	});

	it('prioritizes automatic account updates over manual entry', () => {
		const actionsSource = accountsSource.slice(
			accountsSource.indexOf('class="account-toolbar-actions"'),
			accountsSource.indexOf(
				'</section>',
				accountsSource.indexOf('class="account-toolbar-actions"')
			)
		);
		expect(accountsSource).toContain('class:secondary={connections.length > 0}');
		expect(accountsSource).toContain(
			'class="finance-button"\n\t\t\t\t\t\ttype="button"\n\t\t\t\t\t\tonclick={syncConnectedAccounts}'
		);
		expect(accountsSource).toContain('onclick={openAdd}');
		expect(actionsSource.indexOf('Add manually')).toBeLessThan(
			actionsSource.indexOf('Add connection')
		);
		expect(actionsSource.indexOf('Add connection')).toBeLessThan(
			actionsSource.indexOf('Sync connections')
		);
		expect(actionsSource).toContain('M10 4v12M4 10h12');
		expect(actionsSource).toContain('M16 7a6.5 6.5 0 1 0 .2 5.5M16 3v4h-4');
		expect(accountsSource).toContain('flex-wrap: nowrap');
		expect(accountsSource).toContain('@media (max-width: 900px)');
	});

	it('uses the same connected-state actions on cards and accounts', () => {
		expect(dashboardSource).toContain("currentSection === 'cards' && plaid.connectedItems > 0");
		expect(dashboardSource).toContain('Add connection');
		expect(dashboardSource).toContain('onclick={connectPlaid}');
		expect(accountsSource).toContain('onclick={connectPlaid}');
		expect(accountsSource).toContain("resolve('/api/plaid/link-token')");
		expect(accountsSource).toContain("resolve('/api/plaid/exchange')");
		expect(dashboardSource.match(/onclick=\{syncConnections\}/g)).toHaveLength(1);
		expect(dashboardSource).not.toContain("'Connect another'");
		expect(accountsSource).toContain("syncing ? 'Syncing…' : 'Sync connections'");
	});

	it('reuses private responses and avoids work that the active tab does not display', () => {
		for (const source of [dashboardSource, accountsSource, bonusesSource]) {
			expect(source).toContain('reusePrivateApiGet');
			expect(source).toContain('clearPrivateApiCache');
		}
		expect(dashboardSource).toContain("if (currentSection === 'settings')");
		expect(dashboardSource).toContain("if (currentSection === 'cards')");
		expect(dashboardSource).toContain(
			"if (currentSection === 'cards') void refreshRecentActivity(cards, expectedEpoch);"
		);
		expect(bonusesSource).toContain(
			'void loadLinkedAccountActivity(bonusResponse.bonuses, accountResponse.accounts);'
		);
		expect(bonusesSource).toContain('Loading posted activity…');
	});

	it('checks E*TRADE open orders only when requested', () => {
		expect(accountsSource).toContain('ordersRequestedByAccount');
		expect(accountsSource).toContain('Live E*TRADE orders are checked only when you ask.');
		expect(accountsSource).toContain('>Check open orders</button');
		expect(accountsSource).toContain('onclick={() => loadBrokerageOrders(account)}');
		expect(accountsSource).not.toContain('loadBrokerageOrders(loadedAccounts');
		expect(accountsSource).toContain('loadEtradeEstimatedHistories(loadedAccounts)');
	});

	it('matches the cards toolbar scale and button geometry', () => {
		for (const marker of [
			'font-size: clamp(1.7rem, 3vw, 2.2rem)',
			'padding: 1.65rem 0 5rem',
			'min-height: 43px',
			'border-radius: 7px',
			'font-size: 0.82rem',
			'text-decoration: none',
			'white-space: nowrap'
		]) {
			expect(financePagesStylesSource).toContain(marker);
		}
	});

	it('shows provider activity and explains the open-order limitation', () => {
		expect(accountsSource).toContain("'Recent activity'");
		expect(accountsSource).toContain("'Investment activity'");
		expect(accountsSource).toContain('investmentDetails');
		expect(accountsSource).toContain("resolve('/api/accounts/[id]/transactions'");
		expect(accountsSource).toContain('<h4>Open orders</h4>');
		expect(accountsSource).toContain('Plaid does not provide open-order data.');
	});

	it('renders the account inventory before loading provider-backed details', () => {
		const initializeSource = accountsSource.slice(
			accountsSource.indexOf('async function initialize'),
			accountsSource.indexOf('async function requestJson')
		);
		expect(initializeSource).toContain('loading = false;');
		expect(initializeSource).toContain(
			'accountResponse.accounts.filter((account) => !account.hidden)'
		);
		expect(initializeSource).not.toContain('await loadSupplementalAccountData');
	});

	it('loads hidden account details only when hidden accounts are revealed', () => {
		expect(accountsSource).toContain('function toggleHiddenAccounts(): void');
		expect(accountsSource).toContain('onclick={toggleHiddenAccounts}');
		expect(accountsSource).toContain(
			'void loadSupplementalAccountData(unloadedHiddenAccounts, false, true)'
		);
		expect(accountsSource).toContain('supplementalRequestedAccountIds.includes(account.id)');
	});

	it('adds a read-only official E*TRADE data connection', () => {
		expect(accountsSource).toContain("resolve('/api/accounts/[id]/orders'");
		expect(accountsSource).toContain("resolve('/api/accounts/[id]/estimated-history'");
		expect(accountsSource).toContain('Build 2-year estimate');
		expect(accountsSource).not.toContain(
			'<a class="finance-button secondary" href={resolve(\'/etrade\')}>E*TRADE orders</a>'
		);
		expect(accountsSource).toContain("? 'Connect E*TRADE'");
		expect(accountsSource).toContain("? 'Reconnect E*TRADE'");
		expect(accountsSource).toContain(": 'Review E*TRADE setup'");
		expect(etradeSource).toContain('Live consumer key');
		expect(etradeSource).toContain('verification code');
		expect(etradeSource).toContain('midnight Eastern');
		expect(etradeSource).toContain('placing, changing, or cancelling trades');
	});

	it('builds estimated history for Plaid-connected brokerages such as Chase', () => {
		expect(accountsSource).toContain('loadPlaidEstimatedHistories');
		expect(accountsSource).toContain('Estimated portfolio history');
		expect(accountsSource).toContain('Sync activity first');
		expect(accountsSource).toContain('financialProviderName(account.connectionProvider)');
	});

	it('explains cash sweeps without presenting them as stock sales or gains', () => {
		expect(accountsSource).toContain("return action === 'used' ? 'Cash used'");
		expect(accountsSource).toContain('Paid from QACDS for a purchase or withdrawal');
		expect(accountsSource).toContain('QACDS is Chase’s name for uninvested cash');
		expect(accountsSource).toContain('stock sale or investment gain');
		expect(accountsSource).toContain("? 'Fixed at $1.00'");
	});

	it('lets people hide stale accounts and restore them later', () => {
		expect(accountsSource).toContain('Show hidden (');
		expect(accountsSource).toContain('Excluded from your account map and summary totals.');
		expect(accountsSource).toContain('setAccountHidden(account, !account.hidden)');
		expect(accountsSource).toContain('undoHiddenAccount');
	});

	it('tracks the full bonus lifecycle and manual requirements', () => {
		for (const marker of [
			'Requirement deadline',
			'Expected payout',
			'Safe to close',
			'Payout pending',
			'toggleRequirement'
		]) {
			expect(bonusesSource).toContain(marker);
		}
	});

	it('calculates earned bonus value instead of asking for manual entry', () => {
		expect(bonusesSource).toContain('automaticEarnedValueCents');
		expect(bonusesSource).toContain('formatMoney(earnedValueCents)');
		expect(bonusesSource).not.toContain(
			'formatMoney(paidBonuses.length ? earnedValueCents : null)'
		);
	});

	it('shows generic live trackers backed by verified offer templates', () => {
		for (const marker of [
			'Verified offer',
			'Synced + verified',
			'Manual + verified',
			'Current synced balance',
			'Likely qualifying activity',
			'Official terms',
			'form.offerTemplateId'
		]) {
			expect(bonusesSource).toContain(marker);
		}
		expect(accountsSource).toContain('Verified bonus catalog');
		expect(accountsSource).toContain('Choose your offer');
		expect(accountsSource).toContain('window.location.assign(bonusSetupHref(savedAccount))');
		expect(bonusesSource).toContain('Tracker setup needed');
		expect(bonusesSource).toContain("tracker.account.source === 'connected'");
	});

	it('keeps new financial data out of persistent browser storage', () => {
		for (const source of [accountsSource, bonusesSource, etradeSource]) {
			expect(source).not.toContain('localStorage');
			expect(source).not.toContain('sessionStorage');
			expect(source).not.toContain('indexedDB');
		}
	});

	it('lets installation Plaid accounts switch future connections to a personal team', () => {
		expect(dashboardSource).toContain('{:else if plaid.configured}');
		expect(dashboardSource).toContain('Installation Plaid account is connected');
		expect(dashboardSource).toContain(
			'Switch future institutions to your personal Plaid team without disrupting existing connections.'
		);
	});

	it('shows which Plaid team will receive the next alternating connection', () => {
		expect(dashboardSource).toContain('Alternating Plaid Teams');
		expect(dashboardSource).toContain("? 'original Team'");
		expect(dashboardSource).toContain(": 'new personal Team'");
	});
});
