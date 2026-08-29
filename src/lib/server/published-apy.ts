import type { FinancialAccount } from '$lib/types';

const RATE_CACHE_MS = 6 * 60 * 60 * 1_000;
const MAX_SOURCE_BYTES = 1_000_000;
const SOURCE_TIMEOUT_MS = 5_000;

interface PublishedApyDefinition {
	id: 'sofi-savings' | 'vio-online-savings' | 'wealthfront-cash';
	url: string;
	matches: (account: FinancialAccount) => boolean;
	extract: (html: string) => number | null;
}

interface CachedPublishedApy {
	basisPoints: number;
	checkedAt: string;
	expiresAt: number;
}

const successfulRates = new Map<PublishedApyDefinition['id'], CachedPublishedApy>();
const inFlightRates = new Map<PublishedApyDefinition['id'], Promise<CachedPublishedApy | null>>();

function normalizedAccountText(account: FinancialAccount): string {
	return `${account.institution ?? ''} ${account.nickname}`.toLowerCase();
}

function percentToBasisPoints(value: string | undefined): number | null {
	if (!value) return null;
	const percent = Number(value);
	if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
	return Math.round(percent * 100);
}

function extractFirstPercent(html: string, pattern: RegExp): number | null {
	return percentToBasisPoints(pattern.exec(html)?.[1]);
}

const definitions: PublishedApyDefinition[] = [
	{
		id: 'sofi-savings',
		url: 'https://www.sofi.com/banking/high-yield-savings-account/savings-account-interest-rates-apy/',
		matches: (account) =>
			account.accountType === 'savings' && normalizedAccountText(account).includes('sofi'),
		extract: (html) =>
			extractFirstPercent(
				html,
				/High-Yield APY[\s\S]{0,500}?class=["']apy["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)%/i
			)
	},
	{
		id: 'vio-online-savings',
		url: 'https://www.viobank.com/online-savings-account',
		matches: (account) =>
			account.accountType === 'savings' && normalizedAccountText(account).includes('vio bank'),
		extract: (html) =>
			extractFirstPercent(
				html,
				/Online Savings Account APY:[\s\S]{0,300}?class=["']apy["'][^>]*>\s*([0-9]+(?:\.[0-9]+)?)%/i
			)
	},
	{
		id: 'wealthfront-cash',
		url: 'https://www.wealthfront.com/cash/',
		matches: (account) =>
			account.accountType !== 'brokerage' &&
			normalizedAccountText(account).includes('wealthfront') &&
			normalizedAccountText(account).includes('cash'),
		extract: (html) => extractFirstPercent(html, /base\s+([0-9]+(?:\.[0-9]+)?)%\s+APY/i)
	}
];

async function fetchPublishedApy(
	definition: PublishedApyDefinition
): Promise<CachedPublishedApy | null> {
	const cached = successfulRates.get(definition.id);
	if (cached && cached.expiresAt > Date.now()) return cached;

	const pending = inFlightRates.get(definition.id);
	if (pending) return pending;

	const request = (async () => {
		try {
			const response = await fetch(definition.url, {
				headers: {
					Accept: 'text/html',
					'User-Agent': 'ChipDue APY monitor/1.0'
				},
				cache: 'no-store',
				signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS)
			});
			if (!response.ok) return cached ?? null;
			const html = await response.text();
			if (html.length > MAX_SOURCE_BYTES) return cached ?? null;
			const basisPoints = definition.extract(html);
			if (basisPoints === null) return cached ?? null;
			const checkedAt = new Date().toISOString();
			const result = {
				basisPoints,
				checkedAt,
				expiresAt: Date.now() + RATE_CACHE_MS
			};
			successfulRates.set(definition.id, result);
			return result;
		} catch {
			return cached ?? null;
		} finally {
			inFlightRates.delete(definition.id);
		}
	})();
	inFlightRates.set(definition.id, request);
	return request;
}

export async function addPublishedAccountApys(
	accounts: FinancialAccount[]
): Promise<FinancialAccount[]> {
	const applicableDefinitions = definitions.filter((definition) =>
		accounts.some(
			(account) =>
				account.source === 'connected' &&
				account.apySource !== 'provider' &&
				definition.matches(account)
		)
	);
	if (applicableDefinitions.length === 0) return accounts;

	const rates = new Map(
		await Promise.all(
			applicableDefinitions.map(
				async (definition) => [definition.id, await fetchPublishedApy(definition)] as const
			)
		)
	);

	return accounts.map((account) => {
		if (account.source !== 'connected' || account.apySource === 'provider') return account;
		const definition = applicableDefinitions.find((candidate) => candidate.matches(account));
		const rate = definition ? rates.get(definition.id) : null;
		if (!rate) return account;
		return {
			...account,
			apyBasisPoints: rate.basisPoints,
			apySource: 'published',
			apyUpdatedAt: rate.checkedAt
		};
	});
}

export function resetPublishedApyCacheForTests(): void {
	successfulRates.clear();
	inFlightRates.clear();
}
