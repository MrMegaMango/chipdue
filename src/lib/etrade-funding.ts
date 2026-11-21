import type { FinancialAccountTransaction } from '#lib/types.ts';
import { isCashSweepSecurity } from './investment-display.ts';

export interface EtradeFunding {
	netCents: number;
	depositsCents: number;
	withdrawalsCents: number;
	reviewCount: number;
}

const FUNDING_SUBTYPE = /^(?:deposit|withdrawal|contribution|transfer|send)$/;
const EXTERNAL_RAIL =
	/\b(?:ACH|WIRE|FEDWIRE|ACATS?|EXTERNAL|DIRECT DEPOSIT|CHECK DEPOSIT|DEPOSIT BY CHECK)\b/;
const TRANSFER = /\b(?:DEPOSIT|WITHDRAWAL|WITHDRAWL|TRANSFER|CONTRIBUTION)\b/;
const AFFILIATED = /\b(?:E ?TRADE|MORGAN STANLEY|MSPBNA)\b/;
const INTERNAL = /\b(?:INTERNAL|JOURNAL(?:ED)?|BETWEEN (?:MY |YOUR )?ACCOUNTS)\b/;
const NON_FUNDING =
	/\b(?:SWEEP|DIVIDENDS?|INTEREST|PROMO(?:TION(?:AL)?)?|BONUS|REWARDS?|REINVESTMENT|CAPITAL GAINS?|FEES?|MICRODEPOSITS?|ACCTVERIFY)\b/;
const UNPOSTED = /\b(?:REQUEST(?:ED)?|SCHEDULED|PENDING|FAILED|REJECTED|CANCELLED|CANCELED)\b/;

function fundingMovement(transaction: FinancialAccountTransaction): 'count' | 'review' | null {
	const details = transaction.investmentDetails;
	const name = transaction.name
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim();
	const category = transaction.categoryPrimary?.toUpperCase();
	// Older synced records can have the provider's "type: subtype" category only.
	const [type, subtype] = details
		? [details.type.toLowerCase(), details.subtype.toLowerCase()]
		: category === 'INVESTMENT'
			? (transaction.categoryDetailed ?? '').toLowerCase().split(/\s*:\s*/)
			: [];
	const externalRail = EXTERNAL_RAIL.test(name);
	const reversal = externalRail && /\b(?:REVERSAL|REVERSED|RETURNED|ACH RETURN)\b/.test(name);
	if (type && type !== 'cash' && type !== 'transfer') return null;
	if (subtype && !FUNDING_SUBTYPE.test(subtype) && !(reversal && subtype === 'adjustment')) {
		return null;
	}
	if (
		isCashSweepSecurity(details?.tickerSymbol, details?.securityName) ||
		NON_FUNDING.test(name) ||
		UNPOSTED.test(name)
	) {
		return null;
	}
	const namedTransfer = TRANSFER.test(name);
	if (!externalRail && !namedTransfer) {
		if (type === 'transfer') return 'review';
		// A cash credit labeled only with its security is commonly an ETF distribution.
		if (details?.tickerSymbol || details?.securityName || !FUNDING_SUBTYPE.test(subtype ?? ''))
			return null;
	}
	const source = details
		? name
		: `${name} ${transaction.merchantName ?? ''}`.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
	if (AFFILIATED.test(source) || INTERNAL.test(name)) {
		// Internal credits cannot add new money. A transfer out could reduce the reward
		// if its destination was outside the offer's eligible linked accounts.
		return transaction.amountCents > 0 && (namedTransfer || externalRail) ? 'review' : null;
	}
	// An ACH, wire or ACATS entry is evidence of a transfer. An unspecified transfer
	// or an in-kind transfer without a reported dollar value needs a broker check.
	return externalRail && transaction.amountCents !== 0 ? 'count' : 'review';
}

export function calculateEtradeFunding(
	transactions: FinancialAccountTransaction[],
	openedDate: string,
	fundingDeadline: string,
	currency: string
): EtradeFunding {
	let depositsCents = 0;
	let withdrawalsCents = 0;
	let reviewCount = 0;
	const seen = new Set<string>();
	for (const transaction of transactions) {
		if (
			transaction.pending ||
			transaction.date < openedDate ||
			transaction.date > fundingDeadline ||
			seen.has(transaction.id)
		)
			continue;
		seen.add(transaction.id);
		const movement = fundingMovement(transaction);
		if (!movement) continue;
		if (movement === 'review' || transaction.currency !== currency) {
			reviewCount++;
			continue;
		}
		// Plaid reports incoming funds as negative and outgoing funds as positive.
		if (transaction.amountCents < 0) depositsCents -= transaction.amountCents;
		else withdrawalsCents += transaction.amountCents;
	}
	return {
		netCents: depositsCents - withdrawalsCents,
		depositsCents,
		withdrawalsCents,
		reviewCount
	};
}
