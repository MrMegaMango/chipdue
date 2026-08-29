<script module lang="ts">
	export type GoogleCallbackResult = 'login' | 'linked' | 'error';
	export type AuthenticationMode = 'local' | 'password' | 'google';
	export const LAST_FOUR_PATTERN = '[0-9][0-9][0-9][0-9]';
	export const GOOGLE_BOOTSTRAP_CONTINUE_TO = '/api/auth/google/bootstrap/continue';
	export const SETUP_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
	export type GoogleCalendarEvent = {
		nickname: string;
		dueDate: string;
	};

	function nextCalendarDate(value: string): string | null {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
		const [year, month, day] = value.split('-').map(Number);
		const date = new Date(Date.UTC(year, month - 1, day));
		if (date.toISOString().slice(0, 10) !== value) return null;
		return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
	}

	export function googleCalendarEventUrl(event: GoogleCalendarEvent): string | null {
		const endDate = nextCalendarDate(event.dueDate);
		if (!endDate) return null;

		const url = new URL('https://calendar.google.com/calendar/render');
		url.searchParams.set('action', 'TEMPLATE');
		url.searchParams.set('text', `${event.nickname} payment due`);
		url.searchParams.set(
			'dates',
			`${event.dueDate.replaceAll('-', '')}/${endDate.replaceAll('-', '')}`
		);
		url.searchParams.set('trp', 'false');
		return url.toString();
	}

	export function inputToCents(value: string | number | undefined): number | null {
		if (value === undefined || (typeof value === 'string' && !value.trim())) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
	}

	export function isValidOptionalAmount(value: string | number | null | undefined): boolean {
		if (value === null || value === undefined) return true;
		if (typeof value === 'string' && !value.trim()) return true;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0;
	}

	export function parseGoogleCallbackResult(value: string | null): GoogleCallbackResult | null {
		return value === 'login' || value === 'linked' || value === 'error' ? value : null;
	}

	export function authorizeGoogleCallbackResult(
		result: GoogleCallbackResult | null,
		authenticated: boolean,
		googleLinked: boolean
	): GoogleCallbackResult | null {
		if (result === 'login' || result === 'linked') {
			return authenticated && googleLinked ? result : 'error';
		}
		return result;
	}

	export function canOfferGoogleLogin(
		authMode: 'local' | 'cloud' | null,
		configured: boolean
	): boolean {
		return authMode === 'cloud' && configured;
	}

	export function isGoogleOnlyCloudMode(
		runtimeMode: 'local' | 'cloud' | null,
		authenticationMode: AuthenticationMode | null
	): boolean {
		return runtimeMode === 'cloud' && authenticationMode === 'google';
	}

	export function canShowPasswordLogin(
		runtimeMode: 'local' | 'cloud' | null,
		authenticationMode: AuthenticationMode | null
	): boolean {
		return runtimeMode === 'cloud' && authenticationMode === 'password';
	}

	export function canShowGoogleBootstrap(
		runtimeMode: 'local' | 'cloud' | null,
		authenticationMode: AuthenticationMode | null,
		bootstrapAvailable: boolean
	): boolean {
		return isGoogleOnlyCloudMode(runtimeMode, authenticationMode) && bootstrapAvailable;
	}

	export function isValidSetupToken(value: string): boolean {
		return SETUP_TOKEN_PATTERN.test(value);
	}

	export function isApprovedBootstrapContinuation(value: unknown): boolean {
		return value === GOOGLE_BOOTSTRAP_CONTINUE_TO;
	}

	export function cardBrandForIssuer(
		issuer: string | null
	): 'chase' | 'venmo' | 'wells-fargo' | null {
		if (!issuer) return null;
		if (/\bvenmo\b/i.test(issuer)) return 'venmo';
		if (/\bwells\s+fargo\b/i.test(issuer)) return 'wells-fargo';
		if (/\bchase\b/i.test(issuer)) return 'chase';
		return null;
	}

	function fallbackInstitutionLogoUrl(issuer: string | null): string | null {
		const brand = cardBrandForIssuer(issuer);
		return brand ? asset(`/brands/${brand}.svg`) : null;
	}

	export type InterestSavingTarget = {
		amountCents: number | null;
		source: 'statement' | 'current' | 'unavailable';
	};

	export function interestSavingTarget(
		statementBalanceCents: number | null,
		currentBalanceCents: number | null
	): InterestSavingTarget {
		if (statementBalanceCents !== null) {
			return { amountCents: Math.max(0, statementBalanceCents), source: 'statement' };
		}
		if (currentBalanceCents !== null) {
			return { amountCents: Math.max(0, currentBalanceCents), source: 'current' };
		}
		return { amountCents: null, source: 'unavailable' };
	}

	export type CardRewardType = 'points' | 'miles' | 'cash_back';
	export type CardRewardCategoryMatch =
		| 'dining'
		| 'groceries'
		| 'gas'
		| 'travel'
		| 'flights_hotels'
		| 'transit'
		| 'entertainment'
		| 'drugstores'
		| 'streaming'
		| 'online_shopping'
		| 'home_improvement'
		| 'utilities';

	export type CardTransactionRewardEstimate = {
		type: CardRewardType;
		amount: number;
		rate: number;
		categoryName: string | null;
		currency: string;
	};

	export function inputToRewardRate(value: string | number | undefined): number | null {
		if (value === undefined || (typeof value === 'string' && !value.trim())) return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
	}

	export function rewardTypeLabel(type: CardRewardType | null): string {
		if (type === 'cash_back') return 'Cash back';
		if (type === 'miles') return 'Miles';
		return type === 'points' ? 'Points' : 'Not set';
	}

	export function formatRewardRate(rate: number | null, type: CardRewardType | null): string {
		if (rate === null) return 'Not set';
		const formatted = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(rate);
		return `${formatted}${type === 'cash_back' ? '%' : 'x'}`;
	}

	export function formatRewardEstimate(estimate: CardTransactionRewardEstimate): string {
		if (estimate.type === 'cash_back') {
			return `Est. ${new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency: estimate.currency,
				minimumFractionDigits: 2
			}).format(estimate.amount / 100)} cash back`;
		}
		const unit = estimate.type === 'miles' ? 'mile' : 'point';
		const units = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(
			estimate.amount
		);
		return `Est. ${units} ${unit}${estimate.amount === 1 ? '' : 's'}`;
	}
</script>

<script lang="ts">
	import { asset, resolve } from '$app/paths';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, tick } from 'svelte';
	import {
		AUTOMATIC_CARD_REWARD_PROFILES,
		type AutomaticCardRewardProfile
	} from '$lib/card-reward-profiles';
	import WorkspaceHeader from '$lib/components/WorkspaceHeader.svelte';
	import { financialProviderName } from '$lib/financial-data';

	type PageSection = 'overview' | 'cards' | 'settings';
	const currentSection: PageSection = $derived(
		page.route.id === '/cards' ? 'cards' : page.route.id === '/settings' ? 'settings' : 'overview'
	);

	type FinancialDataProvider = 'plaid';
	type CardSource = 'manual' | 'connected';
	type DialogMode = 'add' | 'edit' | null;
	type NoticeKind = 'success' | 'error';
	type AuthMode = 'local' | 'cloud';
	type GoogleAuthStatus = {
		configured: boolean;
		linked: boolean | null;
		bootstrapAvailable: boolean;
	};
	type AuthSession = {
		mode: AuthMode;
		authMode: AuthenticationMode;
		authenticated: boolean;
		google: GoogleAuthStatus;
	};
	type RequestOptions = { handleUnauthorized?: boolean; privateEpoch?: number };

	type CardView = {
		id: string;
		nickname: string;
		providerProductName: string | null;
		issuer: string | null;
		issuerLogoUrl: string | null;
		last4: string | null;
		source: CardSource;
		statementBalanceCents: number | null;
		minimumPaymentCents: number | null;
		currentBalanceCents: number | null;
		dueDate: string | null;
		statementDate: string | null;
		isOverdue: boolean | null;
		autopayEnabled: boolean;
		rewardProgramName: string | null;
		rewardValueCents: number | null;
		rewardType: CardRewardType | null;
		rewardBaseRate: number | null;
		rewardCategories: CardRewardCategory[];
		rewardSource: 'automatic' | 'manual' | null;
		rewardProfileName: string | null;
		rewardCalculation: 'static' | 'venmo_spend_ranked' | null;
		transactionHistoryEnabled: boolean;
		transactionHistoryStatus: 'unknown' | 'preparing' | 'current' | 'historical_complete' | null;
		connectionId: string | null;
		connectionProvider: FinancialDataProvider | null;
		updatedAt: string;
		lastSyncedAt?: string | null;
	};

	type CardRewardCategory = {
		id: string;
		name: string;
		multiplier: number | null;
		matchCategory: CardRewardCategoryMatch | null;
		annualSpendCapCents?: number | null;
	};
	type CardRewardCategorySpend = {
		categoryId: string;
		year: number;
		spentCents: number;
		capCents: number;
		remainingCents: number;
	};
	type EditableRewardCategory = {
		id?: string;
		name: string;
		multiplier: string | number | undefined;
		matchCategory: CardRewardCategoryMatch | '';
	};

	type CardTransaction = {
		id: string;
		name: string;
		merchantName: string | null;
		amountCents: number;
		currency: string;
		date: string;
		authorizedDate: string | null;
		pending: boolean;
		categoryPrimary: string | null;
		categoryDetailed: string | null;
		rewardEstimate: CardTransactionRewardEstimate | null;
	};

	type TransactionHistoryResponse = {
		transactions: CardTransaction[];
		rewardCategorySpending: CardRewardCategorySpend[];
		status: Exclude<CardView['transactionHistoryStatus'], null>;
		lastSyncedAt: string | null;
	};

	type PlaidStatus = {
		configured: boolean;
		source: 'personal' | 'installation' | null;
		environment: 'sandbox' | 'production' | null;
		alternatingTeams: boolean;
		nextConnectionTeam: 'current' | 'original' | null;
		connectedItems: number;
		lastSyncedAt: string | null;
	};

	type FinancialConnection = {
		id: string;
		provider: FinancialDataProvider;
		institutionName: string | null;
		status: 'healthy' | 'needs_update';
		lastSyncedAt: string | null;
		createdAt: string;
	};

	type PlaidStatusResponse = {
		configured: boolean;
		source: 'personal' | 'installation' | null;
		environment: 'sandbox' | 'production' | null;
		alternatingTeams: boolean;
		nextConnectionTeam: 'current' | 'original' | null;
	};

	type FinancialConnectionsResponse = {
		connections: FinancialConnection[];
	};

	type CardsResponse = {
		cards: CardView[];
		connections?: {
			connected: number;
			lastSyncedAt: string | null;
		};
	};

	type WorkspaceAccount = { id: string };
	type WorkspaceBonus = {
		id: string;
		name: string;
		status: 'planned' | 'active' | 'qualified' | 'pending' | 'paid' | 'closed' | 'abandoned';
		rewardCents: number | null;
		requirementDeadline: string | null;
	};

	type CardForm = {
		nickname: string;
		issuer: string;
		last4: string;
		statementBalance: string | number | undefined;
		minimumPayment: string | number | undefined;
		currentBalance: string | number | undefined;
		dueDate: string;
		statementDate: string;
		autopayEnabled: boolean;
	};

	type RewardsForm = {
		programName: string;
		rewardValue: string | number | undefined;
		rewardType: CardRewardType;
		baseRate: string | number | undefined;
		categories: EditableRewardCategory[];
	};

	type PlaidHandler = {
		open: () => void;
		destroy: () => void;
	};

	type PlaidFactory = {
		create: (configuration: {
			token: string;
			onSuccess: (
				publicToken: string,
				metadata?: { institution?: { name?: string | null } | null }
			) => void;
			onExit: (error: unknown) => void;
		}) => PlaidHandler;
	};

	const emptyPlaid: PlaidStatus = {
		configured: false,
		source: null,
		environment: null,
		alternatingTeams: false,
		nextConnectionTeam: null,
		connectedItems: 0,
		lastSyncedAt: null
	};

	const money = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 2
	});
	const wholeDollarMoney = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 0
	});
	const compactMoney = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		minimumFractionDigits: 0,
		maximumFractionDigits: 2
	});

	const fullDate = new Intl.DateTimeFormat('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
	const RECENT_ACTIVITY_LIMIT = 3;
	const REWARD_CATEGORY_MATCH_OPTIONS: Array<{
		value: CardRewardCategoryMatch;
		label: string;
	}> = [
		{ value: 'dining', label: 'Dining' },
		{ value: 'groceries', label: 'Groceries' },
		{ value: 'gas', label: 'Gas stations' },
		{ value: 'travel', label: 'Travel' },
		{ value: 'flights_hotels', label: 'Flights & hotels' },
		{ value: 'transit', label: 'Transit & rideshare' },
		{ value: 'entertainment', label: 'Entertainment' },
		{ value: 'drugstores', label: 'Drugstores' },
		{ value: 'streaming', label: 'Streaming' },
		{ value: 'online_shopping', label: 'Online shopping' },
		{ value: 'home_improvement', label: 'Home improvement' },
		{ value: 'utilities', label: 'Utilities' }
	];

	let authMode = $state<AuthMode | null>(null);
	let authenticationMode = $state<AuthenticationMode | null>(null);
	let authenticated = $state(false);
	let authChecking = $state(true);
	let authBusy = $state<'login' | 'logout' | null>(null);
	let authError = $state('');
	let authErrorKind = $state<'general' | 'password'>('general');
	let authNotice = $state('');
	let googleConfigured = $state(false);
	let googleLinked = $state<boolean | null>(null);
	let googleBootstrapAvailable = $state(false);
	let googleCallbackResult: GoogleCallbackResult | null = null;
	let googleNavigationPending = $state<'login' | 'link' | null>(null);
	let password = $state('');
	let showPassword = $state(false);
	let passwordInput = $state<HTMLInputElement>();
	let googleLoginLink = $state<HTMLAnchorElement>();
	let setupToken = $state('');
	let setupBusy = $state(false);
	let setupError = $state('');
	let setupTokenInput = $state<HTMLInputElement>();
	let cards = $state<CardView[]>([]);
	let workspaceAccounts = $state<WorkspaceAccount[]>([]);
	let workspaceBonuses = $state<WorkspaceBonus[]>([]);
	let hasLoadedWorkspace = $state(false);
	let plaid = $state<PlaidStatus>({ ...emptyPlaid });
	let loading = $state(true);
	let hasLoadedCards = $state(false);
	let loadError = $state('');
	let dialogMode = $state<DialogMode>(null);
	let editingId = $state<string | null>(null);
	let form = $state<CardForm>(blankForm());
	let formError = $state('');
	let busyAction = $state<
		| 'save'
		| 'save-rewards'
		| 'apply-reward-profile'
		| 'delete'
		| 'connect'
		| 'sync'
		| 'disconnect'
		| 'update'
		| 'enable-history'
		| 'configure-plaid'
		| null
	>(null);
	let deletingId = $state<string | null>(null);
	let financialConnections = $state<FinancialConnection[]>([]);
	let plaidStatusLoading = $state(true);
	let plaidStatusError = $state('');
	let plaidClientId = $state('');
	let plaidSecret = $state('');
	let plaidSetupError = $state('');
	let plaidSetupEditing = $state(false);
	let plaidItemActionId = $state<string | null>(null);
	let historyCard = $state<CardView | null>(null);
	let historyTransactions = $state<CardTransaction[]>([]);
	let historyStatus = $state<TransactionHistoryResponse['status'] | null>(null);
	let historyLastSyncedAt = $state<string | null>(null);
	let historyLoading = $state(false);
	let historyError = $state('');
	let historyCloseButton = $state<HTMLButtonElement>();
	let rewardsCard = $state<CardView | null>(null);
	let rewardsForm = $state<RewardsForm>(blankRewardsForm());
	let rewardsError = $state('');
	let rewardsEditing = $state(false);
	let rewardProfileSelection = $state('');
	let rewardsFirstField = $state<HTMLInputElement>();
	let rewardsCloseButton = $state<HTMLButtonElement>();
	let calendarDialogOpen = $state(false);
	let calendarCloseButton = $state<HTMLButtonElement>();
	let recentActivityByCard = $state<Record<string, CardTransaction[]>>({});
	let rewardCategorySpendingByCard = $state<
		Record<string, Record<string, CardRewardCategorySpend>>
	>({});
	let recentActivityLoadingByCard = $state<Record<string, boolean>>({});
	let recentActivityErrorByCard = $state<Record<string, boolean>>({});
	let notice = $state('');
	let noticeKind = $state<NoticeKind>('success');
	let firstField = $state<HTMLInputElement>();
	let dialogElement = $state<HTMLDivElement>();
	let previouslyFocused = $state<HTMLElement>();
	let previousBodyOverflow = $state('');
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let clockTimer: ReturnType<typeof setInterval> | undefined;
	let plaidScriptPromise: Promise<void> | null = null;
	let activePlaidHandler: PlaidHandler | null = null;
	let setupAbortController: AbortController | null = null;
	let pageMounted = false;
	let sessionCheckInFlight = false;
	let privateStateEpoch = 0;
	let recentActivityLoadVersion = 0;
	let nowTick = $state(Date.now());
	const googleLoginAvailable = $derived(canOfferGoogleLogin(authMode, googleConfigured));
	const googleOnlyMode = $derived(isGoogleOnlyCloudMode(authMode, authenticationMode));
	const passwordLoginAvailable = $derived(canShowPasswordLogin(authMode, authenticationMode));
	const googleBootstrapVisible = $derived(
		canShowGoogleBootstrap(authMode, authenticationMode, googleBootstrapAvailable)
	);
	const showOnboardingHero = $derived(
		hasLoadedCards &&
			hasLoadedWorkspace &&
			cards.length === 0 &&
			workspaceAccounts.length === 0 &&
			workspaceBonuses.length === 0
	);
	const activeWorkspaceBonuses = $derived(
		workspaceBonuses.filter((bonus) =>
			['planned', 'active', 'qualified', 'pending'].includes(bonus.status)
		)
	);
	const activeBonusValueCents = $derived(
		activeWorkspaceBonuses.reduce((total, bonus) => total + (bonus.rewardCents ?? 0), 0)
	);

	const interestSavingTargets = $derived(
		cards.map((card) => interestSavingTarget(card.statementBalanceCents, card.currentBalanceCents))
	);
	const totalInterestSavingCents = $derived(
		interestSavingTargets.reduce((total, target) => total + (target.amountCents ?? 0), 0)
	);
	const knownInterestSavingCount = $derived(
		interestSavingTargets.filter((target) => target.amountCents !== null).length
	);
	const estimatedInterestSavingCount = $derived(
		interestSavingTargets.filter((target) => target.source === 'current').length
	);
	const dueSoonCount = $derived(cards.filter((card) => isDueSoon(card)).length);
	const calendarCards = $derived(
		cards
			.filter((card): card is CardView & { dueDate: string } => Boolean(card.dueDate))
			.toSorted((left, right) => left.dueDate.localeCompare(right.dueDate))
	);
	const nextCard = $derived(
		cards
			.filter((card) => card.dueDate && daysUntil(card.dueDate) >= 0)
			.toSorted((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0] ?? null
	);
	const nextBonusDeadline = $derived(
		activeWorkspaceBonuses
			.filter((bonus) => bonus.requirementDeadline && daysUntil(bonus.requirementDeadline) >= 0)
			.toSorted((left, right) =>
				(left.requirementDeadline ?? '').localeCompare(right.requirementDeadline ?? '')
			)[0] ?? null
	);
	const nextWorkspaceDeadline = $derived.by(() => {
		const cardDate = nextCard?.dueDate ?? null;
		const bonusDate = nextBonusDeadline?.requirementDeadline ?? null;
		if (cardDate && (!bonusDate || cardDate <= bonusDate)) {
			return { date: cardDate, label: `${nextCard?.nickname ?? 'Card'} payment` };
		}
		if (bonusDate) return { date: bonusDate, label: `${nextBonusDeadline?.name} requirement` };
		return null;
	});
	onMount(() => {
		pageMounted = true;
		const shouldCleanCallbackUrl = new URL(window.location.href).searchParams.has('google');
		const settingsAnchor =
			currentSection === 'settings' &&
			(window.location.hash === '#plaid-setup' || window.location.hash === '#plaid-connections')
				? window.location.hash.slice(1)
				: null;
		googleCallbackResult = readGoogleCallbackResult();
		void initializeAuth().finally(async () => {
			// SvelteKit's root is not assigned when onMount begins. Shallow routing is safe
			// after the asynchronous session initialization yields back to the router.
			if (pageMounted && shouldCleanCallbackUrl) replaceState(resolve('/'), {});
			if (pageMounted && settingsAnchor) {
				await tick();
				document.getElementById(settingsAnchor)?.scrollIntoView({ block: 'start' });
			}
		});
		document.addEventListener('visibilitychange', handleVisibilityChange);
		clockTimer = setInterval(() => {
			nowTick = Date.now();
		}, 60_000);

		return () => {
			pageMounted = false;
			setupAbortController?.abort();
			setupAbortController = null;
			setupToken = '';
			if (noticeTimer) clearTimeout(noticeTimer);
			if (clockTimer) clearInterval(clockTimer);
			if (dialogMode || historyCard || rewardsCard || calendarDialogOpen) {
				document.body.style.overflow = previousBodyOverflow;
			}
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	function blankForm(): CardForm {
		return {
			nickname: '',
			issuer: '',
			last4: '',
			statementBalance: '',
			minimumPayment: '',
			currentBalance: '',
			dueDate: '',
			statementDate: '',
			autopayEnabled: false
		};
	}

	function blankRewardsForm(): RewardsForm {
		return {
			programName: '',
			rewardValue: '',
			rewardType: 'points',
			baseRate: 1,
			categories: []
		};
	}

	function rewardsFormFromCard(card: CardView): RewardsForm {
		return {
			programName: card.rewardProgramName ?? '',
			rewardValue: centsToInput(card.rewardValueCents),
			rewardType: card.rewardType ?? 'points',
			baseRate: card.rewardBaseRate ?? 1,
			categories: card.rewardCategories.map((category) => ({
				...category,
				multiplier: category.multiplier ?? '',
				matchCategory: category.matchCategory ?? ''
			}))
		};
	}

	function selectableRewardProfiles(card: CardView): AutomaticCardRewardProfile[] {
		const identity = `${card.issuer ?? ''} ${card.nickname}`;
		if (/\b(american\s+express|amex|blue\s+cash)\b/i.test(identity)) {
			return AUTOMATIC_CARD_REWARD_PROFILES.filter(
				(profile) => profile.issuer === 'American Express'
			);
		}
		if (/\b(chase|jpmorgan)\b/i.test(identity)) {
			return AUTOMATIC_CARD_REWARD_PROFILES.filter((profile) => profile.issuer === 'Chase');
		}
		if (/\bu\.?\s*s\.?\s*bank\b/i.test(identity)) {
			return AUTOMATIC_CARD_REWARD_PROFILES.filter((profile) => profile.issuer === 'U.S. Bank');
		}
		if (/\bvenmo\b/i.test(identity)) {
			return AUTOMATIC_CARD_REWARD_PROFILES.filter((profile) => profile.issuer === 'Venmo');
		}
		return AUTOMATIC_CARD_REWARD_PROFILES;
	}

	function isGenericPlaidCardName(name: string): boolean {
		return /^\s*(?:credit\s+card|visa|mastercard|american\s+express|card)(?:\s*(?:[-–—•·*]+\s*)*\d{4})?\s*$/i.test(
			name
		);
	}

	function specificProviderProductName(card: CardView): string | null {
		const name = card.providerProductName?.trim();
		return name && !isGenericPlaidCardName(name) ? name : null;
	}

	async function requestJson<T>(
		url: string,
		init: RequestInit = {},
		options: RequestOptions = {}
	): Promise<T> {
		const requestEpoch = options.privateEpoch ?? privateStateEpoch;
		const headers = new Headers(init.headers);
		headers.set('Accept', 'application/json');
		if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

		const response = await fetch(url, {
			...init,
			headers,
			credentials: 'same-origin',
			cache: 'no-store'
		});

		const payload = await response.json().catch(() => null);
		if (
			response.status === 401 &&
			options.handleUnauthorized !== false &&
			isPrivateEpochCurrent(requestEpoch)
		) {
			lockCloudSession('Your session expired. Sign in to continue.');
		}
		if (!response.ok) {
			const detail =
				typeof payload?.error === 'string'
					? payload.error
					: typeof payload?.error?.message === 'string'
						? payload.error.message
						: typeof payload?.message === 'string'
							? payload.message
							: `Request failed (${response.status})`;
			throw new Error(detail);
		}

		return payload as T;
	}

	async function initializeAuth(): Promise<void> {
		authChecking = true;
		authError = '';
		authErrorKind = 'general';

		try {
			const session = await requestJson<AuthSession>(
				resolve('/api/auth/session'),
				{},
				{ handleUnauthorized: false }
			);
			authMode = session.mode;
			authenticationMode = session.authMode;
			googleConfigured = session.google.configured;
			googleLinked = session.google.linked;
			googleBootstrapAvailable = session.google.bootstrapAvailable;
			authenticated = session.mode === 'local' || session.authenticated;
			if (session.mode === 'cloud' && !session.authenticated) {
				void tick().then(() => {
					if (googleLoginAvailable) googleLoginLink?.focus();
					else if (passwordLoginAvailable) passwordInput?.focus();
				});
			} else {
				loadDashboardData();
			}
			showGoogleCallbackResult();
		} catch (error) {
			authMode = null;
			authenticated = false;
			authError = readableError(error, 'ChipDue could not verify this private session.');
		} finally {
			authChecking = false;
		}
	}

	async function revalidateCloudSession(): Promise<void> {
		if (authMode !== 'cloud' || !authenticated || authBusy || sessionCheckInFlight) return;
		const epoch = privateStateEpoch;
		sessionCheckInFlight = true;
		try {
			const session = await requestJson<AuthSession>(
				resolve('/api/auth/session'),
				{},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			googleConfigured = session.google.configured;
			googleLinked = session.google.linked;
			googleBootstrapAvailable = session.google.bootstrapAvailable;
			authenticationMode = session.authMode;
			if (session.mode === 'cloud' && !session.authenticated) {
				lockCloudSession('Your session expired. Sign in to continue.');
			}
		} catch {
			// A 401 locks the UI in requestJson. Transient network errors leave the current view intact.
		} finally {
			sessionCheckInFlight = false;
		}
	}

	function handleVisibilityChange(): void {
		if (document.visibilityState === 'visible') void revalidateCloudSession();
	}

	function beginGoogleNavigation(event: MouseEvent, intent: 'login' | 'link'): void {
		if (setupBusy) {
			event.preventDefault();
			return;
		}
		setupToken = '';
		setupError = '';
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		if (googleNavigationPending) {
			event.preventDefault();
			return;
		}
		googleNavigationPending = intent;
	}

	function handleWindowPageShow(event: PageTransitionEvent): void {
		if (event.persisted) {
			googleNavigationPending = null;
			setupToken = '';
			setupBusy = false;
		}
	}

	function readGoogleCallbackResult(): GoogleCallbackResult | null {
		const url = new URL(window.location.href);
		const marker = url.searchParams.get('google');
		return parseGoogleCallbackResult(marker);
	}

	function showGoogleCallbackResult(): void {
		const result = authorizeGoogleCallbackResult(
			googleCallbackResult,
			authenticated,
			googleLinked === true
		);
		if (!result) return;
		googleCallbackResult = null;

		if (result === 'error') {
			authErrorKind = 'general';
			const message = googleOnlyMode
				? 'Google sign-in could not be completed. Try again.'
				: 'Google sign-in could not be completed. Try again or use your ChipDue password.';
			if (authenticated) showNotice(message, 'error');
			else authError = message;
			return;
		}

		showNotice(
			result === 'linked'
				? googleOnlyMode
					? 'Google sign-in is ready.'
					: 'Google sign-in is ready. Your ChipDue password remains available for recovery.'
				: 'Signed in with Google.'
		);
	}

	function loadDashboardData(): void {
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		loading = true;
		plaidStatusLoading = true;
		void Promise.all([
			refreshCards(false, epoch),
			refreshPlaidStatus(false, epoch),
			refreshWorkspaceOverview(epoch)
		]);
	}

	async function refreshWorkspaceOverview(expectedEpoch = privateStateEpoch): Promise<void> {
		if (!isPrivateEpochCurrent(expectedEpoch)) return;
		try {
			const [accountPayload, bonusPayload] = await Promise.all([
				requestJson<{ accounts: WorkspaceAccount[] }>(
					resolve('/api/accounts'),
					{},
					{ privateEpoch: expectedEpoch }
				),
				requestJson<{ bonuses: WorkspaceBonus[] }>(
					resolve('/api/bonuses'),
					{},
					{ privateEpoch: expectedEpoch }
				)
			]);
			if (!isPrivateEpochCurrent(expectedEpoch)) return;
			workspaceAccounts = accountPayload.accounts;
			workspaceBonuses = bonusPayload.bonuses;
		} catch {
			// Cards remain usable if the broader workspace summary is temporarily unavailable.
		} finally {
			if (isPrivateEpochCurrent(expectedEpoch)) hasLoadedWorkspace = true;
		}
	}

	async function login(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (authMode !== 'cloud' || authenticationMode !== 'password' || authBusy) return;
		authError = '';
		authErrorKind = 'password';
		authNotice = '';
		if (!password) {
			authError = 'Enter your ChipDue password.';
			passwordInput?.focus();
			return;
		}

		authBusy = 'login';
		try {
			await requestJson<null>(
				resolve('/api/auth/login'),
				{
					method: 'POST',
					body: JSON.stringify({ password })
				},
				{ handleUnauthorized: false }
			);
			password = '';
			showPassword = false;
			authenticated = true;
			googleLinked = null;
			try {
				const session = await requestJson<AuthSession>(
					resolve('/api/auth/session'),
					{},
					{ handleUnauthorized: false }
				);
				if (session.mode === 'cloud' && session.authenticated) {
					authenticationMode = session.authMode;
					googleConfigured = session.google.configured;
					googleLinked = session.google.linked;
					googleBootstrapAvailable = session.google.bootstrapAvailable;
				}
			} catch {
				// The password session remains valid; status is retried when this window regains focus.
			}
			loadDashboardData();
		} catch (error) {
			authError = readableError(error, 'Sign-in failed. Check your password and try again.');
			void tick().then(() => {
				passwordInput?.focus();
				passwordInput?.select();
			});
		} finally {
			authBusy = null;
		}
	}

	async function bootstrapGoogle(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!googleBootstrapVisible || authenticated || setupBusy || googleNavigationPending) return;
		setupError = '';

		if (!isValidSetupToken(setupToken)) {
			setupToken = '';
			setupError = 'Setup could not be completed. Use a fresh one-time setup code and try again.';
			void tick().then(() => setupTokenInput?.focus());
			return;
		}

		setupBusy = true;
		const abortController = new AbortController();
		setupAbortController = abortController;
		const requestPayload = { setupToken };
		let shouldContinue = false;
		setupToken = '';

		try {
			const payload = await requestJson<{ continueTo?: unknown }>(
				resolve('/api/auth/google/bootstrap'),
				{
					method: 'POST',
					body: JSON.stringify(requestPayload),
					signal: abortController.signal
				},
				{ handleUnauthorized: false }
			);
			if (!isApprovedBootstrapContinuation(payload.continueTo)) {
				throw new Error('Invalid setup continuation.');
			}
			shouldContinue = true;
		} catch {
			if (pageMounted) {
				setupError = 'Setup could not be completed. Use a fresh one-time setup code and try again.';
			}
		} finally {
			if (setupAbortController === abortController) setupAbortController = null;
			requestPayload.setupToken = '';
			setupToken = '';
		}

		if (!pageMounted) return;
		if (shouldContinue) {
			window.location.assign(resolve(GOOGLE_BOOTSTRAP_CONTINUE_TO));
			return;
		}

		setupBusy = false;
		void tick().then(() => setupTokenInput?.focus());
	}

	function handleSetupToggle(event: Event): void {
		if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open) {
			void tick().then(() => setupTokenInput?.focus());
		}
	}

	async function logout(): Promise<void> {
		if (authMode !== 'cloud' || authBusy) return;
		authBusy = 'logout';

		try {
			await requestJson<null>(resolve('/api/auth/logout'), { method: 'POST' });
			lockCloudSession('You are safely logged out.');
		} catch (error) {
			if (authenticated) {
				showNotice(readableError(error, 'ChipDue could not log out. Try again.'), 'error');
			}
		} finally {
			authBusy = null;
		}
	}

	function lockCloudSession(message: string): void {
		if (authMode !== 'cloud') return;
		privateStateEpoch += 1;
		authenticated = false;
		googleLinked = null;
		authError = '';
		authErrorKind = 'general';
		authNotice = message;
		password = '';
		showPassword = false;
		clearPrivateUiState();
		void tick().then(() => {
			if (googleLoginAvailable) googleLoginLink?.focus();
			else if (passwordLoginAvailable) passwordInput?.focus();
		});
	}

	function clearPrivateUiState(): void {
		cards = [];
		hasLoadedCards = false;
		workspaceAccounts = [];
		workspaceBonuses = [];
		hasLoadedWorkspace = false;
		plaid = { ...emptyPlaid };
		financialConnections = [];
		loading = true;
		loadError = '';
		plaidStatusLoading = true;
		plaidStatusError = '';
		plaidClientId = '';
		plaidSecret = '';
		plaidSetupError = '';
		plaidSetupEditing = false;
		dialogMode = null;
		editingId = null;
		form = blankForm();
		formError = '';
		busyAction = null;
		deletingId = null;
		plaidItemActionId = null;
		historyCard = null;
		historyTransactions = [];
		historyStatus = null;
		historyLastSyncedAt = null;
		historyLoading = false;
		historyError = '';
		historyCloseButton = undefined;
		rewardsCard = null;
		rewardsForm = blankRewardsForm();
		rewardsError = '';
		rewardsEditing = false;
		rewardProfileSelection = '';
		rewardsFirstField = undefined;
		rewardsCloseButton = undefined;
		calendarDialogOpen = false;
		calendarCloseButton = undefined;
		recentActivityByCard = {};
		rewardCategorySpendingByCard = {};
		recentActivityLoadingByCard = {};
		recentActivityErrorByCard = {};
		recentActivityLoadVersion += 1;
		setupToken = '';
		setupBusy = false;
		setupError = '';
		notice = '';
		firstField = undefined;
		dialogElement = undefined;
		previouslyFocused = undefined;
		if (noticeTimer) clearTimeout(noticeTimer);
		if (activePlaidHandler) {
			try {
				activePlaidHandler.destroy();
			} catch {
				// Session locking continues even if a third-party handler cannot clean itself up.
			}
			activePlaidHandler = null;
		}
		if (typeof document !== 'undefined') {
			document.body.style.overflow = previousBodyOverflow;
			document
				.querySelectorAll('script[data-carddue-plaid-link]')
				.forEach((script) => script.remove());
		}
		if (typeof window !== 'undefined') {
			try {
				delete (window as Window & { Plaid?: PlaidFactory }).Plaid;
			} catch {
				// The signed-out API remains inaccessible even if a third-party global is non-configurable.
			}
		}
		plaidScriptPromise = null;
	}

	function isPrivateEpochCurrent(epoch: number): boolean {
		return (
			epoch === privateStateEpoch &&
			(authMode === 'local' || (authMode === 'cloud' && authenticated))
		);
	}

	async function refreshCards(quiet = false, expectedEpoch = privateStateEpoch): Promise<boolean> {
		if (!isPrivateEpochCurrent(expectedEpoch)) return false;
		if (!quiet) loading = true;
		loadError = '';

		try {
			const payload = await requestJson<CardsResponse | CardView[]>(
				resolve('/api/cards'),
				{},
				{ privateEpoch: expectedEpoch }
			);
			if (!isPrivateEpochCurrent(expectedEpoch)) return false;
			cards = Array.isArray(payload) ? payload : (payload.cards ?? []);
			if (!Array.isArray(payload) && payload.connections) {
				plaid = {
					...plaid,
					connectedItems: payload.connections.connected,
					lastSyncedAt: payload.connections.lastSyncedAt
				};
			}
			void refreshRecentActivity(cards, expectedEpoch);
			hasLoadedCards = true;
			return true;
		} catch (error) {
			if (!isPrivateEpochCurrent(expectedEpoch)) return false;
			loadError = readableError(error, 'ChipDue could not read its private database.');
			return false;
		} finally {
			if (isPrivateEpochCurrent(expectedEpoch)) loading = false;
		}
	}

	async function refreshRecentActivity(
		cardViews: CardView[],
		expectedEpoch = privateStateEpoch
	): Promise<void> {
		if (!isPrivateEpochCurrent(expectedEpoch)) return;
		const loadVersion = ++recentActivityLoadVersion;
		const eligibleCards = cardViews.filter(
			(card) => card.source === 'connected' && card.transactionHistoryEnabled
		);
		recentActivityByCard = {};
		rewardCategorySpendingByCard = {};
		recentActivityErrorByCard = {};
		recentActivityLoadingByCard = Object.fromEntries(eligibleCards.map((card) => [card.id, true]));

		await Promise.all(
			eligibleCards.map(async (card) => {
				try {
					const endpoint = `${resolve('/api/cards/[id]/transactions', { id: card.id })}?limit=${RECENT_ACTIVITY_LIMIT}`;
					const payload = await requestJson<TransactionHistoryResponse>(
						endpoint,
						{},
						{ privateEpoch: expectedEpoch }
					);
					if (!isPrivateEpochCurrent(expectedEpoch) || loadVersion !== recentActivityLoadVersion) {
						return;
					}
					recentActivityByCard = {
						...recentActivityByCard,
						[card.id]: payload.transactions
					};
					rewardCategorySpendingByCard = {
						...rewardCategorySpendingByCard,
						[card.id]: Object.fromEntries(
							(payload.rewardCategorySpending ?? []).map((spending) => [
								spending.categoryId,
								spending
							])
						)
					};
				} catch {
					if (!isPrivateEpochCurrent(expectedEpoch) || loadVersion !== recentActivityLoadVersion) {
						return;
					}
					recentActivityErrorByCard = { ...recentActivityErrorByCard, [card.id]: true };
				} finally {
					if (isPrivateEpochCurrent(expectedEpoch) && loadVersion === recentActivityLoadVersion) {
						recentActivityLoadingByCard = {
							...recentActivityLoadingByCard,
							[card.id]: false
						};
					}
				}
			})
		);
	}

	async function refreshPlaidStatus(
		quiet = false,
		expectedEpoch = privateStateEpoch
	): Promise<boolean> {
		if (!isPrivateEpochCurrent(expectedEpoch)) return false;
		if (!quiet) plaidStatusLoading = true;
		plaidStatusError = '';

		try {
			const [payload, connectionPayload] = await Promise.all([
				requestJson<PlaidStatusResponse>(
					resolve('/api/plaid/status'),
					{},
					{ privateEpoch: expectedEpoch }
				),
				requestJson<FinancialConnectionsResponse>(
					resolve('/api/connections'),
					{},
					{ privateEpoch: expectedEpoch }
				)
			]);
			if (!isPrivateEpochCurrent(expectedEpoch)) return false;
			financialConnections = connectionPayload.connections ?? [];
			const lastSyncedAt =
				financialConnections
					.map((connection) => connection.lastSyncedAt)
					.filter((value): value is string => value !== null)
					.toSorted()
					.at(-1) ?? null;
			plaid = {
				configured: payload.configured,
				source: payload.source,
				environment: payload.environment,
				alternatingTeams: payload.alternatingTeams,
				nextConnectionTeam: payload.nextConnectionTeam,
				connectedItems: financialConnections.length,
				lastSyncedAt
			};
			return true;
		} catch (error) {
			if (!isPrivateEpochCurrent(expectedEpoch)) return false;
			plaidStatusError = readableError(error, 'Connection details are unavailable.');
			return false;
		} finally {
			if (isPrivateEpochCurrent(expectedEpoch)) plaidStatusLoading = false;
		}
	}

	function readableError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message ? error.message : fallback;
	}

	function showNotice(message: string, kind: NoticeKind = 'success'): void {
		if (authMode === 'cloud' && !authenticated) return;
		notice = message;
		noticeKind = kind;
		if (noticeTimer) clearTimeout(noticeTimer);
		noticeTimer = setTimeout(() => {
			notice = '';
		}, 5000);
	}

	function formatMoney(cents: number | null): string {
		return cents === null ? 'Not reported' : money.format(cents / 100);
	}

	function formatAnnualSpendCap(cents: number): string {
		return `${wholeDollarMoney.format(cents / 100)} annual spend cap`;
	}

	function formatRewardCategorySpending(spending: CardRewardCategorySpend): string {
		return `${compactMoney.format(spending.spentCents / 100)} of ${wholeDollarMoney.format(spending.capCents / 100)} spent in ${spending.year}`;
	}

	function rewardCategorySpendPercent(spending: CardRewardCategorySpend): number {
		return Math.min(100, Math.round((spending.spentCents / spending.capCents) * 100));
	}

	function formatDate(value: string | null): string {
		if (!value) return 'Not set';
		const datePart = value.slice(0, 10);
		const [year, month, day] = datePart.split('-').map(Number);
		if (!year || !month || !day) return 'Not set';
		return fullDate.format(new Date(year, month - 1, day));
	}

	function formatTransactionAmount(transaction: CardTransaction): string {
		const amount = new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: transaction.currency,
			minimumFractionDigits: 2
		}).format(Math.abs(transaction.amountCents) / 100);
		return transaction.amountCents < 0 ? `−${amount}` : amount;
	}

	function transactionCategory(transaction: CardTransaction): string {
		const label = (value: string) =>
			value
				.toLowerCase()
				.split('_')
				.map((part) => (part === 'and' ? '&' : part.charAt(0).toUpperCase() + part.slice(1)))
				.join(' ');
		const primary = transaction.categoryPrimary;
		const detailed = transaction.categoryDetailed;
		if (!primary && !detailed) return transaction.pending ? 'Pending' : 'Posted';
		if (!primary || !detailed) return label(detailed ?? primary ?? '');
		const detailSuffix = detailed.startsWith(`${primary}_`)
			? detailed.slice(primary.length + 1)
			: detailed;
		return detailSuffix ? `${label(primary)} · ${label(detailSuffix)}` : label(primary);
	}

	function daysUntil(value: string | null): number {
		if (!value) return Number.POSITIVE_INFINITY;
		const [year, month, day] = value.slice(0, 10).split('-').map(Number);
		if (!year || !month || !day) return Number.POSITIVE_INFINITY;
		const now = new Date(nowTick);
		const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
		return Math.round((Date.UTC(year, month - 1, day) - today) / 86_400_000);
	}

	function isOverdue(card: CardView): boolean {
		if (card.isOverdue !== null) return card.isOverdue;
		return daysUntil(card.dueDate) < 0 && (card.minimumPaymentCents ?? 0) > 0;
	}

	function isDueSoon(card: CardView): boolean {
		const days = daysUntil(card.dueDate);
		return isOverdue(card) || (days < 0 && card.isOverdue !== false) || (days >= 0 && days <= 7);
	}

	function dueStatus(card: CardView): {
		label: string;
		tone: 'neutral' | 'good' | 'warn' | 'danger';
	} {
		if (!card.dueDate) return { label: 'Date needed', tone: 'neutral' };
		const days = daysUntil(card.dueDate);
		if (isOverdue(card)) return { label: 'Past due', tone: 'danger' };
		if (days < 0 && card.isOverdue === null) {
			return { label: 'Past date · check status', tone: 'warn' };
		}
		if (days < 0) return { label: 'Date passed', tone: 'neutral' };
		if (days === 0) return { label: 'Due today', tone: 'danger' };
		if (days === 1) return { label: 'Due tomorrow', tone: 'warn' };
		if (days <= 7) return { label: `Due in ${days} days`, tone: 'warn' };
		return { label: `Due in ${days} days`, tone: 'good' };
	}

	function ageLabel(
		value: string | null | undefined,
		action: 'Updated' | 'Synced' = 'Updated'
	): string {
		if (!value) return action === 'Synced' ? 'Never synced' : 'Update time unavailable';
		const timestamp = new Date(value).getTime();
		if (!Number.isFinite(timestamp)) return `${action} time unavailable`;
		const elapsed = Math.max(0, nowTick - timestamp);
		const minutes = Math.floor(elapsed / 60_000);
		if (minutes < 1) return `${action} just now`;
		if (minutes < 60) return `${action} ${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${action} ${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${action} ${days}d ago`;
	}

	function cardSubtitle(card: CardView): string {
		const parts = [card.issuer, card.last4 ? `•••• ${card.last4}` : null];
		return parts.filter(Boolean).join(' · ') || 'Credit card';
	}

	function centsToInput(cents: number | null): string {
		return cents === null ? '' : (cents / 100).toFixed(2);
	}

	async function openAddDialog(): Promise<void> {
		if (busyAction) return;
		prepareDialog();
		editingId = null;
		form = blankForm();
		formError = '';
		dialogMode = 'add';
		await tick();
		firstField?.focus();
	}

	async function openEditDialog(card: CardView): Promise<void> {
		if (card.source !== 'manual' || busyAction) return;
		prepareDialog();
		editingId = card.id;
		form = {
			nickname: card.nickname,
			issuer: card.issuer ?? '',
			last4: card.last4 ?? '',
			statementBalance: centsToInput(card.statementBalanceCents),
			minimumPayment: centsToInput(card.minimumPaymentCents),
			currentBalance: centsToInput(card.currentBalanceCents),
			dueDate: card.dueDate?.slice(0, 10) ?? '',
			statementDate: card.statementDate?.slice(0, 10) ?? '',
			autopayEnabled: card.autopayEnabled
		};
		formError = '';
		dialogMode = 'edit';
		await tick();
		firstField?.focus();
	}

	function prepareDialog(): void {
		previouslyFocused =
			document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}

	function dismissDialog(): void {
		const focusTarget = previouslyFocused;
		if (busyAction === 'save') return;
		dialogMode = null;
		editingId = null;
		formError = '';
		document.body.style.overflow = previousBodyOverflow;
		previouslyFocused = undefined;
		void tick().then(() => focusTarget?.focus());
	}

	function closeDialog(): void {
		dismissDialog();
	}

	async function openRewardsDialog(card: CardView): Promise<void> {
		if (busyAction) return;
		prepareDialog();
		rewardsCard = card;
		rewardsForm = rewardsFormFromCard(card);
		rewardsError = '';
		rewardsEditing = false;
		rewardProfileSelection = '';
		await tick();
		rewardsCloseButton?.focus();
	}

	async function editRewardsManually(): Promise<void> {
		rewardsEditing = true;
		await tick();
		rewardsFirstField?.focus();
	}

	async function applySelectedRewardProfile(): Promise<void> {
		const card = rewardsCard;
		const profileId = rewardProfileSelection;
		const epoch = privateStateEpoch;
		if (!card || !profileId || busyAction || !isPrivateEpochCurrent(epoch)) return;

		busyAction = 'apply-reward-profile';
		rewardsError = '';
		try {
			const payload = await requestJson<{ card: CardView }>(
				resolve('/api/cards/[id]/rewards/profile', { id: card.id }),
				{
					method: 'PUT',
					body: JSON.stringify({ profileId })
				},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			cards = cards.map((entry) => (entry.id === payload.card.id ? payload.card : entry));
			rewardsCard = payload.card;
			rewardsForm = rewardsFormFromCard(payload.card);
			rewardProfileSelection = '';
			void refreshRecentActivity(cards, epoch);
			showNotice(`${payload.card.rewardProfileName ?? 'Card'} rewards populated.`);
		} catch (error) {
			if (!isPrivateEpochCurrent(epoch)) return;
			rewardsError = readableError(error, 'The reward profile could not be applied.');
		} finally {
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	function addRewardCategory(): void {
		if (rewardsForm.categories.length >= 12) return;
		rewardsForm.categories = [
			...rewardsForm.categories,
			{ name: '', multiplier: '', matchCategory: '' }
		];
	}

	function removeRewardCategory(index: number): void {
		rewardsForm.categories = rewardsForm.categories.filter(
			(_category, categoryIndex) => categoryIndex !== index
		);
	}

	function validateRewardsForm(): string | null {
		if (rewardsForm.programName.trim().length > 80) {
			return 'Program name must be 80 characters or fewer.';
		}
		if (!isValidOptionalAmount(rewardsForm.rewardValue)) {
			return 'Reward value must be zero or more.';
		}
		if (inputToRewardRate(rewardsForm.baseRate) === null) {
			return 'Base earning rate must be greater than 0 and no more than 100.';
		}
		for (const category of rewardsForm.categories) {
			const name = category.name.trim();
			const multiplier = inputToRewardRate(category.multiplier);
			const rawMultiplier = String(category.multiplier ?? '').trim();
			if (!name && !rawMultiplier && !category.matchCategory) continue;
			if (!name || multiplier === null) {
				return 'Each reward category needs a name and an earning rate from 0.01 to 100.';
			}
			if (name.length > 60) return 'Category names must be 60 characters or fewer.';
		}
		return null;
	}

	function closeRewardsDialog(): void {
		if (busyAction === 'save-rewards') return;
		const focusTarget = previouslyFocused;
		rewardsCard = null;
		rewardsForm = blankRewardsForm();
		rewardsError = '';
		rewardsEditing = false;
		rewardProfileSelection = '';
		document.body.style.overflow = previousBodyOverflow;
		previouslyFocused = undefined;
		void tick().then(() => focusTarget?.focus());
	}

	async function openCalendarDialog(): Promise<void> {
		if (calendarCards.length === 0) {
			showNotice('Add a due date to a card first.', 'error');
			return;
		}
		prepareDialog();
		calendarDialogOpen = true;
		await tick();
		calendarCloseButton?.focus();
	}

	function closeCalendarDialog(): void {
		const focusTarget = previouslyFocused;
		calendarDialogOpen = false;
		document.body.style.overflow = previousBodyOverflow;
		previouslyFocused = undefined;
		void tick().then(() => focusTarget?.focus());
	}

	async function saveCardRewards(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const card = rewardsCard;
		const epoch = privateStateEpoch;
		if (!card || !isPrivateEpochCurrent(epoch)) return;
		rewardsError = validateRewardsForm() ?? '';
		if (rewardsError) return;

		const rewardCategories = rewardsForm.categories.flatMap((category) => {
			const name = category.name.trim();
			const multiplier = inputToRewardRate(category.multiplier);
			if (!name || multiplier === null) return [];
			return [
				{
					...(category.id ? { id: category.id } : {}),
					name,
					multiplier,
					matchCategory: category.matchCategory || null
				}
			];
		});
		busyAction = 'save-rewards';
		try {
			await requestJson(
				resolve('/api/cards/[id]/rewards', { id: card.id }),
				{
					method: 'PATCH',
					body: JSON.stringify({
						rewardProgramName: rewardsForm.programName.trim() || null,
						rewardValueCents: inputToCents(rewardsForm.rewardValue),
						rewardType: rewardsForm.rewardType,
						rewardBaseRate: inputToRewardRate(rewardsForm.baseRate),
						rewardCategories
					})
				},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const focusTarget = previouslyFocused;
			rewardsCard = null;
			rewardsForm = blankRewardsForm();
			rewardsEditing = false;
			rewardProfileSelection = '';
			document.body.style.overflow = previousBodyOverflow;
			previouslyFocused = undefined;
			const refreshed = await refreshCards(true, epoch);
			if (!isPrivateEpochCurrent(epoch)) return;
			showNotice(
				refreshed
					? 'Card rewards updated.'
					: 'Card rewards updated, but the dashboard could not refresh.',
				refreshed ? 'success' : 'error'
			);
			focusTarget?.focus();
		} catch (error) {
			if (!isPrivateEpochCurrent(epoch)) return;
			rewardsError = readableError(error, 'Card rewards could not be saved.');
		} finally {
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	async function openTransactionHistory(card: CardView): Promise<void> {
		if (card.source !== 'connected' || !card.transactionHistoryEnabled || busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		if (historyCard?.id !== card.id) prepareDialog();
		historyCard = card;
		historyTransactions = [];
		historyStatus = card.transactionHistoryStatus;
		historyLastSyncedAt = card.lastSyncedAt ?? null;
		historyError = '';
		historyLoading = true;
		await tick();
		historyCloseButton?.focus();

		try {
			const payload = await requestJson<TransactionHistoryResponse>(
				resolve('/api/cards/[id]/transactions', { id: card.id }),
				{},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch) || historyCard?.id !== card.id) return;
			historyTransactions = payload.transactions;
			historyStatus = payload.status;
			historyLastSyncedAt = payload.lastSyncedAt;
		} catch (error) {
			if (isPrivateEpochCurrent(epoch) && historyCard?.id === card.id) {
				historyError = readableError(error, 'Transaction history could not be loaded.');
			}
		} finally {
			if (isPrivateEpochCurrent(epoch) && historyCard?.id === card.id) historyLoading = false;
		}
	}

	function retryTransactionHistory(): void {
		if (historyCard) void openTransactionHistory(historyCard);
	}

	function closeTransactionHistory(): void {
		const focusTarget = previouslyFocused;
		historyCard = null;
		historyTransactions = [];
		historyStatus = null;
		historyLastSyncedAt = null;
		historyLoading = false;
		historyError = '';
		document.body.style.overflow = previousBodyOverflow;
		previouslyFocused = undefined;
		void tick().then(() => focusTarget?.focus());
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (!dialogMode && !historyCard && !rewardsCard && !calendarDialogOpen) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			if (historyCard) closeTransactionHistory();
			else if (rewardsCard) closeRewardsDialog();
			else if (calendarDialogOpen) closeCalendarDialog();
			else closeDialog();
			return;
		}
		if (event.key !== 'Tab' || !dialogElement) return;

		const focusable = Array.from(
			dialogElement.querySelectorAll<HTMLElement>(
				'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]'
			)
		).filter((element) => element.offsetParent !== null);
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable.at(-1);
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last?.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	function validateForm(): string | null {
		if (!form.nickname.trim()) return 'Give this card a name.';
		if (form.nickname.trim().length > 80) return 'Card name must be 80 characters or fewer.';
		if (form.issuer.trim().length > 80) return 'Issuer must be 80 characters or fewer.';
		if (form.last4 && !/^\d{4}$/.test(form.last4)) return 'Last four must be exactly four digits.';

		for (const [label, value] of [
			['Statement balance', form.statementBalance],
			['Minimum payment', form.minimumPayment],
			['Current balance', form.currentBalance]
		] as const) {
			if (!isValidOptionalAmount(value)) {
				return `${label} must be zero or more.`;
			}
		}

		return null;
	}

	async function saveCard(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		formError = validateForm() ?? '';
		if (formError) return;

		const payload = {
			nickname: form.nickname.trim(),
			issuer: form.issuer.trim() || null,
			last4: form.last4 || null,
			statementBalanceCents: inputToCents(form.statementBalance),
			minimumPaymentCents: inputToCents(form.minimumPayment),
			currentBalanceCents: inputToCents(form.currentBalance),
			dueDate: form.dueDate || null,
			statementDate: form.statementDate || null,
			autopayEnabled: form.autopayEnabled
		};

		busyAction = 'save';
		try {
			if (dialogMode === 'edit' && editingId) {
				await requestJson(
					resolve('/api/cards/[id]', { id: editingId }),
					{
						method: 'PATCH',
						body: JSON.stringify(payload)
					},
					{ privateEpoch: epoch }
				);
			} else {
				await requestJson(
					resolve('/api/cards'),
					{
						method: 'POST',
						body: JSON.stringify(payload)
					},
					{ privateEpoch: epoch }
				);
			}
			if (!isPrivateEpochCurrent(epoch)) return;
			const action = dialogMode === 'edit' ? 'updated' : 'added';
			const focusTarget = previouslyFocused;
			dialogMode = null;
			editingId = null;
			document.body.style.overflow = previousBodyOverflow;
			previouslyFocused = undefined;
			const refreshed = await refreshCards(true, epoch);
			if (!isPrivateEpochCurrent(epoch)) return;
			showNotice(
				refreshed ? `Card ${action}.` : `Card ${action}, but the dashboard could not refresh.`,
				refreshed ? 'success' : 'error'
			);
			focusTarget?.focus();
		} catch (error) {
			if (!isPrivateEpochCurrent(epoch)) return;
			formError = readableError(error, 'The card could not be saved.');
		} finally {
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	async function deleteCard(card: CardView): Promise<void> {
		if (card.source !== 'manual' || busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		if (!window.confirm(`Delete “${card.nickname}”? This only removes it from ChipDue.`)) return;

		busyAction = 'delete';
		deletingId = card.id;
		try {
			await requestJson(
				resolve('/api/cards/[id]', { id: card.id }),
				{ method: 'DELETE' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = await refreshCards(true, epoch);
			if (!isPrivateEpochCurrent(epoch)) return;
			showNotice(
				refreshed ? 'Card deleted.' : 'Card deleted, but the dashboard could not refresh.',
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (!isPrivateEpochCurrent(epoch)) return;
			showNotice(readableError(error, 'The card could not be deleted.'), 'error');
		} finally {
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				deletingId = null;
			}
		}
	}

	function plaidFactory(): PlaidFactory | undefined {
		return (window as Window & { Plaid?: PlaidFactory }).Plaid;
	}

	function loadPlaidLink(expectedEpoch = privateStateEpoch): Promise<void> {
		if (!isPrivateEpochCurrent(expectedEpoch)) {
			return Promise.reject(new Error('The private session changed.'));
		}
		if (plaidFactory()) return Promise.resolve();
		if (plaidScriptPromise) return plaidScriptPromise;

		const script = document.createElement('script');
		const attempt = new Promise<void>((resolvePromise, reject) => {
			script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
			script.async = true;
			script.referrerPolicy = 'no-referrer';
			script.dataset.cardduePlaidLink = 'true';
			script.onload = () => {
				if (!isPrivateEpochCurrent(expectedEpoch)) {
					script.remove();
					const replacementIsLoading =
						plaidScriptPromise !== null && plaidScriptPromise !== attempt;
					if (!replacementIsLoading) {
						try {
							delete (window as Window & { Plaid?: PlaidFactory }).Plaid;
						} catch {
							// The signed-out API remains inaccessible if the global cannot be removed.
						}
					}
					reject(new Error('The private session changed.'));
					return;
				}
				if (plaidFactory()) resolvePromise();
				else reject(new Error('Plaid Link did not load.'));
			};
			script.onerror = () =>
				reject(new Error('Plaid Link could not be loaded. Check your connection.'));
			document.head.append(script);
		});
		plaidScriptPromise = attempt;
		void attempt.catch(() => {
			script.remove();
			if (plaidScriptPromise === attempt) plaidScriptPromise = null;
		});

		return attempt;
	}

	async function configurePlaid(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (busyAction || !plaidClientId.trim() || !plaidSecret.trim()) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		plaidSetupError = '';
		busyAction = 'configure-plaid';
		const secret = plaidSecret;
		plaidSecret = '';
		try {
			const configuration = await requestJson<
				Pick<PlaidStatus, 'configured' | 'source' | 'environment'>
			>(
				resolve('/api/plaid/config'),
				{
					method: 'PUT',
					body: JSON.stringify({ clientId: plaidClientId.trim(), secret })
				},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			plaid = { ...plaid, ...configuration };
			plaidClientId = '';
			plaidSetupEditing = false;
			await Promise.all([refreshPlaidStatus(true, epoch), refreshCards(true, epoch)]);
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(
					plaid.connectedItems > 0
						? 'Future Plaid connections will alternate between the new and original Teams. Existing connections keep their original account.'
						: 'Your Plaid developer account is ready. You can connect an institution now.'
				);
			}
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				plaidSetupError = readableError(
					error,
					'Plaid could not verify those Production credentials.'
				);
			}
		} finally {
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	async function connectPlaid(): Promise<void> {
		if (busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		if (!plaid.configured) {
			if (currentSection !== 'settings') {
				window.location.assign(resolve('/settings#plaid-setup'));
				return;
			}
			document
				.getElementById('plaid-setup')
				?.scrollIntoView({ behavior: 'smooth', block: 'center' });
			void tick().then(() => document.getElementById('plaid-client-id')?.focus());
			showNotice('Connect your Plaid developer account first.', 'error');
			return;
		}

		busyAction = 'connect';
		try {
			// Plaid's script and the link token are requested only after this explicit action.
			const [, tokenPayload] = await Promise.all([
				loadPlaidLink(epoch),
				requestJson<{ linkToken?: string; link_token?: string }>(
					resolve('/api/plaid/link-token'),
					{ method: 'POST' },
					{ privateEpoch: epoch }
				)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const linkToken = tokenPayload.linkToken ?? tokenPayload.link_token;
			if (!linkToken) throw new Error('The server did not return a Plaid link token.');

			const factory = plaidFactory();
			if (!factory) throw new Error('Plaid Link is unavailable.');

			let handler: PlaidHandler;
			handler = factory.create({
				token: linkToken,
				onSuccess: (publicToken, metadata) => {
					if (!isPrivateEpochCurrent(epoch)) {
						handler.destroy();
						if (activePlaidHandler === handler) activePlaidHandler = null;
						return;
					}
					const institutionName = metadata?.institution?.name?.trim().slice(0, 80) || null;
					void finishPlaidConnection(publicToken, institutionName, handler, epoch);
				},
				onExit: (error) => {
					handler.destroy();
					if (activePlaidHandler === handler) activePlaidHandler = null;
					if (isPrivateEpochCurrent(epoch)) {
						busyAction = null;
						if (error) showNotice('Plaid connection was not completed.', 'error');
					}
				}
			});
			activePlaidHandler = handler;
			handler.open();
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				showNotice(readableError(error, 'Plaid could not be opened.'), 'error');
			}
		}
	}

	async function finishPlaidConnection(
		publicToken: string,
		institutionName: string | null,
		handler: PlaidHandler,
		epoch: number
	): Promise<void> {
		if (!isPrivateEpochCurrent(epoch)) {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			return;
		}
		try {
			const exchanged = await requestJson<{ connection: FinancialConnection }>(
				resolve('/api/plaid/exchange'),
				{
					method: 'POST',
					body: JSON.stringify({ publicToken, institutionName })
				},
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			await requestJson(
				resolve('/api/connections/[id]/transactions/sync', {
					id: exchanged.connection.id
				}),
				{ method: 'POST' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const [cardsRefreshed, statusRefreshed] = await Promise.all([
				refreshCards(true, epoch),
				refreshPlaidStatus(true, epoch),
				refreshWorkspaceOverview(epoch)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = cardsRefreshed && statusRefreshed;
			showNotice(
				refreshed
					? 'Plaid connected. Accounts, cards, and activity are syncing.'
					: 'Plaid connected and synced, but the dashboard could not refresh.',
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(readableError(error, 'Plaid connected, but the first sync failed.'), 'error');
			}
		} finally {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	async function enableTransactionHistory(card: CardView): Promise<void> {
		if (
			busyAction ||
			card.source !== 'connected' ||
			card.connectionProvider !== 'plaid' ||
			card.transactionHistoryEnabled ||
			!card.connectionId
		)
			return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		busyAction = 'enable-history';
		plaidItemActionId = card.connectionId;

		try {
			const [, tokenPayload] = await Promise.all([
				loadPlaidLink(epoch),
				requestJson<{ linkToken?: string; link_token?: string }>(
					resolve('/api/plaid/items/[id]/transactions/update', {
						id: card.connectionId
					}),
					{ method: 'POST' },
					{ privateEpoch: epoch }
				)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const linkToken = tokenPayload.linkToken ?? tokenPayload.link_token;
			if (!linkToken) throw new Error('The server did not return a Plaid consent token.');

			const factory = plaidFactory();
			if (!factory) throw new Error('Plaid Link is unavailable.');

			let handler: PlaidHandler;
			handler = factory.create({
				token: linkToken,
				onSuccess: () => {
					if (!isPrivateEpochCurrent(epoch)) {
						handler.destroy();
						if (activePlaidHandler === handler) activePlaidHandler = null;
						return;
					}
					void finishTransactionHistoryEnable(card, handler, epoch);
				},
				onExit: (error) => {
					handler.destroy();
					if (activePlaidHandler === handler) activePlaidHandler = null;
					if (isPrivateEpochCurrent(epoch)) {
						busyAction = null;
						plaidItemActionId = null;
						if (error) showNotice('Plaid could not enable transaction history.', 'error');
					}
				}
			});
			activePlaidHandler = handler;
			handler.open();
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				plaidItemActionId = null;
				showNotice(readableError(error, 'Plaid consent could not be opened.'), 'error');
			}
		}
	}

	async function finishTransactionHistoryEnable(
		card: CardView,
		handler: PlaidHandler,
		epoch: number
	): Promise<void> {
		if (!isPrivateEpochCurrent(epoch) || !card.connectionId) {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			return;
		}
		try {
			await requestJson(
				resolve('/api/connections/[id]/transactions/sync', {
					id: card.connectionId
				}),
				{ method: 'POST' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = await refreshCards(true, epoch);
			if (!isPrivateEpochCurrent(epoch)) return;
			showNotice(
				refreshed
					? 'Transaction history enabled. The provider may keep filling older activity in the background.'
					: 'Transaction history enabled, but the dashboard could not refresh.',
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(readableError(error, 'Transaction history could not be synced.'), 'error');
			}
		} finally {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				plaidItemActionId = null;
			}
		}
	}

	async function syncConnections(): Promise<void> {
		if (busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		busyAction = 'sync';
		try {
			await requestJson(
				resolve('/api/connections/sync'),
				{ method: 'POST' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const [cardsRefreshed, statusRefreshed] = await Promise.all([
				refreshCards(true, epoch),
				refreshPlaidStatus(true, epoch),
				refreshWorkspaceOverview(epoch)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = cardsRefreshed && statusRefreshed;
			showNotice(
				refreshed
					? 'Connected accounts and cards are up to date.'
					: 'Connections synced, but the dashboard could not refresh.',
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(
					readableError(error, 'Connected accounts and cards could not be synced.'),
					'error'
				);
			}
		} finally {
			if (isPrivateEpochCurrent(epoch)) busyAction = null;
		}
	}

	function connectionLabel(connection: FinancialConnection): string {
		return connection.institutionName?.trim() || 'Connected institution';
	}

	function connectionLogoUrl(connection: FinancialConnection): string | null {
		return (
			cards.find((card) => card.connectionId === connection.id)?.issuerLogoUrl ??
			fallbackInstitutionLogoUrl(connection.institutionName)
		);
	}

	async function disconnectConnection(connection: FinancialConnection): Promise<void> {
		if (busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		const label = connectionLabel(connection);
		const providerName = financialProviderName(connection.provider);
		const confirmed = window.confirm(
			`Disconnect “${label}”?\n\nChipDue will ask ${providerName} to revoke access, then erase this connection and its locally synced accounts, cards, and activity. This cannot be undone.`
		);
		if (!confirmed) return;

		busyAction = 'disconnect';
		plaidItemActionId = connection.id;
		try {
			await requestJson(
				resolve('/api/connections/[id]', { id: connection.id }),
				{ method: 'DELETE' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const [cardsRefreshed, statusRefreshed] = await Promise.all([
				refreshCards(true, epoch),
				refreshPlaidStatus(true, epoch),
				refreshWorkspaceOverview(epoch)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = cardsRefreshed && statusRefreshed;
			showNotice(
				refreshed
					? `${label} disconnected and its local accounts, cards, and activity erased.`
					: `${label} disconnected, but the dashboard could not fully refresh.`,
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(readableError(error, 'The connection could not be disconnected.'), 'error');
			}
		} finally {
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				plaidItemActionId = null;
			}
		}
	}

	async function updatePlaid(connection: FinancialConnection): Promise<void> {
		if (busyAction) return;
		const epoch = privateStateEpoch;
		if (!isPrivateEpochCurrent(epoch)) return;
		busyAction = 'update';
		plaidItemActionId = connection.id;

		try {
			const [, tokenPayload] = await Promise.all([
				loadPlaidLink(epoch),
				requestJson<{ linkToken?: string; link_token?: string }>(
					resolve('/api/plaid/items/[id]/update', { id: connection.id }),
					{ method: 'POST' },
					{ privateEpoch: epoch }
				)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const linkToken = tokenPayload.linkToken ?? tokenPayload.link_token;
			if (!linkToken) throw new Error('The server did not return a Plaid update token.');

			const factory = plaidFactory();
			if (!factory) throw new Error('Plaid Link is unavailable.');

			let handler: PlaidHandler;
			handler = factory.create({
				token: linkToken,
				onSuccess: () => {
					if (!isPrivateEpochCurrent(epoch)) {
						handler.destroy();
						if (activePlaidHandler === handler) activePlaidHandler = null;
						return;
					}
					void finishPlaidUpdate(connection, handler, epoch);
				},
				onExit: (error) => {
					handler.destroy();
					if (activePlaidHandler === handler) activePlaidHandler = null;
					if (isPrivateEpochCurrent(epoch)) {
						busyAction = null;
						plaidItemActionId = null;
						if (error) showNotice('Plaid could not finish updating this connection.', 'error');
					}
				}
			});
			activePlaidHandler = handler;
			handler.open();
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				plaidItemActionId = null;
				showNotice(readableError(error, 'Plaid update could not be opened.'), 'error');
			}
		}
	}

	async function finishPlaidUpdate(
		connection: FinancialConnection,
		handler: PlaidHandler,
		epoch: number
	): Promise<void> {
		if (!isPrivateEpochCurrent(epoch)) {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			return;
		}
		const label = connectionLabel(connection);
		try {
			await requestJson(
				resolve('/api/connections/[id]/sync', { id: connection.id }),
				{ method: 'POST' },
				{ privateEpoch: epoch }
			);
			if (!isPrivateEpochCurrent(epoch)) return;
			const [cardsRefreshed, statusRefreshed] = await Promise.all([
				refreshCards(true, epoch),
				refreshPlaidStatus(true, epoch),
				refreshWorkspaceOverview(epoch)
			]);
			if (!isPrivateEpochCurrent(epoch)) return;
			const refreshed = cardsRefreshed && statusRefreshed;
			showNotice(
				refreshed
					? `${label} accounts and cards were updated and synced.`
					: `${label} was updated, but the dashboard could not fully refresh.`,
				refreshed ? 'success' : 'error'
			);
		} catch (error) {
			if (isPrivateEpochCurrent(epoch)) {
				showNotice(readableError(error, 'The connection updated, but its sync failed.'), 'error');
			}
		} finally {
			handler.destroy();
			if (activePlaidHandler === handler) activePlaidHandler = null;
			if (isPrivateEpochCurrent(epoch)) {
				busyAction = null;
				plaidItemActionId = null;
			}
		}
	}
</script>

<svelte:head>
	<title
		>{currentSection === 'cards'
			? 'Cards — ChipDue'
			: currentSection === 'settings'
				? 'Settings — ChipDue'
				: 'Overview — ChipDue'}</title
	>
</svelte:head>

<svelte:window
	onkeydown={handleWindowKeydown}
	onfocus={revalidateCloudSession}
	onpageshow={handleWindowPageShow}
/>

{#if authChecking}
	<main class="auth-shell auth-loading" aria-busy="true">
		<div class="auth-brand" aria-label="ChipDue">
			<span class="brand-mark" aria-hidden="true">
				<img src={asset('/logo-mark.svg')} alt="" />
			</span>
			<span>ChipDue</span>
		</div>
		<div class="auth-spinner" aria-hidden="true"></div>
		<p role="status">Checking your private session…</p>
	</main>
{:else if authMode === null}
	<main class="auth-shell">
		<section class="auth-card auth-error-card" aria-labelledby="session-error-title">
			<div class="auth-brand">
				<span class="brand-mark" aria-hidden="true">
					<img src={asset('/logo-mark.svg')} alt="" />
				</span>
				<span>ChipDue</span>
			</div>
			<div class="auth-lock error-lock" aria-hidden="true">!</div>
			<h1 id="session-error-title">Private session unavailable</h1>
			<p>{authError || 'ChipDue could not verify this session.'}</p>
			<button class="button button-primary" type="button" onclick={initializeAuth}>Try again</button
			>
		</section>
	</main>
{:else if authMode === 'cloud' && !authenticated}
	<main class="auth-shell">
		<section class="auth-card" aria-labelledby="login-title">
			<div class="auth-brand">
				<span class="brand-mark" aria-hidden="true">
					<img src={asset('/logo-mark.svg')} alt="" />
				</span>
				<span>ChipDue</span>
			</div>

			<div class="auth-lock" aria-hidden="true">
				<svg viewBox="0 0 24 24">
					<rect x="5" y="10" width="14" height="11" rx="3"></rect>
					<path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path>
				</svg>
			</div>
			<h1 id="login-title">Unlock your dashboard</h1>
			<p class="auth-intro">
				{googleOnlyMode
					? 'Sign in with Google to open your private ChipDue account. Your first sign-in creates it automatically.'
					: googleLoginAvailable
						? 'Continue with Google to open your private ChipDue account. The server password remains available for the original account.'
						: 'Enter the password for this ChipDue server.'}
			</p>

			{#if authNotice}
				<p class="auth-notice" role="status">{authNotice}</p>
			{/if}
			{#if authError}
				<p id="login-error" class="login-error auth-login-error" role="alert">{authError}</p>
			{/if}

			{#if googleLoginAvailable}
				<a
					bind:this={googleLoginLink}
					class="button google-button"
					href={resolve('/api/auth/google/start?intent=login')}
					onclick={(event) => beginGoogleNavigation(event, 'login')}
					aria-busy={googleNavigationPending === 'login'}
					aria-disabled={googleNavigationPending !== null || setupBusy ? 'true' : undefined}
					aria-describedby="cloud-privacy-copy"
					data-sveltekit-reload
				>
					<img
						src={asset('/google-sign-in.svg')}
						alt={googleNavigationPending === 'login' ? '' : 'Sign in with Google'}
						width="180"
						height="40"
					/>
					{#if googleNavigationPending === 'login'}
						<span class="google-login-pending">Opening Google…</span>
					{/if}
				</a>
				{#if passwordLoginAvailable}
					<div class="auth-divider" aria-hidden="true"><span>or use recovery password</span></div>
				{/if}
			{/if}

			{#if googleOnlyMode}
				<div class="account-create-note">
					<p>
						<strong>New here?</strong> Use your own Google login. ChipDue keeps your cards, accounts,
						and Plaid credentials separate from every other user.
					</p>
				</div>
			{/if}

			{#if passwordLoginAvailable}
				<form class="login-form" onsubmit={login}>
					<label for="cloud-password">ChipDue password</label>
					<div class="password-field">
						<input
							bind:this={passwordInput}
							bind:value={password}
							id="cloud-password"
							name="password"
							type={showPassword ? 'text' : 'password'}
							autocomplete="current-password"
							autocapitalize="none"
							maxlength="1024"
							spellcheck="false"
							aria-invalid={authError && authErrorKind === 'password' ? 'true' : undefined}
							aria-describedby={authError && authErrorKind === 'password'
								? 'login-error cloud-privacy-copy'
								: 'cloud-privacy-copy'}
							required
						/>
						<button
							type="button"
							onclick={() => (showPassword = !showPassword)}
							aria-pressed={showPassword}
							aria-label={showPassword ? 'Hide password' : 'Show password'}
						>
							{showPassword ? 'Hide' : 'Show'}
						</button>
					</div>
					<button
						class="button login-button"
						class:button-primary={!googleLoginAvailable}
						class:button-secondary={googleLoginAvailable}
						type="submit"
						disabled={authBusy === 'login' || !password}
						aria-busy={authBusy === 'login'}
					>
						{authBusy === 'login'
							? 'Unlocking…'
							: googleLoginAvailable
								? 'Unlock with password'
								: 'Unlock ChipDue'}
					</button>
				</form>
			{/if}

			{#if googleBootstrapVisible}
				<details class="bootstrap-setup" ontoggle={handleSetupToggle}>
					<summary>Set up the first Google account</summary>
					<div class="bootstrap-content">
						<p id="setup-guidance">
							Use this only once on a new server. Paste the private setup code created by the
							deployment owner; ChipDue will bind the Google account that completes sign-in first.
						</p>
						<form class="bootstrap-form" autocomplete="off" onsubmit={bootstrapGoogle}>
							<label for="one-time-setup-code">One-time setup code</label>
							<input
								bind:this={setupTokenInput}
								bind:value={setupToken}
								id="one-time-setup-code"
								type="password"
								autocomplete="off"
								autocapitalize="none"
								autocorrect="off"
								spellcheck="false"
								maxlength="128"
								aria-invalid={setupError ? 'true' : undefined}
								aria-describedby={setupError
									? 'setup-guidance setup-clipboard-warning setup-error'
									: 'setup-guidance setup-clipboard-warning'}
								disabled={setupBusy || googleNavigationPending !== null}
								required
							/>
							<button
								class="button button-secondary"
								type="submit"
								disabled={setupBusy || googleNavigationPending !== null || !setupToken}
								aria-busy={setupBusy}
							>
								{setupBusy ? 'Starting secure setup…' : 'Continue setup'}
							</button>
						</form>
						{#if setupError}
							<p id="setup-error" class="setup-error" role="alert">{setupError}</p>
						{/if}
						<p id="setup-clipboard-warning" class="setup-warning">
							<strong>Keep it private.</strong> ChipDue holds the code only for this submission, but clipboard
							managers may retain it. Clear your clipboard after setup starts. A started code cannot be
							reused.
						</p>
						<p class="setup-lockout-warning">
							<strong>Recovery warning:</strong> Losing access to the bound Google account can lock you
							out. Keep that Google account’s own recovery methods current.
						</p>
					</div>
				</details>
			{/if}

			<div id="cloud-privacy-copy" class="cloud-privacy">
				<svg aria-hidden="true" viewBox="0 0 20 20">
					<path d="M10 2.5 4 5v4.3c0 3.8 2.4 6.8 6 8.2 3.6-1.4 6-4.4 6-8.2V5l-6-2.5Z"></path>
					<path d="m7.5 10 1.7 1.7 3.5-4"></path>
				</svg>
				<p>
					{#if googleOnlyMode || googleLoginAvailable}
						<strong>Google sign-in does not share your financial data.</strong> Choosing Google here reveals
						this site’s domain, your IP address, and sign-in timing. ChipDue requests no email or profile
						details, keeps no Google access token, and stores no financial data in browser storage.
					{:else}
						<strong>Know where your data lives.</strong> Cloud mode stores financial data on the private
						ChipDue server you chose, not solely on this device. Use a deployment you trust over HTTPS.
						ChipDue keeps neither this password nor financial data in browser storage; your server maintains
						the session with an HttpOnly cookie.
					{/if}
				</p>
			</div>
			<p class="auth-footer">No analytics · No external fonts · Open source</p>
		</section>
	</main>
{:else}
	<a class="skip-link" href="#main-content">
		Skip to {currentSection === 'cards'
			? 'cards'
			: currentSection === 'settings'
				? 'settings'
				: 'overview'}
	</a>

	<div class="app-shell" inert={authBusy === 'logout'} aria-busy={authBusy === 'logout'}>
		<WorkspaceHeader
			current={currentSection}
			mode={authMode}
			loggingOut={authBusy === 'logout'}
			onlogout={logout}
		/>

		<main id="main-content">
			<section
				class:hero={showOnboardingHero && currentSection === 'overview'}
				class:dashboard-toolbar={!showOnboardingHero || currentSection !== 'overview'}
				aria-labelledby="page-title"
			>
				{#if showOnboardingHero && currentSection === 'overview'}
					<div class="hero-copy">
						<p class="eyebrow">Your private money command center</p>
						<h1 id="page-title">Keep every dollar moving with purpose.</h1>
						<p class="hero-description">
							Accounts, bonuses, investments, and card deadlines in one calm dashboard—{authMode ===
							'cloud'
								? 'served by your private ChipDue cloud.'
								: 'stored on your machine.'}
						</p>
					</div>
				{:else}
					<div>
						{#if currentSection === 'overview'}
							<h1 id="page-title">Overview</h1>
							<p class="toolbar-description">
								Your money, deadlines, and active offers at a glance.
							</p>
						{:else if currentSection === 'cards'}
							<p class="section-kicker">Credit cards</p>
							<h1 id="page-title">Cards</h1>
							<p class="toolbar-description">Payments, rewards, activity, and due dates.</p>
						{:else}
							<p class="section-kicker">Workspace</p>
							<h1 id="page-title">Settings</h1>
							<p class="toolbar-description">Manage sign-in, privacy, and data connections.</p>
						{/if}
					</div>
				{/if}
				{#if (showOnboardingHero && currentSection === 'overview') || currentSection === 'cards'}
					<div class:hero-action-stack={showOnboardingHero && currentSection === 'overview'}>
						<div
							class:hero-actions={showOnboardingHero && currentSection === 'overview'}
							class:dashboard-actions={!showOnboardingHero || currentSection === 'cards'}
						>
							<button
								class="button button-secondary"
								type="button"
								onclick={openAddDialog}
								disabled={busyAction !== null || loading}
							>
								<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"></path></svg>
								Add manually
							</button>
							<button
								class="button button-primary"
								type="button"
								onclick={connectPlaid}
								disabled={busyAction !== null || loading}
								aria-busy={busyAction === 'connect'}
								aria-describedby="plaid-consent-copy"
								title={plaid.configured ? 'Open Plaid Link' : 'Set up your Plaid account'}
							>
								<svg aria-hidden="true" viewBox="0 0 20 20">
									<path d="M3 8.5 10 5l7 3.5L10 12 3 8.5Z"></path>
									<path d="M5 11v3.5M8.3 12.5V16m3.4-3.5V16m3.3-5v3.5M3 17h14"></path>
								</svg>
								{busyAction === 'connect'
									? 'Connecting…'
									: !plaid.configured
										? 'Set up Plaid'
										: plaid.connectedItems > 0
											? 'Connect another'
											: 'Connect Plaid'}
							</button>
						</div>
						<p
							id="plaid-consent-copy"
							class:plaid-consent={showOnboardingHero && currentSection === 'overview'}
							class:visually-hidden={!showOnboardingHero || currentSection === 'cards'}
						>
							Plaid’s CDN script runs in this page and can access data rendered here. It loads only
							after you choose Connect Plaid. New connections request eligible bank, brokerage, and
							card balances, investment holdings, liabilities, and up to 24 months of transactions.
						</p>
					</div>
				{/if}
			</section>

			{#if loadError && currentSection !== 'settings'}
				<div class="load-error" role="alert">
					<div>
						<strong>Couldn’t load your cards</strong>
						<span>{loadError}</span>
					</div>
					<button type="button" onclick={() => refreshCards()}>Try again</button>
				</div>
			{/if}

			<section
				class="summary-grid"
				class:overview-summary={currentSection === 'overview'}
				hidden={currentSection === 'settings'}
				aria-label={currentSection === 'cards' ? 'Card summary' : 'Financial overview'}
			>
				<article class="summary-card summary-balance">
					<div class="summary-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M3 10h18M7 15h4"
							></path></svg
						>
					</div>
					<div>
						<p>Pay to avoid interest</p>
						<strong>
							{loading || !hasLoadedCards
								? '—'
								: cards.length > 0 && knownInterestSavingCount === 0
									? 'Not reported'
									: formatMoney(totalInterestSavingCents)}
						</strong>
						<span>
							{#if !hasLoadedCards}
								Awaiting local data
							{:else if estimatedInterestSavingCount > 0}
								Includes {estimatedInterestSavingCount} current-balance {estimatedInterestSavingCount ===
								1
									? 'estimate'
									: 'estimates'}
							{:else if knownInterestSavingCount < cards.length}
								{knownInterestSavingCount} of {cards.length} reported
							{:else}
								Across {cards.length} {cards.length === 1 ? 'card' : 'cards'}
							{/if}
						</span>
					</div>
				</article>

				<article class="summary-card summary-due">
					<div class="summary-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><rect x="4" y="5" width="16" height="16" rx="3"></rect><path
								d="M8 3v4M16 3v4M4 10h16"
							></path></svg
						>
					</div>
					<div>
						<p>Due within 7 days</p>
						<strong>{loading || !hasLoadedCards ? '—' : dueSoonCount}</strong>
						<span>
							{!hasLoadedCards
								? 'Awaiting local data'
								: dueSoonCount === 0
									? 'Nothing urgent'
									: 'Worth a quick check'}
						</span>
					</div>
				</article>

				<article class="summary-card summary-next">
					<div class="summary-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg
						>
					</div>
					<div>
						<p>{currentSection === 'cards' ? 'Next card due' : 'Next deadline'}</p>
						<strong class="next-date">
							{loading || !hasLoadedCards
								? '—'
								: formatDate(
										currentSection === 'cards'
											? (nextCard?.dueDate ?? null)
											: (nextWorkspaceDeadline?.date ?? null)
									)}
						</strong>
						<span
							>{hasLoadedCards
								? currentSection === 'cards'
									? (nextCard?.nickname ?? 'No upcoming card payment')
									: (nextWorkspaceDeadline?.label ?? 'No upcoming deadline')
								: 'Awaiting local data'}</span
						>
					</div>
				</article>
			</section>

			<section
				class="workspace-modules"
				aria-label="Financial workspace areas"
				hidden={currentSection !== 'overview'}
			>
				<a class="workspace-module cards-module" href={resolve('/cards')}>
					<span class="module-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M3 10h18M7 15h4"
							></path></svg
						>
					</span>
					<span>
						<strong>Cards</strong>
						<small
							>{hasLoadedCards
								? `${cards.length} tracked · payments, rewards, and activity`
								: 'Payments, rewards, activity, and due dates'}</small
						>
					</span>
					<svg class="module-arrow" aria-hidden="true" viewBox="0 0 20 20"
						><path d="m7 4 6 6-6 6"></path></svg
					>
				</a>
				<a class="workspace-module accounts-module" href={resolve('/accounts')}>
					<span class="module-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><path d="M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18M12 4 3 8h18l-9-4Z"></path></svg
						>
					</span>
					<span>
						<strong>Accounts</strong>
						<small
							>{hasLoadedWorkspace
								? `${workspaceAccounts.length} tracked · bank, business, cash, and brokerage`
								: 'Bank, business, cash, and brokerage accounts'}</small
						>
					</span>
					<svg class="module-arrow" aria-hidden="true" viewBox="0 0 20 20"
						><path d="m7 4 6 6-6 6"></path></svg
					>
				</a>
				<a class="workspace-module bonuses-module" href={resolve('/bonuses')}>
					<span class="module-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><path
								d="M12 3v18M7 7.5C7 5.6 8.8 4 11 4h2c2.2 0 4 1.4 4 3.2 0 4.8-10 1.6-10 6.4C7 15.5 8.8 17 11 17h2c2.2 0 4-1.6 4-3.5"
							></path></svg
						>
					</span>
					<span>
						<strong>Bonuses</strong>
						<small
							>{hasLoadedWorkspace
								? `${activeWorkspaceBonuses.length} active · ${formatMoney(activeBonusValueCents)} potential`
								: 'Requirements, payouts, and safe-to-close dates'}</small
						>
					</span>
					<svg class="module-arrow" aria-hidden="true" viewBox="0 0 20 20"
						><path d="m7 4 6 6-6 6"></path></svg
					>
				</a>
			</section>

			<section
				class="cards-section"
				aria-labelledby="cards-heading"
				hidden={currentSection !== 'cards'}
			>
				<div class="section-heading">
					<div>
						<p class="section-kicker">Credit cards</p>
						<h2 id="cards-heading">Payments &amp; deadlines</h2>
					</div>
					{#if plaid.connectedItems > 0}
						<button
							class="button button-quiet"
							type="button"
							onclick={syncConnections}
							disabled={busyAction !== null}
							aria-busy={busyAction === 'sync'}
						>
							<svg class:spinning={busyAction === 'sync'} aria-hidden="true" viewBox="0 0 20 20">
								<path d="M16 7a6.5 6.5 0 1 0 .2 5.5M16 3v4h-4"></path>
							</svg>
							{busyAction === 'sync' ? 'Syncing…' : 'Sync connections'}
						</button>
					{/if}
				</div>

				{#if loading}
					<div class="card-grid" aria-label="Loading cards" aria-busy="true">
						{#each [0, 1, 2] as skeleton (skeleton)}
							<div class="credit-card skeleton-card" aria-hidden="true">
								<div class="skeleton skeleton-short"></div>
								<div class="skeleton skeleton-title"></div>
								<div class="skeleton skeleton-amount"></div>
								<div class="skeleton skeleton-row"></div>
							</div>
						{/each}
					</div>
				{:else if !hasLoadedCards}
					<div class="empty-state unavailable-state">
						<h3>Dashboard data is unavailable</h3>
						<p>
							ChipDue has not shown any balances or dates. Use “Try again” above after checking the
							local server.
						</p>
					</div>
				{:else if cards.length > 0}
					<div class="card-grid">
						{#each cards as card (card.id)}
							{@const status = dueStatus(card)}
							{@const cardBrand = cardBrandForIssuer(card.issuer)}
							{@const paymentTarget = interestSavingTarget(
								card.statementBalanceCents,
								card.currentBalanceCents
							)}
							<article class:overdue={status.tone === 'danger'} class="credit-card">
								<header class="card-header">
									<div class="card-identity">
										{#if card.issuerLogoUrl}
											<img
												class="issuer-logo"
												src={card.issuerLogoUrl}
												alt={`${card.issuer ?? card.nickname} logo`}
											/>
										{:else if cardBrand}
											<img
												class:issuer-logo-venmo={cardBrand === 'venmo'}
												class="issuer-logo"
												src={fallbackInstitutionLogoUrl(card.issuer)}
												alt={cardBrand === 'venmo' ? 'Venmo' : 'Chase'}
											/>
										{/if}
										<h3>{card.nickname}</h3>
										<p>{cardSubtitle(card)}</p>
									</div>
									<span class:plaid-source={card.source === 'connected'} class="source-pill">
										{card.source === 'connected'
											? financialProviderName(card.connectionProvider)
											: 'Manual'}
									</span>
								</header>

								<div class="balance-block">
									<span>Pay to avoid interest</span>
									<strong class:unavailable={paymentTarget.amountCents === null}>
										{formatMoney(paymentTarget.amountCents)}
									</strong>
									{#if paymentTarget.source === 'statement'}
										<small>
											Latest statement balance{card.currentBalanceCents !== null
												? ` · Current ${formatMoney(card.currentBalanceCents)}`
												: ''}
										</small>
									{:else if paymentTarget.source === 'current'}
										<small>Current-balance estimate · statement not reported</small>
									{:else}
										<small>Check your issuer for the statement balance</small>
									{/if}
								</div>

								<div class="payment-details">
									<div>
										<span>Minimum payment</span>
										<strong>{formatMoney(card.minimumPaymentCents)}</strong>
									</div>
									<div>
										<span>Due date</span>
										<strong>{formatDate(card.dueDate)}</strong>
									</div>
								</div>

								<div class="card-flags">
									<span class="due-pill {status.tone}">{status.label}</span>
									{#if card.autopayEnabled}
										<span class="autopay-pill">
											<svg aria-hidden="true" viewBox="0 0 16 16"
												><path d="m4 8 2.4 2.4L12 5"></path></svg
											>
											Autopay
										</span>
									{/if}
								</div>

								{#if card.rewardProgramName || card.rewardValueCents !== null || card.rewardType || card.rewardBaseRate !== null || card.rewardCategories.length > 0}
									<section class="card-rewards" aria-label={`Rewards for ${card.nickname}`}>
										<header>
											<div>
												<span>Rewards</span>
												<strong>{card.rewardProgramName ?? 'Card rewards'}</strong>
											</div>
											{#if card.rewardValueCents !== null}
												<div class="reward-value">
													<span>Cash value</span>
													<strong>{formatMoney(card.rewardValueCents)}</strong>
												</div>
											{/if}
										</header>
										<div class="reward-summary">
											<div>
												<span>Reward type</span>
												<strong>{rewardTypeLabel(card.rewardType)}</strong>
											</div>
											<div>
												<span
													>{card.rewardType === 'cash_back' ? 'Base rate' : 'Base multiplier'}</span
												>
												<strong>{formatRewardRate(card.rewardBaseRate, card.rewardType)}</strong>
											</div>
										</div>
										{#if card.rewardCategories.length > 0}
											<ul>
												{#each card.rewardCategories as category (category.id)}
													{@const categorySpending =
														rewardCategorySpendingByCard[card.id]?.[category.id]}
													<li>
														<div>
															<span>{category.name}</span>
															{#if category.annualSpendCapCents}
																{#if categorySpending}
																	<small>{formatRewardCategorySpending(categorySpending)}</small>
																	<span
																		class="reward-cap-meter"
																		role="progressbar"
																		aria-label={`${category.name}: ${formatRewardCategorySpending(categorySpending)}`}
																		aria-valuemin="0"
																		aria-valuemax="100"
																		aria-valuenow={rewardCategorySpendPercent(categorySpending)}
																	>
																		<span
																			style:width={`${rewardCategorySpendPercent(categorySpending)}%`}
																		></span>
																	</span>
																{:else}
																	<small>{formatAnnualSpendCap(category.annualSpendCapCents)}</small
																	>
																{/if}
															{/if}
														</div>
														<strong>{formatRewardRate(category.multiplier, card.rewardType)}</strong
														>
													</li>
												{/each}
											</ul>
										{/if}
									</section>
								{/if}

								{#if card.source === 'connected' && card.transactionHistoryEnabled}
									<section
										class="card-activity-preview"
										aria-label={`Recent activity for ${card.nickname}`}
									>
										<header class="activity-preview-header">
											<h4>Recent activity</h4>
											<button
												type="button"
												onclick={() => openTransactionHistory(card)}
												disabled={busyAction !== null}
											>
												View all activity
												<svg aria-hidden="true" viewBox="0 0 16 16"
													><path d="m6 3 5 5-5 5"></path></svg
												>
											</button>
										</header>

										{#if recentActivityLoadingByCard[card.id]}
											<div
												class="activity-preview-loading"
												aria-label="Loading recent activity"
												aria-busy="true"
											>
												<span></span><span></span><span></span>
											</div>
										{:else if recentActivityErrorByCard[card.id]}
											<p class="activity-preview-message">Recent activity is unavailable.</p>
										{:else if recentActivityByCard[card.id]?.length > 0}
											<ul class="activity-preview-list">
												{#each recentActivityByCard[card.id] as transaction (transaction.id)}
													<li>
														<div>
															<strong>{transaction.merchantName ?? transaction.name}</strong>
															<span>
																{new Date(`${transaction.date}T12:00:00`).toLocaleDateString(
																	'en-US',
																	{
																		month: 'short',
																		day: 'numeric'
																	}
																)}
																{transaction.pending ? ' · Pending' : ''}
															</span>
															{#if transaction.rewardEstimate}
																<span class="activity-preview-reward">
																	{formatRewardEstimate(transaction.rewardEstimate)} · {formatRewardRate(
																		transaction.rewardEstimate.rate,
																		transaction.rewardEstimate.type
																	)}{transaction.rewardEstimate.categoryName
																		? ` ${transaction.rewardEstimate.categoryName}`
																		: ' base'}
																</span>
															{/if}
														</div>
														<strong
															class:credit={transaction.amountCents < 0}
															class="activity-preview-amount"
														>
															{formatTransactionAmount(transaction)}
														</strong>
													</li>
												{/each}
											</ul>
										{:else}
											<p class="activity-preview-message">No recent activity yet.</p>
										{/if}
									</section>
								{/if}

								<footer class="card-footer">
									<span>
										<span class="mini-dot"></span>
										{ageLabel(
											card.source === 'connected'
												? (card.lastSyncedAt ?? card.updatedAt)
												: card.updatedAt,
											card.source === 'connected' ? 'Synced' : 'Updated'
										)}
									</span>
									<div class="card-actions">
										<button
											class="rewards-button"
											type="button"
											onclick={() => openRewardsDialog(card)}
											disabled={busyAction !== null}>Reward details</button
										>
										{#if card.source === 'manual'}
											<button
												type="button"
												onclick={() => openEditDialog(card)}
												disabled={busyAction !== null}>Edit</button
											>
											<button
												class="delete-button"
												type="button"
												onclick={() => deleteCard(card)}
												disabled={busyAction !== null}
											>
												{deletingId === card.id ? 'Deleting…' : 'Delete'}
											</button>
										{:else if card.connectionProvider === 'plaid' && !card.transactionHistoryEnabled}
											<button
												class="history-button"
												type="button"
												onclick={() => enableTransactionHistory(card)}
												disabled={busyAction !== null}
												aria-busy={busyAction === 'enable-history' &&
													plaidItemActionId === card.connectionId}
												aria-describedby="plaid-consent-copy"
											>
												{busyAction === 'enable-history' && plaidItemActionId === card.connectionId
													? 'Opening…'
													: 'Enable activity'}
											</button>
										{/if}
									</div>
								</footer>
							</article>
						{/each}
					</div>
				{:else}
					<div class="empty-state">
						<div class="empty-illustration" aria-hidden="true">
							<svg viewBox="0 0 96 72">
								<rect x="12" y="13" width="67" height="44" rx="8"></rect>
								<path d="M12 25h67M21 43h21"></path>
								<circle cx="75" cy="54" r="14"></circle>
								<path d="M75 47v7l5 3"></path>
							</svg>
						</div>
						<h3>Your dashboard is ready</h3>
						<p>
							Add a card manually without connecting a provider, or choose Plaid when you want
							automatic updates.
						</p>
						<button
							class="button button-primary"
							type="button"
							onclick={openAddDialog}
							disabled={busyAction !== null}>Add your first card</button
						>
					</div>
				{/if}
			</section>

			<section
				class="info-grid"
				class:settings-grid={currentSection === 'settings'}
				class:card-tools-grid={currentSection === 'cards'}
				hidden={currentSection === 'overview'}
				aria-label={currentSection === 'settings' ? 'Account settings' : 'Card tools'}
			>
				<article
					id="plaid-connections"
					class="info-panel privacy-panel"
					hidden={currentSection !== 'settings'}
				>
					<div class="panel-icon privacy-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><path d="M12 3 5 6v5c0 4.6 2.8 8.2 7 10 4.2-1.8 7-5.4 7-10V6l-7-3Z"></path><path
								d="m9 12 2 2 4-5"
							></path></svg
						>
					</div>
					<div class="panel-content">
						<p class="section-kicker">Privacy &amp; connections</p>
						<h2>Account and data connections</h2>
						<p>
							ChipDue adds no analytics and stores no financial details in persistent browser
							storage.
							{authMode === 'cloud'
								? ' The server encrypts private records and isolates them to this account.'
								: ''}
							The Plaid Link script is requested only after you press Connect Plaid.
						</p>
						<p
							id={currentSection === 'settings' ? 'plaid-consent-copy' : undefined}
							class="trust-note"
						>
							<strong>Before you connect:</strong> Plaid’s CDN script runs on this page and can access
							data rendered here. Refresh the page after connecting to unload it.
						</p>
						{#if authMode === 'cloud' && googleConfigured}
							<section class="google-access" aria-labelledby="google-access-title">
								<div class="google-access-heading">
									<span class="google-access-icon" aria-hidden="true">
										<svg viewBox="0 0 20 20">
											<circle cx="7.5" cy="10" r="3.5"></circle>
											<path d="M11 10h6m-2 0v2m-2-2v2"></path>
										</svg>
									</span>
									<div>
										<h3 id="google-access-title">Google sign-in</h3>
										<p>
											{googleLinked === true
												? googleOnlyMode
													? 'Ready to use. Google identifies this private ChipDue account.'
													: 'Ready to use. Your ChipDue password remains available for recovery.'
												: googleLinked === false
													? googleOnlyMode
														? 'Initial Google setup has not completed.'
														: 'Link your account while this password-authenticated session is open.'
													: 'Checking account status…'}
										</p>
									</div>
									{#if googleLinked === true}
										<span class="google-ready"><span aria-hidden="true">✓</span> Ready</span>
									{:else if googleLinked === false && authenticationMode === 'password'}
										<a
											class="button google-link-button"
											href={resolve('/api/auth/google/start?intent=link')}
											onclick={(event) => beginGoogleNavigation(event, 'link')}
											aria-busy={googleNavigationPending === 'link'}
											aria-disabled={googleNavigationPending !== null ? 'true' : undefined}
											aria-describedby="google-link-privacy"
											data-sveltekit-reload
										>
											{googleNavigationPending === 'link'
												? 'Opening Google…'
												: 'Link Google account'}
										</a>
									{/if}
								</div>
								<p id="google-link-privacy" class="google-privacy-note">
									Google sees this site’s domain, your IP address, and sign-in timing when you use
									it, but receives no financial data from ChipDue. ChipDue requests no email or
									profile details and does not keep Google tokens.
								</p>
								{#if googleLinked === false && authenticationMode === 'password'}
									<p class="google-setup-note">
										<strong>Deployment note:</strong> Google displays the OAuth support address publicly.
										Use a monitored, non-personal alias or Google Group instead of a personal inbox.
									</p>
								{/if}
							</section>
						{/if}
						<ul class="privacy-list">
							<li>
								<span class="check-mark">✓</span><span
									>{authMode === 'cloud'
										? 'Account, bonus, card, and enabled transaction details are encrypted on your private ChipDue server'
										: 'Account, bonus, card, and enabled transaction details are encrypted in a local database outside this source checkout'}</span
								>
							</li>
							<li>
								<span class="check-mark">✓</span><span>No tracking pixels or external fonts</span>
							</li>
							<li>
								<span class="connection-mark" class:connected={plaid.connectedItems > 0}></span>
								<span>
									{plaid.connectedItems > 0
										? `${plaid.connectedItems} connected ${plaid.connectedItems === 1 ? 'institution' : 'institutions'} · ${ageLabel(plaid.lastSyncedAt, 'Synced')}`
										: plaid.configured
											? 'Plaid is ready but not connected'
											: 'Plaid is not configured'}
								</span>
							</li>
						</ul>

						{#if !plaid.configured || plaidSetupEditing}
							<section id="plaid-setup" class="plaid-setup" aria-labelledby="plaid-setup-title">
								<div class="plaid-setup-heading">
									<div>
										<p class="section-kicker">Your own connection allowance</p>
										<h3 id="plaid-setup-title">
											{plaid.configured
												? 'Change your Plaid credentials'
												: 'Connect your Plaid developer account'}
										</h3>
									</div>
									<span class="plaid-private-badge">Encrypted</span>
								</div>
								<p>
									{plaid.configured
										? 'Future institutions alternate between the newly saved Plaid Team and the original Team. Existing institutions stay securely attached to the Team that created them.'
										: 'Create a free personal Plaid team, enable its Trial plan, then add its Production credentials here. Its ten-Item trial allowance belongs only to you.'}
								</p>
								<a
									class="text-link plaid-dashboard-link"
									href="https://dashboard.plaid.com/signup"
									target="_blank"
									rel="noopener noreferrer"
								>
									Create a Plaid account
									<svg aria-hidden="true" viewBox="0 0 16 16"
										><path d="M6 3h7v7M13 3 5 11M3 6v7h7"></path></svg
									>
								</a>
								<form class="plaid-setup-form" autocomplete="off" onsubmit={configurePlaid}>
									<label class="field">
										<span>Plaid client ID</span>
										<input
											id="plaid-client-id"
											bind:value={plaidClientId}
											name="plaid-client-id"
											autocomplete="off"
											autocapitalize="none"
											spellcheck="false"
											maxlength="128"
											required
										/>
									</label>
									<label class="field">
										<span>Production secret</span>
										<input
											bind:value={plaidSecret}
											name="plaid-production-secret"
											type="password"
											autocomplete="new-password"
											autocapitalize="none"
											spellcheck="false"
											maxlength="256"
											required
										/>
									</label>
									<div class="plaid-setup-actions">
										<button
											class="button button-primary"
											type="submit"
											disabled={busyAction !== null || !plaidClientId.trim() || !plaidSecret.trim()}
											aria-busy={busyAction === 'configure-plaid'}
										>
											{busyAction === 'configure-plaid' ? 'Verifying…' : 'Verify and save'}
										</button>
										{#if plaid.configured}
											<button
												class="button button-secondary"
												type="button"
												disabled={busyAction !== null}
												onclick={() => {
													plaidSetupEditing = false;
													plaidClientId = '';
													plaidSecret = '';
													plaidSetupError = '';
												}}>Cancel</button
											>
										{/if}
									</div>
								</form>
								{#if plaidSetupError}
									<p class="plaid-setup-error" role="alert">{plaidSetupError}</p>
								{/if}
								<small>
									ChipDue encrypts both values on the server and never returns them to your browser.
									You remain responsible for your Plaid account and its terms.
								</small>
							</section>
						{:else if plaid.configured}
							<div class="plaid-personal-ready">
								<span aria-hidden="true">✓</span>
								<div>
									<strong>
										{plaid.source === 'personal'
											? 'Your Plaid developer account is connected'
											: 'Installation Plaid account is connected'}
									</strong>
									{#if plaid.alternatingTeams}
										<small>
											Alternating Plaid Teams · Next: {plaid.nextConnectionTeam === 'original'
												? 'original Team'
												: 'new personal Team'} · Then: {plaid.nextConnectionTeam === 'original'
												? 'new personal Team'
												: 'original Team'}
										</small>
									{:else}
										<small>
											{plaid.source === 'personal'
												? 'Production credentials are encrypted for this ChipDue account only.'
												: 'Switch future institutions to your personal Plaid team without disrupting existing connections.'}
										</small>
									{/if}
								</div>
								<div class="plaid-ready-actions">
									<button
										class="button button-primary"
										type="button"
										disabled={busyAction !== null}
										onclick={connectPlaid}
										aria-busy={busyAction === 'connect'}
									>
										{busyAction === 'connect' ? 'Opening…' : 'Connect institution'}
									</button>
									<button
										class="button button-secondary plaid-replace-button"
										type="button"
										disabled={busyAction !== null}
										onclick={() => {
											plaidSetupEditing = true;
											void tick().then(() => document.getElementById('plaid-client-id')?.focus());
										}}>Change</button
									>
								</div>
							</div>
						{/if}

						{#if plaidStatusLoading}
							<div
								class="connections-loading"
								aria-label="Loading financial connections"
								aria-busy="true"
							>
								<span></span><span></span>
							</div>
						{:else if plaidStatusError}
							<div class="connection-error" role="alert">
								<span>{plaidStatusError}</span>
								<button
									type="button"
									onclick={() => refreshPlaidStatus()}
									disabled={busyAction !== null}>Retry</button
								>
							</div>
						{:else if financialConnections.length > 0}
							<section class="connection-manager" aria-labelledby="connections-heading">
								<div class="connection-heading">
									<h3 id="connections-heading">Connected institutions</h3>
									<span>Manage shared accounts or revoke access</span>
								</div>
								<ul class="connection-list">
									{#each financialConnections as connection (connection.id)}
										{@const institutionLogoUrl = connectionLogoUrl(connection)}
										<li>
											<div class="connection-details">
												{#if institutionLogoUrl}
													<span class="institution-icon institution-logo">
														<img
															src={institutionLogoUrl}
															alt={`${connectionLabel(connection)} logo`}
														/>
													</span>
												{:else}
													<span class="institution-icon" aria-hidden="true">
														<svg viewBox="0 0 20 20">
															<path d="m3 8 7-4 7 4M5 9.5v5M8.3 9.5v5m3.4-5v5m3.3-5v5M3 16.5h14"
															></path>
														</svg>
													</span>
												{/if}
												<span>
													<strong>{connectionLabel(connection)}</strong>
													<small class:attention={connection.status === 'needs_update'}>
														{connection.status === 'needs_update' ? 'Needs attention' : 'Connected'} ·
														{ageLabel(connection.lastSyncedAt, 'Synced')}
													</small>
												</span>
											</div>
											<div class="connection-actions">
												{#if connection.provider === 'plaid'}
													<button
														class="update-connection"
														type="button"
														onclick={() => updatePlaid(connection)}
														disabled={busyAction !== null}
														aria-busy={busyAction === 'update' &&
															plaidItemActionId === connection.id}
														aria-describedby="plaid-consent-copy"
													>
														{busyAction === 'update' && plaidItemActionId === connection.id
															? 'Opening…'
															: connection.status === 'needs_update'
																? 'Repair & manage'
																: 'Manage accounts'}
													</button>
												{/if}
												<button
													class="disconnect-connection"
													type="button"
													onclick={() => disconnectConnection(connection)}
													disabled={busyAction !== null}
													aria-busy={busyAction === 'disconnect' &&
														plaidItemActionId === connection.id}
													aria-label={`Disconnect ${connectionLabel(connection)}`}
												>
													{busyAction === 'disconnect' && plaidItemActionId === connection.id
														? 'Disconnecting…'
														: 'Disconnect'}
												</button>
											</div>
										</li>
									{/each}
								</ul>
							</section>
						{/if}
					</div>
				</article>

				<article class="info-panel calendar-panel" hidden={currentSection !== 'cards'}>
					<div class="panel-icon calendar-icon" aria-hidden="true">
						<svg viewBox="0 0 24 24"
							><rect x="3" y="5" width="18" height="16" rx="3"></rect><path
								d="M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"
							></path></svg
						>
					</div>
					<div class="panel-content">
						<p class="section-kicker">Google Calendar</p>
						<h2>Put due dates on your calendar.</h2>
						<p>Review and save each due date in Google Calendar. Amounts stay private.</p>
						<div class="calendar-actions">
							<button class="button button-secondary" type="button" onclick={openCalendarDialog}>
								<svg aria-hidden="true" viewBox="0 0 20 20"
									><path
										d="M6 2v3M14 2v3M3 8h14M5 4h10a2 2 0 0 1 2 2v10H3V6a2 2 0 0 1 2-2Zm5 7v4m-2-2h4"
									></path></svg
								>
								Add to Google Calendar
							</button>
							<a class="text-link" href={resolve('/api/export/calendar.ics?amounts=0')} download>
								Download .ics instead
								<svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"></path></svg>
							</a>
						</div>
					</div>
				</article>
			</section>
		</main>

		<footer class="site-footer">
			<span>ChipDue</span>
			<span>Open source · No analytics</span>
		</footer>
	</div>

	{#if calendarDialogOpen}
		<div class="dialog-layer">
			<div class="dialog-backdrop"></div>
			<div
				bind:this={dialogElement}
				class="dialog calendar-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="calendar-dialog-title"
				aria-describedby="calendar-dialog-description"
			>
				<header class="dialog-header">
					<div>
						<p class="section-kicker">Google Calendar</p>
						<h2 id="calendar-dialog-title">Add payment due dates</h2>
						<p id="calendar-dialog-description">
							Google will ask you to save each event. ChipDue shares only its date and card name.
						</p>
					</div>
					<button
						bind:this={calendarCloseButton}
						class="icon-button"
						type="button"
						onclick={closeCalendarDialog}
						aria-label="Close Google Calendar events"
					>
						<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"></path></svg>
					</button>
				</header>

				<div class="calendar-dialog-body">
					<div class="calendar-privacy-note">
						<svg aria-hidden="true" viewBox="0 0 20 20"
							><path d="M10 2 4 5v4c0 4 2.5 7 6 9 3.5-2 6-5 6-9V5l-6-3Zm-2 8 1.5 1.5L13 8"
							></path></svg
						>
						<span>Balances, payment amounts, and card numbers are not included.</span>
					</div>
					<ul class="calendar-event-list">
						<!-- eslint-disable svelte/no-navigation-without-resolve -- Google Calendar event drafts use external URLs. -->
						{#each calendarCards as card (card.id)}
							{@const eventUrl = googleCalendarEventUrl(card)}
							{#if eventUrl}
								<li>
									<div>
										<strong>{card.nickname}</strong>
										<span>{formatDate(card.dueDate)}</span>
									</div>
									<a
										class="button button-secondary"
										href={eventUrl}
										target="_blank"
										rel="noopener noreferrer"
									>
										Review event
										<svg aria-hidden="true" viewBox="0 0 20 20"
											><path d="M8 4h8v8m0-8-9 9M5 7H3v10h10v-2"></path></svg
										>
									</a>
								</li>
							{/if}
						{/each}
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
					</ul>
					<footer class="dialog-actions calendar-dialog-actions">
						<a class="text-link" href={resolve('/api/export/calendar.ics?amounts=0')} download>
							Download all as .ics
						</a>
						<button class="button button-quiet" type="button" onclick={closeCalendarDialog}
							>Done</button
						>
					</footer>
				</div>
			</div>
		</div>
	{/if}

	{#if dialogMode}
		<div class="dialog-layer">
			<div class="dialog-backdrop"></div>
			<div
				bind:this={dialogElement}
				class="dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="card-dialog-title"
				aria-describedby="card-dialog-description"
			>
				<header class="dialog-header">
					<div>
						<p class="section-kicker">Manual entry</p>
						<h2 id="card-dialog-title">{dialogMode === 'edit' ? 'Edit card' : 'Add a card'}</h2>
						<p id="card-dialog-description">
							{authMode === 'cloud'
								? 'Saved to your private ChipDue server.'
								: 'Saved only to ChipDue’s local database.'}
							Enter just what you need.
						</p>
					</div>
					<button class="icon-button" type="button" onclick={closeDialog} aria-label="Close dialog">
						<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"></path></svg>
					</button>
				</header>

				<form class="card-form" onsubmit={saveCard} autocomplete="off">
					<div class="form-grid">
						<label class="field field-wide">
							<span>Card name <em>Required</em></span>
							<input
								bind:this={firstField}
								bind:value={form.nickname}
								name="nickname"
								maxlength="80"
								placeholder="Everyday card"
								required
							/>
						</label>

						<label class="field">
							<span>Issuer</span>
							<input
								bind:value={form.issuer}
								name="issuer"
								maxlength="80"
								placeholder="Bank name"
							/>
						</label>

						<label class="field">
							<span>Last four digits</span>
							<input
								bind:value={form.last4}
								name="last4"
								inputmode="numeric"
								maxlength="4"
								pattern={LAST_FOUR_PATTERN}
								placeholder="1234"
							/>
						</label>

						<label class="field">
							<span>Statement balance</span>
							<div class="money-input">
								<span>$</span><input
									bind:value={form.statementBalance}
									name="statementBalance"
									type="number"
									min="0"
									step="0.01"
									inputmode="decimal"
									placeholder="0.00"
								/>
							</div>
						</label>

						<label class="field">
							<span>Minimum payment</span>
							<div class="money-input">
								<span>$</span><input
									bind:value={form.minimumPayment}
									name="minimumPayment"
									type="number"
									min="0"
									step="0.01"
									inputmode="decimal"
									placeholder="0.00"
								/>
							</div>
						</label>

						<label class="field">
							<span>Current balance <small>Optional</small></span>
							<div class="money-input">
								<span>$</span><input
									bind:value={form.currentBalance}
									name="currentBalance"
									type="number"
									min="0"
									step="0.01"
									inputmode="decimal"
									placeholder="0.00"
								/>
							</div>
						</label>

						<label class="field">
							<span>Next due date</span>
							<input bind:value={form.dueDate} name="dueDate" type="date" />
						</label>

						<label class="field">
							<span>Statement date <small>Optional</small></span>
							<input bind:value={form.statementDate} name="statementDate" type="date" />
						</label>
					</div>

					<label class="checkbox-field">
						<input bind:checked={form.autopayEnabled} name="autopayEnabled" type="checkbox" />
						<span>
							<strong>Autopay is enabled</strong>
							<small>This is a reminder only—ChipDue never initiates payments.</small>
						</span>
					</label>

					{#if formError}
						<p class="form-error" role="alert">{formError}</p>
					{/if}

					<footer class="dialog-actions">
						<button
							class="button button-quiet"
							type="button"
							onclick={closeDialog}
							disabled={busyAction === 'save'}>Cancel</button
						>
						<button
							class="button button-primary"
							type="submit"
							disabled={busyAction === 'save'}
							aria-busy={busyAction === 'save'}
						>
							{busyAction === 'save'
								? 'Saving…'
								: dialogMode === 'edit'
									? 'Save changes'
									: 'Add card'}
						</button>
					</footer>
				</form>
			</div>
		</div>
	{/if}

	{#if rewardsCard}
		<div class="dialog-layer">
			<div class="dialog-backdrop"></div>
			<div
				bind:this={dialogElement}
				class="dialog rewards-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="rewards-dialog-title"
				aria-describedby="rewards-dialog-description"
			>
				<header class="dialog-header">
					<div>
						<p class="section-kicker">Card rewards</p>
						<h2 id="rewards-dialog-title">{rewardsCard.nickname}</h2>
						<p id="rewards-dialog-description">
							{rewardsCard.rewardSource === 'automatic'
								? 'Identified automatically from the linked card. No setup is needed.'
								: rewardsCard.rewardType
									? 'Review the earning rules used for activity estimates.'
									: specificProviderProductName(rewardsCard)
										? `Plaid reported “${specificProviderProductName(rewardsCard)}”. ChipDue does not have a verified reward profile for it yet.`
										: isGenericPlaidCardName(rewardsCard.nickname)
											? 'Plaid sent a generic card name. Choose the card once and ChipDue fills every rule.'
											: 'ChipDue has the card name, but does not have a verified reward profile for it yet.'}
						</p>
					</div>
					<button
						bind:this={rewardsCloseButton}
						class="icon-button"
						type="button"
						onclick={closeRewardsDialog}
						disabled={busyAction === 'save-rewards' || busyAction === 'apply-reward-profile'}
						aria-label="Close card rewards"
					>
						<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"></path></svg>
					</button>
				</header>

				{#if !rewardsEditing}
					<div class="reward-details-body">
						{#if rewardsCard.rewardType && rewardsCard.rewardBaseRate !== null}
							{#if rewardsCard.rewardSource === 'automatic'}
								<div class="reward-detected-note">
									<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 10 3 3 7-7"></path></svg>
									<div>
										<strong>Automatically matched</strong>
										<span>{rewardsCard.rewardProfileName ?? rewardsCard.nickname}</span>
									</div>
								</div>
							{/if}

							<section class="reward-profile-summary" aria-label="Detected reward profile">
								<div class="reward-profile-program">
									<span>Rewards program</span>
									<strong>{rewardsCard.rewardProgramName ?? 'Card rewards'}</strong>
								</div>
								<div>
									<span>Reward type</span>
									<strong>{rewardTypeLabel(rewardsCard.rewardType)}</strong>
								</div>
								<div>
									<span
										>{rewardsCard.rewardType === 'cash_back'
											? 'Base rate'
											: 'Base multiplier'}</span
									>
									<strong
										>{formatRewardRate(rewardsCard.rewardBaseRate, rewardsCard.rewardType)}</strong
									>
								</div>
							</section>

							{#if rewardsCard.rewardCategories.length > 0}
								<section
									class="reward-profile-categories"
									aria-labelledby="detected-categories-title"
								>
									<h3 id="detected-categories-title">
										{rewardsCard.rewardCalculation === 'venmo_spend_ranked'
											? 'Automatic spend ranking'
											: 'Bonus categories'}
									</h3>
									<ul>
										{#each rewardsCard.rewardCategories as category (category.id)}
											{@const categorySpending =
												rewardCategorySpendingByCard[rewardsCard.id]?.[category.id]}
											<li>
												<div>
													<span>{category.name}</span>
													{#if category.annualSpendCapCents}
														{#if categorySpending}
															<small>{formatRewardCategorySpending(categorySpending)}</small>
															<span
																class="reward-cap-meter"
																role="progressbar"
																aria-label={`${category.name}: ${formatRewardCategorySpending(categorySpending)}`}
																aria-valuemin="0"
																aria-valuemax="100"
																aria-valuenow={rewardCategorySpendPercent(categorySpending)}
															>
																<span
																	style:width={`${rewardCategorySpendPercent(categorySpending)}%`}
																></span>
															</span>
														{:else}
															<small>{formatAnnualSpendCap(category.annualSpendCapCents)}</small>
														{/if}
													{/if}
												</div>
												<strong
													>{formatRewardRate(category.multiplier, rewardsCard.rewardType)}</strong
												>
											</li>
										{/each}
									</ul>
									{#if rewardsCard.rewardCalculation === 'venmo_spend_ranked'}
										<p>
											ChipDue ranks eligible categories from each statement period and updates every
											transaction estimate automatically.
										</p>
									{/if}
								</section>
							{/if}
						{:else}
							<div class="reward-profile-missing">
								<strong>
									{specificProviderProductName(rewardsCard)
										? `Plaid reported “${specificProviderProductName(rewardsCard)}”`
										: isGenericPlaidCardName(rewardsCard.nickname)
											? `Plaid only returned “${rewardsCard.nickname}”`
											: `No verified profile for “${rewardsCard.nickname}” yet`}
								</strong>
								<p>
									Select the card once. Its program, multipliers, and categories fill automatically.
								</p>
								<div class="reward-profile-picker">
									<label for="reward-profile-selection">Which card is this?</label>
									<select
										id="reward-profile-selection"
										bind:value={rewardProfileSelection}
										disabled={busyAction === 'apply-reward-profile'}
									>
										<option value="">Select your card</option>
										{#each selectableRewardProfiles(rewardsCard) as profile (profile.id)}
											<option value={profile.id}>{profile.cardName}</option>
										{/each}
									</select>
									<button
										class="button button-primary"
										type="button"
										onclick={applySelectedRewardProfile}
										disabled={!rewardProfileSelection || busyAction === 'apply-reward-profile'}
										aria-busy={busyAction === 'apply-reward-profile'}
									>
										{busyAction === 'apply-reward-profile' ? 'Filling…' : 'Fill reward details'}
									</button>
								</div>
							</div>
						{/if}
						{#if rewardsError}
							<p class="form-error" role="alert">{rewardsError}</p>
						{/if}

						<footer class="dialog-actions reward-detail-actions">
							<button class="button button-quiet" type="button" onclick={closeRewardsDialog}
								>Close</button
							>
							{#if rewardsCard.rewardType}
								<button class="button button-secondary" type="button" onclick={editRewardsManually}
									>Edit manually</button
								>
							{/if}
						</footer>
					</div>
				{:else}
					<form class="card-form rewards-form" onsubmit={saveCardRewards} autocomplete="off">
						{#if rewardsCard.rewardSource === 'automatic'}
							<p class="manual-reward-warning">
								Saving here replaces the automatically detected profile for this card.
							</p>
						{/if}
						<div class="form-grid">
							<label class="field">
								<span>Rewards program <small>Optional</small></span>
								<input
									bind:this={rewardsFirstField}
									bind:value={rewardsForm.programName}
									name="rewardProgramName"
									maxlength="80"
									placeholder="Ultimate Rewards"
								/>
							</label>

							<label class="field">
								<span>Reward type</span>
								<select bind:value={rewardsForm.rewardType} name="rewardType">
									<option value="points">Points</option>
									<option value="miles">Miles</option>
									<option value="cash_back">Cash back</option>
								</select>
							</label>

							<label class="field">
								<span>
									{rewardsForm.rewardType === 'cash_back' ? 'Base earning rate' : 'Base multiplier'}
									<small
										>{rewardsForm.rewardType === 'cash_back' ? 'Percent' : 'Points per $1'}</small
									>
								</span>
								<div class="rate-input">
									<input
										bind:value={rewardsForm.baseRate}
										name="rewardBaseRate"
										type="number"
										min="0.01"
										max="100"
										step="0.01"
										inputmode="decimal"
										placeholder="1"
									/>
									<span>{rewardsForm.rewardType === 'cash_back' ? '%' : 'x'}</span>
								</div>
							</label>
						</div>

						<section class="reward-category-editor" aria-labelledby="reward-categories-title">
							<header>
								<div>
									<h3 id="reward-categories-title">Bonus categories</h3>
									<p>Map bonuses to provider categories to estimate each transaction’s rewards.</p>
								</div>
								<button
									type="button"
									onclick={addRewardCategory}
									disabled={rewardsForm.categories.length >= 12 || busyAction === 'save-rewards'}
								>
									+ Add category
								</button>
							</header>

							{#if rewardsForm.categories.length > 0}
								<div class="reward-category-rows">
									{#each rewardsForm.categories as category, index (category)}
										<div class="reward-category-row">
											<label>
												<span>Category</span>
												<input bind:value={category.name} maxlength="60" placeholder="Dining" />
											</label>
											<label>
												<span>Match activity</span>
												<select bind:value={category.matchCategory}>
													<option value="">Display only</option>
													{#each REWARD_CATEGORY_MATCH_OPTIONS as option (option.value)}
														<option value={option.value}>{option.label}</option>
													{/each}
												</select>
											</label>
											<label class="reward-rate-field">
												<span>{rewardsForm.rewardType === 'cash_back' ? 'Rate' : 'Multiplier'}</span
												>
												<div class="rate-input">
													<input
														bind:value={category.multiplier}
														type="number"
														min="0.01"
														max="100"
														step="0.01"
														inputmode="decimal"
														placeholder="3"
													/>
													<span>{rewardsForm.rewardType === 'cash_back' ? '%' : 'x'}</span>
												</div>
											</label>
											<button
												class="remove-reward-category"
												type="button"
												onclick={() => removeRewardCategory(index)}
												disabled={busyAction === 'save-rewards'}
												aria-label={`Remove ${category.name || `category ${index + 1}`}`}
											>
												<svg aria-hidden="true" viewBox="0 0 20 20"
													><path d="M5 5l10 10M15 5 5 15"></path></svg
												>
											</button>
										</div>
									{/each}
								</div>
							{:else}
								<p class="reward-categories-empty">No bonus categories added yet.</p>
							{/if}
						</section>

						{#if rewardsError}
							<p class="form-error" role="alert">{rewardsError}</p>
						{/if}

						<footer class="dialog-actions">
							<button
								class="button button-quiet"
								type="button"
								onclick={closeRewardsDialog}
								disabled={busyAction === 'save-rewards'}>Cancel</button
							>
							<button
								class="button button-primary"
								type="submit"
								disabled={busyAction === 'save-rewards'}
								aria-busy={busyAction === 'save-rewards'}
							>
								{busyAction === 'save-rewards' ? 'Saving…' : 'Save rewards'}
							</button>
						</footer>
					</form>
				{/if}
			</div>
		</div>
	{/if}

	{#if historyCard}
		<div class="dialog-layer">
			<div class="dialog-backdrop"></div>
			<div
				bind:this={dialogElement}
				class="dialog history-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="history-dialog-title"
				aria-describedby="history-dialog-description"
			>
				<header class="dialog-header history-header">
					<div>
						<p class="section-kicker">Card activity</p>
						<h2 id="history-dialog-title">{historyCard.nickname}</h2>
						<p id="history-dialog-description">
							{cardSubtitle(historyCard)} · History supplied by {financialProviderName(
								historyCard.connectionProvider
							)}
						</p>
					</div>
					<button
						bind:this={historyCloseButton}
						class="icon-button"
						type="button"
						onclick={closeTransactionHistory}
						aria-label="Close transaction history"
					>
						<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15"></path></svg>
					</button>
				</header>

				<div class="history-body">
					<div class="history-sync-note">
						<span class="mini-dot"></span>
						<span>{ageLabel(historyLastSyncedAt, 'Synced')}</span>
						{#if historyStatus === 'preparing' || historyStatus === 'current'}
							<span>· Older activity is still loading</span>
						{/if}
					</div>

					{#if historyLoading}
						<div class="history-loading" aria-label="Loading transaction history" aria-busy="true">
							<span></span><span></span><span></span>
						</div>
					{:else if historyError}
						<div class="history-error" role="alert">
							<strong>Couldn’t load activity</strong>
							<span>{historyError}</span>
							<button type="button" onclick={retryTransactionHistory}>Try again</button>
						</div>
					{:else if historyTransactions.length > 0}
						<ul class="transaction-list">
							{#each historyTransactions as transaction (transaction.id)}
								<li>
									<div class="transaction-date">
										<strong
											>{new Date(`${transaction.date}T12:00:00`).toLocaleDateString('en-US', {
												month: 'short',
												day: 'numeric'
											})}</strong
										>
										<span>{transaction.pending ? 'Pending' : 'Posted'}</span>
									</div>
									<div class="transaction-details">
										<strong>{transaction.merchantName ?? transaction.name}</strong>
										<span>{transactionCategory(transaction)}</span>
										{#if transaction.rewardEstimate}
											<span class="transaction-reward">
												{formatRewardEstimate(transaction.rewardEstimate)} · {formatRewardRate(
													transaction.rewardEstimate.rate,
													transaction.rewardEstimate.type
												)}{transaction.rewardEstimate.categoryName
													? ` ${transaction.rewardEstimate.categoryName}`
													: ' base'}
											</span>
										{/if}
									</div>
									<strong class:credit={transaction.amountCents < 0} class="transaction-amount">
										{formatTransactionAmount(transaction)}
									</strong>
								</li>
							{/each}
						</ul>
					{:else}
						<div class="history-empty">
							<h3>No activity yet</h3>
							<p>
								{historyStatus === 'historical_complete'
									? 'The provider did not return transactions for this card.'
									: 'The provider is preparing this card’s transaction history. Sync again shortly.'}
							</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
{/if}

{#if notice}
	<div
		class:error={noticeKind === 'error'}
		class="toast"
		role={noticeKind === 'error' ? 'alert' : 'status'}
	>
		<span class="toast-icon" aria-hidden="true">{noticeKind === 'error' ? '!' : '✓'}</span>
		<span>{notice}</span>
		<button type="button" onclick={() => (notice = '')} aria-label="Dismiss message">×</button>
	</div>
{/if}

<style>
	.auth-shell {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-height: 100vh;
		min-height: 100dvh;
		place-items: center;
		padding: 1.5rem;
		background: var(--paper-soft);
	}

	.auth-shell.auth-loading {
		align-content: center;
		gap: 1rem;
		color: var(--muted);
	}

	.auth-loading p {
		margin: 0;
		font-size: 0.78rem;
	}

	.auth-spinner {
		width: 25px;
		height: 25px;
		border: 2px solid #d6ddd7;
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 850ms linear infinite;
	}

	.auth-card {
		width: min(100%, 440px);
		padding: 2rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper);
		box-shadow: 8px 8px 0 rgba(17, 24, 39, 0.11);
	}

	.auth-brand {
		display: flex;
		gap: 0.65rem;
		align-items: center;
		justify-content: center;
		color: var(--ink);
		font-size: 1.04rem;
		font-weight: 760;
		letter-spacing: -0.025em;
	}

	.auth-lock {
		display: grid;
		width: 48px;
		height: 48px;
		place-items: center;
		margin: 2rem auto 1.1rem;
		border-radius: 8px;
		color: var(--accent);
		background: var(--accent-soft);
	}

	.auth-lock svg {
		width: 25px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.65;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.auth-lock.error-lock {
		color: var(--red);
		font-size: 1.2rem;
		font-weight: 800;
		background: var(--red-soft);
	}

	.auth-card > h1,
	.auth-card > .auth-intro,
	.auth-error-card {
		text-align: center;
	}

	.auth-card h1 {
		margin: 0;
		font-size: 1.55rem;
		font-weight: 740;
		letter-spacing: -0.04em;
	}

	.auth-intro,
	.auth-error-card > p {
		margin: 0.55rem 0 0;
		color: var(--muted);
		font-size: 0.79rem;
		line-height: 1.55;
	}

	.auth-error-card > .button {
		margin-top: 1.25rem;
	}

	.auth-notice {
		margin: 1rem 0 0;
		padding: 0.65rem 0.75rem;
		border: 1px solid #b8d8d3;
		border-radius: 8px;
		color: #075f58;
		font-size: 0.69rem;
		line-height: 1.45;
		background: var(--positive-soft);
	}

	.login-form {
		display: grid;
		gap: 0.48rem;
		margin-top: 1.5rem;
	}

	.auth-divider + .login-form {
		margin-top: 0;
	}

	.login-form > label {
		color: #414858;
		font-size: 0.69rem;
		font-weight: 690;
	}

	.password-field {
		display: flex;
		overflow: hidden;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		background: white;
		transition:
			border-color 140ms ease,
			box-shadow 140ms ease;
	}

	.password-field:focus-within {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px rgba(61, 90, 254, 0.12);
	}

	.password-field input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.65rem 0.75rem;
		border: 0;
		font-size: 0.84rem;
		outline: 0;
	}

	.password-field input[aria-invalid='true'] {
		color: #702727;
	}

	.password-field button {
		min-width: 55px;
		min-height: 44px;
		padding: 0.5rem 0.7rem;
		border: 0;
		border-left: 1px solid var(--line);
		color: var(--accent);
		font-size: 0.66rem;
		font-weight: 750;
		background: var(--paper-soft);
		cursor: pointer;
	}

	.login-error {
		margin: 0.15rem 0 0;
		color: #8b3030;
		font-size: 0.68rem;
		line-height: 1.4;
	}

	.auth-login-error {
		margin-top: 1rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid #e8b9b5;
		border-radius: 8px;
		background: var(--red-soft);
	}

	.google-button {
		position: relative;
		width: 184px;
		min-height: 44px;
		padding: 2px;
		border: 0;
		border-radius: 22px;
		background: transparent;
		box-shadow: none;
	}

	.google-button {
		margin-top: 1.25rem;
		margin-right: auto;
		margin-left: auto;
	}

	.google-button:hover {
		background: transparent;
		box-shadow: 3px 3px 0 rgba(17, 24, 39, 0.12);
	}

	.google-button img {
		display: block;
		width: 180px;
		height: 40px;
	}

	.google-login-pending {
		position: absolute;
		inset: 2px;
		display: grid;
		place-items: center;
		border-radius: 20px;
		color: #3c4043;
		font-size: 0.72rem;
		font-weight: 600;
		background: #f2f2f2;
	}

	.account-create-note {
		margin-top: 1.15rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
		text-align: left;
	}

	.account-create-note p {
		margin: 0;
		color: var(--muted);
		font-size: 0.7rem;
		line-height: 1.45;
	}

	.account-create-note strong {
		color: var(--ink);
	}

	.google-button:focus-visible,
	.google-link-button:focus-visible {
		outline: 3px solid rgba(61, 90, 254, 0.22);
		outline-offset: 2px;
	}

	.google-button[aria-disabled='true'],
	.google-link-button[aria-disabled='true'] {
		cursor: wait;
		opacity: 0.65;
	}

	.auth-divider {
		display: flex;
		gap: 0.65rem;
		align-items: center;
		margin: 1.1rem 0;
		color: var(--faint);
		font-size: 0.62rem;
	}

	.auth-divider::before,
	.auth-divider::after {
		height: 1px;
		flex: 1;
		background: var(--line);
		content: '';
	}

	.login-button {
		width: 100%;
		margin-top: 0.65rem;
	}

	.bootstrap-setup {
		margin-top: 1.25rem;
		border-top: 1px solid var(--line);
	}

	.bootstrap-setup summary {
		display: flex;
		min-height: 44px;
		align-items: center;
		justify-content: center;
		padding: 0.65rem 0;
		color: var(--accent);
		font-size: 0.69rem;
		font-weight: 720;
		text-align: center;
		cursor: pointer;
		list-style-position: inside;
	}

	.bootstrap-setup summary:focus-visible {
		border-radius: 8px;
		outline: 3px solid rgba(61, 90, 254, 0.2);
		outline-offset: 2px;
	}

	.bootstrap-content {
		padding: 0.85rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper-soft);
	}

	.bootstrap-content > p,
	.bootstrap-form {
		margin: 0;
	}

	.bootstrap-content > #setup-guidance {
		color: var(--muted);
		font-size: 0.65rem;
		line-height: 1.55;
	}

	.bootstrap-form {
		display: grid;
		gap: 0.5rem;
		margin-top: 0.8rem;
	}

	.bootstrap-form label {
		color: #414858;
		font-size: 0.68rem;
		font-weight: 690;
	}

	.bootstrap-form input {
		width: 100%;
		min-width: 0;
		min-height: 44px;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		font-size: 0.78rem;
		background: white;
	}

	.bootstrap-form input:focus {
		border-color: var(--accent);
		outline: 0;
		box-shadow: 0 0 0 3px rgba(61, 90, 254, 0.12);
	}

	.bootstrap-form input[aria-invalid='true'] {
		border-color: #c67e78;
	}

	.bootstrap-form .button {
		width: 100%;
		margin-top: 0.15rem;
	}

	.bootstrap-content > .setup-error {
		margin-top: 0.65rem;
		padding: 0.6rem 0.65rem;
		border-radius: 7px;
		color: #8b3030;
		font-size: 0.65rem;
		line-height: 1.45;
		background: var(--red-soft);
	}

	.bootstrap-content > .setup-warning,
	.bootstrap-content > .setup-lockout-warning {
		margin-top: 0.7rem;
		padding: 0.6rem 0.65rem;
		border-left: 3px solid #d2a24c;
		border-radius: 0 7px 7px 0;
		color: #66553d;
		font-size: 0.62rem;
		line-height: 1.5;
		background: #fff8e9;
	}

	.bootstrap-content > .setup-lockout-warning {
		border-left-color: #c67e78;
		color: #6f3b37;
		background: var(--red-soft);
	}

	.setup-warning strong {
		color: #6f4818;
	}

	.setup-lockout-warning strong {
		color: #7c2d28;
	}

	.cloud-privacy {
		display: flex;
		gap: 0.65rem;
		align-items: flex-start;
		margin-top: 1.25rem;
		padding: 0.75rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper-soft);
	}

	.cloud-privacy svg {
		width: 19px;
		flex: 0 0 auto;
		fill: none;
		stroke: var(--accent);
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.cloud-privacy p {
		margin: 0;
		color: var(--muted);
		font-size: 0.64rem;
		line-height: 1.5;
	}

	.cloud-privacy strong {
		color: #303747;
	}

	.auth-footer {
		margin: 1rem 0 0;
		color: var(--faint);
		font-size: 0.6rem;
		text-align: center;
	}

	.skip-link {
		position: fixed;
		top: 0.75rem;
		left: 0.75rem;
		z-index: 100;
		padding: 0.65rem 0.9rem;
		border-radius: 0.5rem;
		color: white;
		background: var(--accent-dark);
		transform: translateY(-150%);
		transition: transform 140ms ease;
	}

	.skip-link:focus {
		transform: translateY(0);
	}

	.app-shell {
		width: min(100% - 2.5rem, 1180px);
		margin: 0 auto;
	}

	.site-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 78px;
		border-bottom: 1px solid rgba(204, 211, 203, 0.7);
	}

	.brand {
		display: inline-flex;
		gap: 0.65rem;
		align-items: center;
		color: var(--ink);
		font-size: 1.08rem;
		font-weight: 760;
		letter-spacing: -0.025em;
		text-decoration: none;
	}

	.brand-mark {
		display: block;
		width: 34px;
		height: 34px;
		filter: drop-shadow(3px 3px 0 rgba(39, 58, 165, 0.24));
	}

	.brand-mark img {
		display: block;
		width: 100%;
		height: 100%;
	}

	.header-status {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		color: var(--muted);
		font-size: 0.78rem;
		font-weight: 650;
	}

	.header-controls {
		display: flex;
		gap: 0.8rem;
		align-items: center;
	}

	.logout-button {
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

	.logout-button:hover:not(:disabled) {
		color: var(--red);
		border-color: #d7aaa6;
		background: white;
	}

	.logout-button:disabled {
		cursor: wait;
		opacity: 0.6;
	}

	.status-dot,
	.connection-mark,
	.mini-dot {
		display: inline-block;
		flex: 0 0 auto;
		border-radius: 50%;
		background: var(--accent);
	}

	.status-dot {
		width: 7px;
		height: 7px;
		box-shadow: 0 0 0 4px rgba(61, 90, 254, 0.12);
	}

	.hero {
		display: flex;
		gap: 2rem;
		align-items: flex-end;
		justify-content: space-between;
		padding: 4.4rem 0 3rem;
	}

	.dashboard-toolbar {
		display: flex;
		gap: 1.5rem;
		align-items: flex-end;
		justify-content: space-between;
		padding: 1.65rem 0 1.1rem;
	}

	.dashboard-toolbar .section-kicker {
		margin-bottom: 0.25rem;
	}

	.dashboard-toolbar h1 {
		margin: 0;
		font-size: clamp(1.7rem, 3vw, 2.2rem);
		font-weight: 740;
		line-height: 1.08;
		letter-spacing: -0.04em;
	}

	.toolbar-description {
		margin: 0.35rem 0 0;
		color: var(--muted);
		font-size: 0.78rem;
		line-height: 1.5;
	}

	.dashboard-actions {
		display: flex;
		gap: 0.65rem;
		align-items: center;
	}

	.visually-hidden {
		position: absolute !important;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	.hero-copy {
		max-width: 670px;
	}

	.eyebrow,
	.section-kicker {
		margin: 0 0 0.6rem;
		color: var(--accent);
		font-size: 0.7rem;
		font-weight: 780;
		letter-spacing: 0.13em;
		text-transform: uppercase;
	}

	.hero h1 {
		margin: 0;
		font-size: clamp(2.25rem, 5.4vw, 4rem);
		font-weight: 740;
		line-height: 1.03;
		letter-spacing: -0.055em;
	}

	.hero-description {
		max-width: 590px;
		margin: 1.1rem 0 0;
		color: var(--muted);
		font-size: 1.03rem;
		line-height: 1.65;
	}

	.hero-actions,
	.calendar-actions,
	.dialog-actions {
		display: flex;
		gap: 0.7rem;
		align-items: center;
	}

	.hero-action-stack {
		flex: 0 0 auto;
		max-width: 365px;
		padding-bottom: 0.4rem;
	}

	.plaid-consent {
		margin: 0.55rem 0 0;
		color: var(--faint);
		font-size: 0.64rem;
		line-height: 1.45;
		text-align: right;
	}

	.button {
		display: inline-flex;
		min-height: 43px;
		gap: 0.5rem;
		align-items: center;
		justify-content: center;
		padding: 0.68rem 1rem;
		border: 1px solid transparent;
		border-radius: 7px;
		font-size: 0.82rem;
		font-weight: 700;
		line-height: 1;
		text-decoration: none;
		cursor: pointer;
		transition:
			background 140ms ease,
			border-color 140ms ease,
			transform 140ms ease,
			box-shadow 140ms ease;
	}

	.button:hover:not(:disabled) {
		transform: translateY(-1px);
	}

	.button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.button svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.button-primary {
		color: white;
		background: var(--accent);
		box-shadow: 3px 3px 0 #1f2f86;
	}

	.button-primary:hover:not(:disabled) {
		background: var(--accent-dark);
		box-shadow: 4px 4px 0 #172468;
	}

	.button-secondary {
		border-color: var(--line-strong);
		background: rgba(255, 255, 255, 0.65);
		box-shadow: var(--shadow-sm);
	}

	.button-secondary:hover:not(:disabled),
	.button-secondary:hover {
		border-color: #aeb9af;
		background: white;
	}

	.button-quiet {
		border-color: var(--line);
		background: transparent;
	}

	.button-quiet:hover:not(:disabled) {
		background: white;
	}

	.load-error {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 1rem;
		padding: 0.9rem 1rem;
		border: 1px solid #e8b9b5;
		border-radius: 10px;
		color: #812d2d;
		background: var(--red-soft);
	}

	.load-error div {
		display: grid;
		gap: 0.2rem;
	}

	.load-error span {
		font-size: 0.78rem;
	}

	.load-error button {
		border: 0;
		color: #812d2d;
		font-size: 0.78rem;
		font-weight: 750;
		text-decoration: underline;
		background: none;
		cursor: pointer;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		color: white;
		border: 1px solid var(--ink);
		border-radius: 10px;
		background: var(--ink);
		box-shadow: 6px 6px 0 #c9c1b5;
	}

	.summary-grid[hidden] {
		display: none;
	}

	.summary-grid.overview-summary {
		gap: 0.85rem;
		color: var(--ink);
		border: 0;
		background: transparent;
		box-shadow: none;
	}

	.overview-summary .summary-card {
		border: 1px solid var(--line);
		border-radius: 10px;
		background: rgba(255, 253, 249, 0.78);
		box-shadow: var(--shadow-sm);
	}

	.overview-summary .summary-card + .summary-card {
		border-left: 1px solid var(--line);
	}

	.overview-summary .summary-card p,
	.overview-summary .summary-card span {
		color: var(--muted);
	}

	.summary-card {
		display: flex;
		min-width: 0;
		gap: 1rem;
		align-items: center;
		padding: 1.3rem 1.4rem;
	}

	.summary-card + .summary-card {
		border-left: 1px solid rgba(255, 255, 255, 0.14);
	}

	.summary-icon,
	.panel-icon {
		display: grid;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 7px;
	}

	.summary-icon {
		width: 42px;
		height: 42px;
	}

	.summary-icon svg,
	.panel-icon svg {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.65;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.summary-icon svg {
		width: 23px;
	}

	.summary-balance .summary-icon {
		color: #9aaaff;
		background: rgba(154, 170, 255, 0.12);
	}

	.summary-due .summary-icon {
		color: #f4bd69;
		background: rgba(244, 189, 105, 0.12);
	}

	.summary-next .summary-icon {
		color: #72c4dc;
		background: rgba(114, 196, 220, 0.12);
	}

	.summary-card div:last-child {
		display: grid;
		min-width: 0;
		gap: 0.15rem;
	}

	.summary-card p,
	.summary-card span {
		margin: 0;
		color: #aeb6c5;
		font-size: 0.71rem;
	}

	.summary-card strong {
		overflow: hidden;
		font-size: 1.32rem;
		font-weight: 730;
		letter-spacing: -0.025em;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-variant-numeric: tabular-nums;
	}

	.summary-card strong.next-date {
		font-size: 1.08rem;
	}

	.workspace-modules {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.85rem;
		padding-top: 1rem;
	}

	.workspace-modules[hidden],
	.cards-section[hidden] {
		display: none;
	}

	.workspace-module {
		display: grid;
		min-width: 0;
		grid-template-columns: auto minmax(0, 1fr) auto;
		gap: 0.8rem;
		align-items: center;
		padding: 0.9rem 1rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		color: var(--ink);
		background: rgba(255, 253, 249, 0.72);
		box-shadow: var(--shadow-sm);
		text-decoration: none;
		transition:
			border-color 140ms ease,
			background 140ms ease,
			transform 140ms ease;
	}

	.workspace-module:hover {
		border-color: var(--line-strong);
		background: var(--paper);
		transform: translateY(-1px);
	}

	.module-icon {
		display: grid;
		width: 36px;
		height: 36px;
		place-items: center;
		border-radius: 8px;
		color: var(--accent-dark);
		background: var(--accent-soft);
	}

	.bonuses-module .module-icon {
		color: var(--positive);
		background: var(--positive-soft);
	}

	.module-icon svg,
	.module-arrow {
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.7;
	}

	.module-icon svg {
		width: 21px;
	}

	.workspace-module > span:nth-child(2) {
		display: grid;
		min-width: 0;
		gap: 0.16rem;
	}

	.workspace-module strong {
		font-size: 0.78rem;
		font-weight: 750;
	}

	.workspace-module small {
		overflow: hidden;
		color: var(--muted);
		font-size: 0.65rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.module-arrow {
		width: 18px;
		color: var(--faint);
	}

	.cards-section {
		padding: 2.8rem 0 4.6rem;
	}

	.section-heading {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		margin-bottom: 1.15rem;
	}

	.section-heading h2,
	.info-panel h2,
	.dialog h2 {
		margin: 0;
		font-size: 1.3rem;
		font-weight: 730;
		letter-spacing: -0.032em;
	}

	.section-heading .section-kicker {
		margin-bottom: 0.3rem;
	}

	.spinning {
		animation: spin 900ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.card-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 1rem;
	}

	.credit-card {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 360px;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper);
		box-shadow: 5px 5px 0 rgba(17, 24, 39, 0.09);
		transition:
			transform 160ms ease,
			box-shadow 160ms ease,
			border-color 160ms ease;
	}

	.credit-card:hover {
		border-color: #aaa294;
		box-shadow: 7px 7px 0 rgba(17, 24, 39, 0.11);
		transform: translate(-2px, -2px);
	}

	.credit-card.overdue {
		border-color: #d59aa5;
	}

	.card-header {
		display: flex;
		gap: 0.8rem;
		align-items: flex-start;
		justify-content: space-between;
		padding: 1.25rem;
		color: white;
		background: var(--ink);
	}

	.card-identity {
		min-width: 0;
	}

	.issuer-logo {
		display: block;
		width: auto;
		max-width: 82px;
		height: 17px;
		margin-bottom: 0.65rem;
		padding: 0.3rem 0.45rem;
		box-sizing: content-box;
		border-radius: 5px;
		background: white;
		object-fit: contain;
		object-position: left center;
	}

	.issuer-logo-venmo {
		width: 82px;
	}

	.card-identity h3 {
		overflow: hidden;
		margin: 0;
		font-size: 1rem;
		font-weight: 730;
		letter-spacing: -0.018em;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-identity p {
		overflow: hidden;
		margin: 0.25rem 0 0;
		color: #c4ccda;
		font-size: 0.8rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.source-pill,
	.due-pill,
	.autopay-pill {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		border-radius: 999px;
		font-size: 0.72rem;
		font-weight: 720;
	}

	.source-pill {
		padding: 0.3rem 0.48rem;
		color: #d5dae4;
		background: rgba(255, 255, 255, 0.1);
	}

	.source-pill.plaid-source {
		color: #dce2ff;
		background: rgba(102, 126, 255, 0.2);
	}

	.balance-block {
		display: grid;
		gap: 0.2rem;
		padding: 1.25rem 1.25rem 1.35rem;
		color: white;
		border-top: 1px solid rgba(255, 255, 255, 0.12);
		background: var(--ink);
	}

	.balance-block > span,
	.payment-details span {
		color: var(--muted);
		font-size: 0.78rem;
	}

	.balance-block > span {
		color: #cbd3df;
	}

	.balance-block > strong {
		font-size: 1.75rem;
		font-weight: 735;
		letter-spacing: -0.045em;
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-variant-numeric: tabular-nums;
	}

	.balance-block > strong.unavailable {
		color: #c1c7d2;
		font-size: 1.1rem;
		letter-spacing: -0.02em;
	}

	.balance-block small {
		color: #bdc6d4;
		font-size: 0.75rem;
		line-height: 1.4;
	}

	.payment-details {
		display: grid;
		grid-template-columns: 1fr 1fr;
		margin: 0 1.25rem;
		padding: 1rem 0;
		border-top: 1px solid #e4ded3;
		border-bottom: 1px solid #e4ded3;
	}

	.payment-details div {
		display: grid;
		min-width: 0;
		gap: 0.28rem;
	}

	.payment-details div + div {
		padding-left: 1rem;
		border-left: 1px solid #e4ded3;
	}

	.payment-details strong {
		overflow: hidden;
		font-size: 0.86rem;
		font-weight: 690;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.card-flags {
		display: flex;
		min-height: 54px;
		gap: 0.4rem;
		align-items: center;
		padding: 0.9rem 1.25rem;
	}

	.due-pill {
		padding: 0.34rem 0.55rem;
	}

	.due-pill.neutral {
		color: #5d6472;
		background: #ebe7df;
	}

	.due-pill.good {
		color: var(--accent);
		background: var(--accent-soft);
	}

	.due-pill.warn {
		color: var(--amber);
		background: var(--amber-soft);
	}

	.due-pill.danger {
		color: var(--red);
		background: var(--red-soft);
	}

	.autopay-pill {
		gap: 0.2rem;
		padding: 0.34rem 0.5rem;
		color: #4d5667;
		border: 1px solid var(--line);
	}

	.autopay-pill svg {
		width: 12px;
		fill: none;
		stroke: var(--positive);
		stroke-width: 2;
	}

	.card-rewards {
		margin: 0 1.25rem 1rem;
		padding: 0.8rem;
		border: 1px solid #d9d2f0;
		border-radius: 8px;
		background: #f7f4ff;
	}

	.card-rewards header {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		justify-content: space-between;
	}

	.card-rewards header > div {
		display: grid;
		min-width: 0;
		gap: 0.12rem;
	}

	.card-rewards header span {
		color: #756c8c;
		font-size: 0.58rem;
		font-weight: 720;
		letter-spacing: 0.08em;
		text-transform: uppercase;
	}

	.card-rewards header strong {
		overflow: hidden;
		font-size: 0.76rem;
		font-weight: 720;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.card-rewards .reward-value {
		align-items: end;
		text-align: right;
	}

	.card-rewards .reward-value strong {
		color: var(--positive);
		font-variant-numeric: tabular-nums;
	}

	.reward-summary {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.55rem;
		margin-top: 0.7rem;
		padding-top: 0.65rem;
		border-top: 1px solid #ded7f2;
	}

	.reward-summary > div {
		display: grid;
		gap: 0.12rem;
	}

	.reward-summary span {
		color: #756c8c;
		font-size: 0.57rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.reward-summary strong {
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
	}

	.card-rewards ul {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.42rem;
		margin: 0.7rem 0 0;
		padding: 0;
		list-style: none;
	}

	.card-rewards li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.5rem;
		align-items: center;
		min-width: 0;
		padding: 0.48rem 0.52rem;
		border: 1px solid #ded7f2;
		border-radius: 6px;
		color: #544d67;
		background: white;
	}

	.card-rewards li > div {
		display: grid;
		min-width: 0;
		gap: 0.12rem;
	}

	.card-rewards li span {
		font-size: 0.62rem;
		font-weight: 650;
		line-height: 1.25;
	}

	.card-rewards li small {
		color: #817895;
		font-size: 0.53rem;
		line-height: 1.2;
	}

	.card-rewards li strong {
		color: var(--accent);
		font-size: 0.67rem;
		font-variant-numeric: tabular-nums;
	}

	.reward-cap-meter {
		display: block;
		width: 100%;
		height: 3px;
		margin-top: 0.08rem;
		overflow: hidden;
		border-radius: 999px;
		background: #e5def5;
	}

	.reward-cap-meter > span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--accent);
	}

	.card-activity-preview {
		margin: 0 1.25rem 1rem;
		overflow: hidden;
		border: 1px solid var(--line);
		border-radius: 7px;
		background: var(--paper);
	}

	.activity-preview-header {
		display: flex;
		min-height: 38px;
		gap: 0.45rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.5rem 0.65rem;
		border-bottom: 1px solid var(--line);
		background: #f1ede5;
	}

	.activity-preview-header h4 {
		margin: 0;
		font-size: 0.8rem;
		font-weight: 700;
		letter-spacing: 0;
		white-space: nowrap;
	}

	.activity-preview-header button {
		display: inline-flex;
		min-height: 28px;
		flex: 0 0 auto;
		gap: 0.22rem;
		align-items: center;
		padding: 0.25rem 0.4rem;
		border: 1px solid #b8c2f5;
		border-radius: 5px;
		color: var(--accent);
		font-size: 0.7rem;
		font-weight: 680;
		white-space: nowrap;
		background: white;
		cursor: pointer;
	}

	.activity-preview-header button:hover {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.activity-preview-header button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.activity-preview-header svg {
		width: 11px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.activity-preview-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.activity-preview-list li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.7rem;
		align-items: center;
		padding: 0.72rem 0.75rem;
	}

	.activity-preview-list li + li {
		border-top: 1px solid #e6e0d6;
	}

	.activity-preview-list li > div {
		display: grid;
		min-width: 0;
		gap: 0.14rem;
	}

	.activity-preview-list strong,
	.activity-preview-list span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.activity-preview-list strong {
		font-size: 0.8rem;
		font-weight: 650;
	}

	.activity-preview-list span {
		color: var(--faint);
		font-size: 0.74rem;
	}

	.activity-preview-list .activity-preview-reward {
		color: #5b4b91;
		font-size: 0.67rem;
		font-weight: 650;
	}

	.activity-preview-amount {
		font-variant-numeric: tabular-nums;
	}

	.activity-preview-amount.credit {
		color: var(--positive);
	}

	.activity-preview-message {
		margin: 0;
		padding: 1rem 0.7rem;
		color: var(--faint);
		font-size: 0.76rem;
		text-align: center;
	}

	.activity-preview-loading {
		display: grid;
		gap: 1px;
		background: #e6e0d6;
	}

	.activity-preview-loading span {
		height: 48px;
		background: linear-gradient(90deg, #f2eee6 25%, #fffdf9 50%, #f2eee6 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	.card-footer {
		display: flex;
		min-height: 45px;
		align-items: center;
		justify-content: space-between;
		margin-top: auto;
		padding: 0.7rem 1.25rem;
		border-top: 1px solid #e4ded3;
		background: #f3efe7;
	}

	.card-footer > span {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		color: var(--faint);
		font-size: 0.74rem;
	}

	.card-footer .mini-dot {
		background: var(--positive);
	}

	.mini-dot {
		width: 5px;
		height: 5px;
	}

	.card-actions {
		display: flex;
		gap: 0.75rem;
	}

	.card-actions button {
		min-width: 32px;
		min-height: 32px;
		padding: 0;
		border: 0;
		color: var(--muted);
		font-size: 0.74rem;
		font-weight: 700;
		background: transparent;
		cursor: pointer;
	}

	.card-actions button:hover {
		color: var(--ink);
		text-decoration: underline;
	}

	.card-actions button.delete-button:hover {
		color: var(--red);
	}

	.card-actions button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.card-actions .history-button {
		color: var(--accent);
	}

	.card-actions .rewards-button {
		color: #5b4b91;
	}

	.skeleton-card {
		gap: 1rem;
		padding: 1.5rem;
	}

	.skeleton {
		border-radius: 7px;
		background: linear-gradient(90deg, #e8e2d8 25%, #f8f5ee 50%, #e8e2d8 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	.skeleton-short {
		width: 30%;
		height: 10px;
	}

	.skeleton-title {
		width: 62%;
		height: 18px;
	}

	.skeleton-amount {
		width: 48%;
		height: 35px;
		margin-top: 1.1rem;
	}

	.skeleton-row {
		height: 64px;
		margin-top: 1rem;
	}

	@keyframes shimmer {
		to {
			background-position: -200% 0;
		}
	}

	.empty-state {
		display: flex;
		min-height: 340px;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 2.4rem;
		border: 1px dashed var(--line-strong);
		border-radius: 9px;
		text-align: center;
		background: rgba(255, 253, 249, 0.7);
	}

	.empty-illustration {
		width: 112px;
		margin-bottom: 0.8rem;
		color: var(--accent);
	}

	.empty-illustration svg {
		width: 100%;
		fill: #eef5ef;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.empty-illustration circle {
		fill: #fff9ec;
		stroke: #c58530;
	}

	.empty-state h3 {
		margin: 0;
		font-size: 1.14rem;
	}

	.empty-state p {
		max-width: 460px;
		margin: 0.6rem 0 1.25rem;
		color: var(--muted);
		font-size: 0.83rem;
		line-height: 1.6;
	}

	.info-grid {
		display: grid;
		grid-template-columns: 1.18fr 0.82fr;
		gap: 1rem;
		padding-bottom: 4.5rem;
	}

	.info-grid[hidden],
	.info-panel[hidden] {
		display: none;
	}

	.info-grid.settings-grid,
	.info-grid.card-tools-grid {
		grid-template-columns: 1fr;
	}

	.info-grid.settings-grid {
		max-width: 920px;
	}

	.info-grid.card-tools-grid {
		max-width: 700px;
	}

	.info-panel {
		display: flex;
		gap: 1.15rem;
		padding: 1.65rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper);
		box-shadow: 4px 4px 0 rgba(17, 24, 39, 0.07);
	}

	.panel-icon {
		width: 46px;
		height: 46px;
	}

	.panel-icon svg {
		width: 25px;
	}

	.privacy-icon {
		color: var(--accent);
		background: var(--accent-soft);
	}

	.calendar-icon {
		color: var(--blue);
		background: var(--blue-soft);
	}

	.panel-content {
		flex: 1;
		min-width: 0;
	}

	.panel-content > p:not(.section-kicker) {
		margin: 0.65rem 0 0;
		color: var(--muted);
		font-size: 0.77rem;
		line-height: 1.55;
	}

	.panel-content > .trust-note {
		margin-top: 0.85rem;
		padding: 0.7rem 0.75rem;
		border-left: 3px solid #d2a24c;
		border-radius: 0 7px 7px 0;
		color: #5b6070;
		background: #fff8e9;
	}

	.trust-note strong {
		color: #6f4818;
	}

	.privacy-list {
		display: grid;
		gap: 0.55rem;
		margin: 1rem 0 0;
		padding: 0;
		list-style: none;
	}

	.google-access {
		margin-top: 1rem;
		padding: 0.85rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper-soft);
	}

	.google-access-heading {
		display: flex;
		gap: 0.65rem;
		align-items: center;
		flex-wrap: wrap;
	}

	.google-access-heading > div {
		min-width: 0;
		flex: 1;
	}

	.google-access-icon {
		display: grid;
		width: 28px;
		height: 28px;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 8px;
		color: var(--accent);
		background: var(--accent-soft);
	}

	.google-access-icon svg {
		width: 17px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.google-access h3,
	.google-access p {
		margin: 0;
	}

	.google-access h3 {
		font-size: 0.75rem;
		font-weight: 740;
	}

	.google-access-heading p {
		margin-top: 0.18rem;
		color: var(--muted);
		font-size: 0.64rem;
		line-height: 1.45;
	}

	.google-link-button {
		min-height: 43px;
		padding: 0.5rem 0.7rem;
		color: var(--accent);
		border-color: #b9cfc0;
		font-size: 0.66rem;
		background: white;
		box-shadow: none;
	}

	.google-link-button:hover {
		border-color: var(--accent);
		background: white;
	}

	.google-ready {
		display: inline-flex;
		flex: 0 0 auto;
		gap: 0.25rem;
		align-items: center;
		color: var(--accent);
		font-size: 0.64rem;
		font-weight: 740;
	}

	.google-ready > span {
		display: grid;
		width: 17px;
		height: 17px;
		place-items: center;
		border-radius: 50%;
		color: white;
		font-size: 0.57rem;
		background: var(--accent);
	}

	.google-access > .google-privacy-note {
		margin-top: 0.7rem;
		padding-top: 0.65rem;
		border-top: 1px solid var(--line);
		color: var(--faint);
		font-size: 0.61rem;
		line-height: 1.5;
	}

	.google-access > .google-setup-note {
		margin-top: 0.65rem;
		padding: 0.6rem 0.65rem;
		border-left: 3px solid #d2a24c;
		border-radius: 0 7px 7px 0;
		color: #66553d;
		font-size: 0.61rem;
		line-height: 1.5;
		background: #fff8e9;
	}

	.google-setup-note strong {
		color: #6f4818;
	}

	.privacy-list li {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		color: #555d6e;
		font-size: 0.72rem;
	}

	.plaid-setup {
		margin-top: 1rem;
		padding: 1rem;
		border: 1px solid #b9cfc0;
		border-radius: 10px;
		background: #f5faf6;
	}

	.plaid-setup-heading {
		display: flex;
		gap: 0.75rem;
		align-items: flex-start;
		justify-content: space-between;
	}

	.plaid-setup h3,
	.plaid-setup p {
		margin: 0;
	}

	.plaid-setup h3 {
		font-size: 0.88rem;
		font-weight: 740;
	}

	.plaid-setup .section-kicker {
		margin-bottom: 0.25rem;
	}

	.plaid-setup > p {
		margin-top: 0.65rem;
		color: var(--muted);
		font-size: 0.7rem;
		line-height: 1.55;
	}

	.plaid-private-badge {
		padding: 0.28rem 0.45rem;
		border-radius: 999px;
		color: var(--accent);
		font-size: 0.58rem;
		font-weight: 760;
		background: var(--accent-soft);
	}

	.plaid-dashboard-link {
		padding: 0.65rem 0 0;
		font-size: 0.67rem;
	}

	.plaid-setup-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
		gap: 0.65rem;
		align-items: end;
		margin-top: 0.8rem;
	}

	.plaid-setup-form .button {
		min-height: 42px;
		white-space: nowrap;
	}

	.plaid-setup-actions {
		display: flex;
		gap: 0.45rem;
	}

	.plaid-setup-error {
		margin-top: 0.7rem !important;
		color: #812d2d !important;
		font-size: 0.67rem !important;
	}

	.plaid-setup > small {
		display: block;
		margin-top: 0.75rem;
		color: var(--faint);
		font-size: 0.59rem;
		line-height: 1.5;
	}

	.plaid-personal-ready {
		display: flex;
		gap: 0.6rem;
		align-items: center;
		margin-top: 1rem;
		padding: 0.75rem;
		border: 1px solid #b9cfc0;
		border-radius: 9px;
		background: #f5faf6;
	}

	.plaid-personal-ready > span {
		display: grid;
		width: 24px;
		height: 24px;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 50%;
		color: white;
		font-size: 0.68rem;
		font-weight: 800;
		background: var(--accent);
	}

	.plaid-personal-ready div {
		display: grid;
		flex: 1;
		gap: 0.16rem;
	}

	.plaid-personal-ready .plaid-ready-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 0.45rem;
	}

	.plaid-ready-actions .button {
		min-height: 36px;
		padding: 0.5rem 0.7rem;
		font-size: 0.62rem;
		white-space: nowrap;
	}

	.plaid-personal-ready strong {
		font-size: 0.7rem;
	}

	.plaid-personal-ready small {
		color: var(--muted);
		font-size: 0.59rem;
	}

	.plaid-replace-button {
		min-height: 36px;
		padding: 0.5rem 0.7rem;
		font-size: 0.62rem;
	}

	.check-mark {
		display: grid;
		width: 17px;
		height: 17px;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 50%;
		color: var(--accent);
		font-size: 0.65rem;
		font-weight: 900;
		background: var(--accent-soft);
	}

	.connection-mark {
		width: 7px;
		height: 7px;
		margin: 0 5px;
		background: #a6afa9;
	}

	.connection-mark.connected {
		background: var(--positive);
		box-shadow: 0 0 0 3px rgba(8, 127, 117, 0.12);
	}

	.connections-loading,
	.connection-error,
	.connection-manager {
		margin-top: 1.15rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}

	.connections-loading {
		display: grid;
		gap: 0.5rem;
	}

	.connections-loading span {
		display: block;
		height: 38px;
		border-radius: 8px;
		background: linear-gradient(90deg, #e8e2d8 25%, #f8f5ee 50%, #e8e2d8 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	.connection-error {
		display: flex;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
		color: #812d2d;
		font-size: 0.7rem;
	}

	.connection-error button {
		min-width: 48px;
		min-height: 32px;
		padding: 0.35rem 0.55rem;
		border: 1px solid #dfaaa5;
		border-radius: 7px;
		color: #812d2d;
		font-size: 0.66rem;
		font-weight: 720;
		background: #fff7f6;
		cursor: pointer;
	}

	.connection-heading {
		display: flex;
		gap: 0.75rem;
		align-items: baseline;
		justify-content: space-between;
	}

	.connection-heading h3 {
		margin: 0;
		font-size: 0.76rem;
		font-weight: 740;
	}

	.connection-heading > span {
		color: var(--faint);
		font-size: 0.62rem;
	}

	.connection-list {
		display: grid;
		gap: 0.45rem;
		margin: 0.65rem 0 0;
		padding: 0;
		list-style: none;
	}

	.connection-list > li {
		display: flex;
		min-width: 0;
		gap: 0.75rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.6rem 0.65rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper-soft);
	}

	.connection-details {
		display: flex;
		min-width: 0;
		gap: 0.55rem;
		align-items: center;
	}

	.institution-icon {
		display: grid;
		width: 30px;
		height: 30px;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 8px;
		color: var(--blue);
		background: var(--blue-soft);
	}

	.institution-icon svg {
		width: 17px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.institution-logo {
		overflow: hidden;
		padding: 3px;
		background: white;
	}

	.institution-logo img {
		display: block;
		width: 100%;
		height: 100%;
		border-radius: 5px;
		object-fit: contain;
	}

	.connection-details > span:last-child {
		display: grid;
		min-width: 0;
		gap: 0.18rem;
	}

	.connection-details strong {
		overflow: hidden;
		font-size: 0.72rem;
		font-weight: 710;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.connection-details small {
		color: var(--faint);
		font-size: 0.61rem;
	}

	.connection-details small.attention {
		color: #855018;
		font-weight: 680;
	}

	.connection-actions {
		display: flex;
		flex: 0 0 auto;
		gap: 0.35rem;
	}

	.connection-actions button {
		min-height: 32px;
		padding: 0.35rem 0.55rem;
		border-radius: 7px;
		font-size: 0.63rem;
		font-weight: 720;
		background: white;
		cursor: pointer;
	}

	.connection-actions button:disabled,
	.connection-error button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.update-connection {
		border: 1px solid #dfbd87;
		color: #734713;
	}

	.disconnect-connection {
		border: 1px solid #dfb5b1;
		color: #8c3030;
	}

	.calendar-actions {
		flex-wrap: wrap;
		margin-top: 1.2rem;
	}

	.calendar-dialog {
		width: min(100%, 680px);
	}

	.calendar-dialog-body {
		padding: 1.2rem 1.5rem 1.5rem;
	}

	.calendar-privacy-note {
		display: flex;
		gap: 0.55rem;
		align-items: center;
		padding: 0.7rem 0.8rem;
		border: 1px solid #bddccf;
		border-radius: 9px;
		color: #245c48;
		font-size: 0.68rem;
		font-weight: 650;
		background: #eef8f3;
	}

	.calendar-privacy-note svg {
		width: 18px;
		height: 18px;
		flex: 0 0 auto;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.calendar-event-list {
		display: grid;
		gap: 0.55rem;
		margin: 1rem 0 0;
		padding: 0;
		list-style: none;
	}

	.calendar-event-list li {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 0.8rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: white;
	}

	.calendar-event-list li > div {
		display: grid;
		min-width: 0;
		gap: 0.2rem;
	}

	.calendar-event-list strong {
		overflow: hidden;
		font-size: 0.76rem;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.calendar-event-list span {
		color: var(--muted);
		font-size: 0.66rem;
	}

	.calendar-event-list .button {
		min-height: 36px;
		flex: 0 0 auto;
		padding: 0.5rem 0.7rem;
		font-size: 0.68rem;
	}

	.calendar-event-list .button svg {
		width: 15px;
		height: 15px;
	}

	.calendar-dialog-actions {
		justify-content: space-between;
		margin-top: 1rem;
		padding-top: 1rem;
		border-top: 1px solid var(--line);
	}

	.text-link {
		display: inline-flex;
		gap: 0.2rem;
		align-items: center;
		padding: 0.5rem;
		color: var(--accent);
		font-size: 0.72rem;
		font-weight: 720;
		text-underline-offset: 3px;
	}

	.text-link svg {
		width: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.site-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.4rem 0 2.2rem;
		border-top: 1px solid var(--line);
		color: var(--faint);
		font-size: 0.66rem;
	}

	.site-footer span:first-child {
		color: var(--ink);
		font-weight: 750;
	}

	.dialog-layer {
		position: fixed;
		z-index: 50;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1.2rem;
	}

	.dialog-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(10, 17, 31, 0.68);
		backdrop-filter: blur(3px);
		animation: fade-in 130ms ease-out;
	}

	.dialog {
		position: relative;
		width: min(100%, 620px);
		max-height: calc(100vh - 2.4rem);
		overflow: auto;
		border: 1px solid rgba(255, 255, 255, 0.35);
		border-radius: 10px;
		background: var(--paper);
		box-shadow: var(--shadow-md);
		animation: dialog-in 180ms ease-out;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}

	@keyframes dialog-in {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.985);
		}
	}

	.dialog-header {
		display: flex;
		gap: 1rem;
		align-items: flex-start;
		justify-content: space-between;
		padding: 1.5rem 1.5rem 1.2rem;
		border-bottom: 1px solid var(--line);
	}

	.dialog-header p:last-child {
		margin: 0.45rem 0 0;
		color: var(--muted);
		font-size: 0.74rem;
	}

	.icon-button {
		display: grid;
		width: 34px;
		height: 34px;
		flex: 0 0 auto;
		place-items: center;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: white;
		cursor: pointer;
	}

	.icon-button:hover {
		background: var(--paper-soft);
	}

	.icon-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.icon-button svg {
		width: 17px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.7;
		stroke-linecap: round;
	}

	.history-dialog {
		width: min(100%, 720px);
	}

	.rewards-dialog {
		width: min(100%, 760px);
	}

	.reward-details-body {
		padding: 1.4rem 1.5rem 1.5rem;
	}

	.reward-detected-note {
		display: flex;
		gap: 0.7rem;
		align-items: center;
		padding: 0.8rem 0.9rem;
		border: 1px solid #bddccf;
		border-radius: 10px;
		color: #245c48;
		background: #eef8f3;
	}

	.reward-detected-note svg {
		width: 20px;
		height: 20px;
		padding: 3px;
		border-radius: 50%;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		background: #d8eee4;
	}

	.reward-detected-note div {
		display: grid;
		gap: 0.12rem;
	}

	.reward-detected-note strong {
		font-size: 0.72rem;
	}

	.reward-detected-note span {
		font-size: 0.63rem;
	}

	.reward-profile-summary {
		display: grid;
		grid-template-columns: minmax(0, 1.7fr) 1fr 1fr;
		margin-top: 1rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		overflow: hidden;
	}

	.reward-profile-summary > div {
		display: grid;
		gap: 0.3rem;
		padding: 0.85rem 0.9rem;
		background: white;
	}

	.reward-profile-summary > div + div {
		border-left: 1px solid var(--line);
	}

	.reward-profile-summary span,
	.reward-profile-categories h3 {
		color: var(--faint);
		font-size: 0.6rem;
		font-weight: 650;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.reward-profile-summary strong {
		font-size: 0.76rem;
	}

	.reward-profile-categories {
		margin-top: 1rem;
		padding: 0.95rem;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--paper-soft);
	}

	.reward-profile-categories h3,
	.reward-profile-categories p,
	.reward-profile-categories ul {
		margin: 0;
	}

	.reward-profile-categories ul {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem;
		margin-top: 0.7rem;
		padding: 0;
		list-style: none;
	}

	.reward-profile-categories li {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.8rem;
		align-items: center;
		padding: 0.65rem 0.7rem;
		border: 1px solid var(--line);
		border-radius: 8px;
		font-size: 0.68rem;
		background: white;
	}

	.reward-profile-categories li > div {
		display: grid;
		min-width: 0;
		gap: 0.12rem;
	}

	.reward-profile-categories li small {
		color: var(--muted);
		font-size: 0.56rem;
	}

	.reward-profile-categories li strong {
		color: #2d47bd;
		font-size: 0.7rem;
	}

	.reward-profile-categories p {
		margin-top: 0.7rem;
		color: var(--muted);
		font-size: 0.63rem;
		line-height: 1.5;
	}

	.reward-profile-missing {
		padding: 1.3rem;
		border: 1px dashed var(--line-strong);
		border-radius: 10px;
		text-align: center;
		background: var(--paper-soft);
	}

	.reward-profile-missing strong {
		font-size: 0.78rem;
	}

	.reward-profile-missing p {
		margin: 0.35rem 0 0;
		color: var(--muted);
		font-size: 0.67rem;
	}

	.reward-profile-picker {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 0.55rem;
		margin: 1rem auto 0;
		max-width: 500px;
		text-align: left;
	}

	.reward-profile-picker label {
		grid-column: 1 / -1;
		color: var(--muted);
		font-size: 0.62rem;
		font-weight: 680;
	}

	.reward-profile-picker select {
		width: 100%;
		min-height: 42px;
		padding: 0.62rem 0.7rem;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		color: var(--ink);
		font-size: 0.72rem;
		background: white;
	}

	.reward-profile-picker .button {
		min-height: 42px;
		white-space: nowrap;
	}

	.reward-detail-actions {
		margin-top: 1.1rem;
	}

	.manual-reward-warning {
		margin: 0 0 1rem;
		padding: 0.7rem 0.8rem;
		border: 1px solid #ead9ad;
		border-radius: 8px;
		color: #76591f;
		font-size: 0.64rem;
		background: #fff9e9;
	}

	.history-body {
		padding: 0 1.5rem 1.5rem;
	}

	.history-sync-note {
		display: flex;
		min-height: 44px;
		gap: 0.35rem;
		align-items: center;
		color: var(--faint);
		font-size: 0.64rem;
	}

	.transaction-list {
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 12px;
		list-style: none;
		overflow: hidden;
	}

	.transaction-list li {
		display: grid;
		grid-template-columns: 62px minmax(0, 1fr) auto;
		gap: 0.8rem;
		align-items: center;
		padding: 0.8rem 0.9rem;
		background: white;
	}

	.transaction-list li + li {
		border-top: 1px solid var(--line);
	}

	.transaction-date,
	.transaction-details {
		display: grid;
		min-width: 0;
		gap: 0.2rem;
	}

	.transaction-date strong,
	.transaction-details strong,
	.transaction-amount {
		font-size: 0.72rem;
		font-weight: 710;
	}

	.transaction-date span,
	.transaction-details span {
		color: var(--faint);
		font-size: 0.6rem;
	}

	.transaction-details strong,
	.transaction-details span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.transaction-details .transaction-reward {
		color: #5b4b91;
		font-weight: 650;
	}

	.transaction-amount {
		font-variant-numeric: tabular-nums;
	}

	.transaction-amount.credit {
		color: var(--positive);
	}

	.history-loading {
		display: grid;
		gap: 0.55rem;
	}

	.history-loading span {
		height: 54px;
		border-radius: 9px;
		background: linear-gradient(90deg, #e8e2d8 25%, #f8f5ee 50%, #e8e2d8 75%);
		background-size: 200% 100%;
		animation: shimmer 1.5s infinite;
	}

	.history-empty,
	.history-error {
		padding: 2.5rem 1rem;
		border: 1px dashed var(--line-strong);
		border-radius: 12px;
		text-align: center;
		background: var(--paper-soft);
	}

	.history-empty h3,
	.history-empty p,
	.history-error strong,
	.history-error span {
		margin: 0;
	}

	.history-empty h3,
	.history-error strong {
		display: block;
		font-size: 0.8rem;
	}

	.history-empty p,
	.history-error span {
		display: block;
		margin-top: 0.35rem;
		color: var(--muted);
		font-size: 0.68rem;
	}

	.history-error button {
		margin-top: 0.9rem;
		padding: 0.45rem 0.7rem;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		color: var(--ink);
		font-size: 0.66rem;
		font-weight: 700;
		background: white;
		cursor: pointer;
	}

	.card-form {
		padding: 1.4rem 1.5rem 1.5rem;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.field {
		display: grid;
		gap: 0.42rem;
		min-width: 0;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.field > span {
		display: flex;
		align-items: center;
		justify-content: space-between;
		color: #414858;
		font-size: 0.69rem;
		font-weight: 680;
	}

	.field em,
	.field small {
		color: var(--faint);
		font-size: 0.59rem;
		font-style: normal;
		font-weight: 550;
	}

	.field input,
	.field select,
	.money-input,
	.rate-input {
		width: 100%;
		min-width: 0;
		min-height: 42px;
		border: 1px solid var(--line-strong);
		border-radius: 9px;
		color: var(--ink);
		background: white;
		transition:
			border-color 140ms ease,
			box-shadow 140ms ease;
	}

	.field > input,
	.field > select {
		padding: 0.62rem 0.7rem;
		font-size: 0.78rem;
	}

	.field input::placeholder {
		color: #a1aaa4;
	}

	.field input:focus,
	.field select:focus,
	.money-input:focus-within,
	.rate-input:focus-within {
		border-color: var(--accent);
		outline: 0;
		box-shadow: 0 0 0 3px rgba(61, 90, 254, 0.12);
	}

	.money-input {
		display: flex;
		align-items: center;
		overflow: hidden;
	}

	.money-input > span {
		padding-left: 0.7rem;
		color: var(--muted);
		font-size: 0.75rem;
	}

	.money-input input {
		min-height: 40px;
		padding: 0.62rem 0.7rem 0.62rem 0.25rem;
		border: 0;
		border-radius: 0;
		font-size: 0.78rem;
		outline: 0;
	}

	.rate-input {
		display: flex;
		align-items: center;
		overflow: hidden;
	}

	.rate-input input {
		width: 100%;
		min-width: 0;
		min-height: 36px;
		padding: 0.55rem 0.25rem 0.55rem 0.62rem;
		border: 0;
		border-radius: 0;
		font-size: 0.76rem;
		outline: 0;
	}

	.rate-input > span {
		padding-right: 0.65rem;
		color: var(--muted);
		font-size: 0.72rem;
		font-weight: 700;
	}

	.reward-category-editor {
		margin-top: 1rem;
		padding: 0.9rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper-soft);
	}

	.reward-category-editor > header {
		display: flex;
		gap: 1rem;
		align-items: center;
		justify-content: space-between;
	}

	.reward-category-editor h3,
	.reward-category-editor p {
		margin: 0;
	}

	.reward-category-editor h3 {
		font-size: 0.74rem;
		font-weight: 730;
	}

	.reward-category-editor header p {
		margin-top: 0.2rem;
		color: var(--muted);
		font-size: 0.62rem;
	}

	.reward-category-editor header button {
		min-height: 32px;
		padding: 0.42rem 0.58rem;
		border: 1px solid #b9c3f5;
		border-radius: 7px;
		color: var(--accent);
		font-size: 0.65rem;
		font-weight: 700;
		background: white;
		cursor: pointer;
	}

	.reward-category-editor button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.reward-category-rows {
		display: grid;
		gap: 0.6rem;
		margin-top: 0.8rem;
	}

	.reward-category-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 145px 105px 32px;
		gap: 0.5rem;
		align-items: end;
	}

	.reward-category-row label {
		display: grid;
		min-width: 0;
		gap: 0.32rem;
	}

	.reward-category-row label > span {
		color: var(--muted);
		font-size: 0.59rem;
		font-weight: 650;
	}

	.reward-category-row input,
	.reward-category-row select,
	.reward-category-row .rate-input {
		width: 100%;
		min-width: 0;
		min-height: 38px;
		padding: 0.55rem 0.62rem;
		border: 1px solid var(--line-strong);
		border-radius: 8px;
		font-size: 0.72rem;
		background: white;
	}

	.reward-category-row input:focus,
	.reward-category-row select:focus,
	.reward-category-row .rate-input:focus-within {
		border-color: var(--accent);
		outline: 0;
		box-shadow: 0 0 0 3px rgba(61, 90, 254, 0.12);
	}

	.reward-category-row .rate-input input {
		min-height: 36px;
		border: 0;
		box-shadow: none;
	}

	.remove-reward-category {
		display: grid;
		width: 32px;
		height: 38px;
		place-items: center;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: 8px;
		color: var(--muted);
		background: white;
		cursor: pointer;
	}

	.remove-reward-category:hover:not(:disabled) {
		color: var(--red);
		border-color: #dfbbb7;
	}

	.remove-reward-category svg {
		width: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
	}

	.reward-categories-empty {
		margin-top: 0.8rem;
		padding: 0.75rem;
		border: 1px dashed var(--line-strong);
		border-radius: 8px;
		color: var(--faint);
		font-size: 0.65rem;
		text-align: center;
		background: white;
	}

	.checkbox-field {
		display: flex;
		gap: 0.65rem;
		align-items: flex-start;
		margin-top: 1rem;
		padding: 0.85rem;
		border: 1px solid var(--line);
		border-radius: 9px;
		background: var(--paper-soft);
		cursor: pointer;
	}

	.checkbox-field input {
		width: 16px;
		height: 16px;
		margin: 0.08rem 0 0;
		accent-color: var(--accent);
	}

	.checkbox-field span {
		display: grid;
		gap: 0.2rem;
	}

	.checkbox-field strong {
		font-size: 0.71rem;
	}

	.checkbox-field small {
		color: var(--muted);
		font-size: 0.64rem;
	}

	.form-error {
		margin: 1rem 0 0;
		padding: 0.7rem 0.8rem;
		border-radius: 8px;
		color: #8e3030;
		font-size: 0.72rem;
		background: var(--red-soft);
	}

	.dialog-actions {
		justify-content: flex-end;
		margin-top: 1.25rem;
		padding-top: 1.15rem;
		border-top: 1px solid var(--line);
	}

	.toast {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		z-index: 80;
		display: flex;
		max-width: min(390px, calc(100vw - 2.5rem));
		gap: 0.65rem;
		align-items: center;
		padding: 0.8rem 0.9rem;
		border: 1px solid #add4ce;
		border-radius: 8px;
		font-size: 0.75rem;
		font-weight: 600;
		background: #effaf8;
		box-shadow: var(--shadow-md);
		animation: toast-in 180ms ease-out;
	}

	.toast.error {
		border-color: #e8b9b5;
		background: #fff6f5;
	}

	.toast-icon {
		display: grid;
		width: 21px;
		height: 21px;
		flex: 0 0 auto;
		place-items: center;
		border-radius: 50%;
		color: white;
		font-size: 0.68rem;
		background: var(--positive);
	}

	.toast.error .toast-icon {
		background: var(--red);
	}

	.toast button {
		margin-left: auto;
		padding: 0.1rem 0.3rem;
		border: 0;
		color: var(--muted);
		font-size: 1.1rem;
		background: transparent;
		cursor: pointer;
	}

	@keyframes toast-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}

	@media (max-width: 1100px) {
		.card-grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	@media (max-width: 900px) {
		.hero {
			align-items: flex-start;
			flex-direction: column;
		}

		.hero-action-stack {
			padding-bottom: 0;
		}

		.card-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.info-grid {
			grid-template-columns: 1fr;
		}
	}

	@media (max-width: 680px) {
		.auth-shell {
			padding: 1rem;
		}

		.auth-card {
			padding: 1.4rem;
		}

		.app-shell {
			width: min(100% - 1.5rem, 1180px);
		}

		.site-header {
			height: 68px;
		}

		.hero {
			gap: 1.5rem;
			padding: 3rem 0 2.2rem;
		}

		.dashboard-toolbar {
			gap: 1rem;
			align-items: stretch;
			flex-direction: column;
			padding: 1.75rem 0 1.1rem;
		}

		.dashboard-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.dashboard-actions .button {
			width: 100%;
		}

		.hero h1 {
			font-size: clamp(2.25rem, 13vw, 3.25rem);
		}

		.hero-action-stack,
		.hero-actions {
			width: 100%;
		}

		.plaid-consent {
			text-align: left;
		}

		.hero-actions .button {
			flex: 1;
		}

		.summary-grid {
			grid-template-columns: 1fr;
		}

		.summary-card + .summary-card {
			border-top: 1px solid var(--line);
			border-left: 0;
		}

		.overview-summary .summary-card + .summary-card {
			border-left: 1px solid var(--line);
		}

		.workspace-modules {
			grid-template-columns: 1fr;
		}

		.cards-section {
			padding: 3.2rem 0;
		}

		.card-grid {
			grid-template-columns: 1fr;
		}

		.credit-card {
			min-height: 350px;
		}

		.info-panel {
			padding: 1.3rem;
		}

		.form-grid {
			grid-template-columns: 1fr;
		}

		.reward-category-row {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 32px;
		}

		.reward-category-row > label:first-child {
			grid-column: 1 / 3;
		}

		.reward-category-row > .remove-reward-category {
			grid-row: 1;
			grid-column: 3;
		}

		.field-wide {
			grid-column: auto;
		}

		.dialog-layer {
			align-items: end;
			padding: 0;
		}

		.dialog {
			width: 100%;
			max-height: 94vh;
			border-radius: 17px 17px 0 0;
		}

		.dialog-header,
		.card-form,
		.history-body,
		.reward-details-body,
		.calendar-dialog-body {
			padding-right: 1.15rem;
			padding-left: 1.15rem;
		}

		.reward-profile-summary {
			grid-template-columns: 1fr 1fr;
		}

		.reward-profile-summary .reward-profile-program {
			grid-column: 1 / -1;
			border-bottom: 1px solid var(--line);
		}

		.reward-profile-summary > div:nth-child(2) {
			border-left: 0;
		}

		.reward-profile-categories ul {
			grid-template-columns: 1fr;
		}

		.reward-profile-picker {
			grid-template-columns: 1fr;
		}

		.reward-profile-picker label {
			grid-column: auto;
		}

		.transaction-list li {
			grid-template-columns: 52px minmax(0, 1fr) auto;
			gap: 0.55rem;
			padding: 0.72rem;
		}

		.site-footer {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.35rem;
		}
	}

	@media (max-width: 430px) {
		.card-rewards ul {
			grid-template-columns: 1fr;
		}

		.header-controls {
			gap: 0.5rem;
		}

		.hero-actions {
			align-items: stretch;
			flex-direction: column-reverse;
		}

		.section-heading {
			align-items: flex-start;
			flex-direction: column;
			gap: 0.8rem;
		}

		.info-panel {
			flex-direction: column;
		}

		.connection-list > li {
			align-items: stretch;
			flex-direction: column;
		}

		.google-access-heading {
			align-items: flex-start;
			flex-wrap: wrap;
		}

		.google-link-button {
			margin-left: 0;
		}

		.plaid-setup-form {
			grid-template-columns: 1fr;
		}

		.plaid-personal-ready {
			align-items: flex-start;
			flex-wrap: wrap;
		}

		.plaid-personal-ready .plaid-ready-actions {
			width: 100%;
		}

		.plaid-ready-actions .button {
			flex: 1;
		}

		.connection-actions button {
			flex: 1;
		}

		.calendar-event-list li {
			align-items: stretch;
			flex-direction: column;
		}

		.calendar-event-list .button {
			width: 100%;
		}

		.calendar-dialog-actions {
			align-items: stretch;
			flex-direction: column-reverse;
		}
	}
</style>
