import type {
	BrokerageHistoryEstimateResponse,
	FinancialAccount,
	FinancialAccountTransaction,
	InvestmentHolding
} from '$lib/types';
import { isCashSweepSecurity } from '$lib/investment-display';
import {
	reconstructBrokerageHistory,
	type BrokeragePositionInput,
	type BrokerageTransactionInput
} from './brokerage-history';
import { AppError } from './errors';
import { rebuildEtradeBrokerageHistory } from './etrade';
import {
	getFinancialAccount,
	listFinancialAccountTransactions,
	replaceEstimatedFinancialAccountHistory
} from './financial-records';
import { historicalCloseSeries } from './market-history';

const CASH_SECURITY = /cash|money.?market/i;

function unavailable(
	provider: BrokerageHistoryEstimateResponse['provider'],
	availability: BrokerageHistoryEstimateResponse['availability']
): BrokerageHistoryEstimateResponse {
	return {
		availability,
		provider,
		account: null,
		estimatedPointCount: 0,
		startDate: null,
		endDate: null,
		unpricedSymbols: [],
		refreshedAt: null
	};
}

function holdingValue(holding: InvestmentHolding): number {
	if (holding.valueCents !== null) return holding.valueCents / 100;
	return holding.quantity * (holding.priceMicros / 1_000_000);
}

function isCashHolding(holding: InvestmentHolding): boolean {
	return CASH_SECURITY.test(
		`${holding.securityType ?? ''} ${holding.tickerSymbol ?? ''} ${holding.name}`
	);
}

function plaidPosition(holding: InvestmentHolding): BrokeragePositionInput | null {
	if (!holding.tickerSymbol) return null;
	return {
		symbol: holding.tickerSymbol,
		securityType: holding.securityType ?? '',
		quantity: holding.quantity,
		marketValue: holdingValue(holding)
	};
}

function plaidTransaction(
	transaction: FinancialAccountTransaction,
	holdings: InvestmentHolding[]
): BrokerageTransactionInput | null {
	const details = transaction.investmentDetails;
	if (!details || transaction.pending) return null;
	const holding = holdings.find(
		(candidate) =>
			candidate.tickerSymbol &&
			candidate.tickerSymbol.toUpperCase() === details.tickerSymbol?.toUpperCase()
	);
	return {
		date: transaction.date,
		// Plaid expresses investment purchases as positive outflows and sales as negative inflows.
		// The reconstruction engine uses the account's cash-direction convention instead.
		amount: -transaction.amountCents / 100,
		transactionType: `${details.type} ${details.subtype} ${transaction.name}`,
		symbol: details.tickerSymbol,
		securityType: holding?.securityType ?? '',
		quantity: details.quantity,
		externalCashFlow:
			!isCashSweepSecurity(details.tickerSymbol, details.securityName) &&
			(/^(?:contribution|deposit|withdrawal)$/.test(details.subtype.toLowerCase()) ||
				(details.type.toLowerCase() === 'transfer' && details.subtype.toLowerCase() === 'transfer'))
	};
}

async function rebuildPlaidBrokerageHistory(
	account: FinancialAccount
): Promise<BrokerageHistoryEstimateResponse> {
	if (
		account.accountType !== 'brokerage' ||
		account.source !== 'connected' ||
		account.connectionProvider !== 'plaid'
	) {
		return unavailable('plaid', 'account_not_found');
	}
	if (!account.transactionHistoryEnabled) return unavailable('plaid', 'activity_required');

	const activity = await listFinancialAccountTransactions(account.id, 10_000);
	const positions = account.holdings.flatMap((holding) => {
		const position = plaidPosition(holding);
		return position ? [position] : [];
	});
	const transactions = activity.transactions.flatMap((transaction) => {
		const input = plaidTransaction(transaction, account.holdings);
		return input ? [input] : [];
	});
	const end = new Date();
	end.setUTCHours(0, 0, 0, 0);
	end.setUTCDate(end.getUTCDate() - 1);
	const start = new Date(end);
	start.setUTCFullYear(start.getUTCFullYear() - 2);
	const startDate = start.toISOString().slice(0, 10);
	const endDate = end.toISOString().slice(0, 10);
	const symbols = [
		...positions.map((position) => position.symbol),
		...transactions.flatMap((transaction) => (transaction.symbol ? [transaction.symbol] : []))
	];
	const prices = await historicalCloseSeries(symbols, startDate, endDate);
	const totalHoldingValue = account.holdings.reduce(
		(total, holding) => total + holdingValue(holding),
		0
	);
	const reportedCashValue = account.holdings
		.filter(isCashHolding)
		.reduce((total, holding) => total + holdingValue(holding), 0);
	const unallocatedValue =
		account.currentBalanceCents === null
			? 0
			: account.currentBalanceCents / 100 - totalHoldingValue;
	const estimate = reconstructBrokerageHistory(
		account,
		positions,
		reportedCashValue + unallocatedValue,
		transactions,
		prices,
		startDate,
		endDate
	);
	if (estimate.points.length === 0) {
		throw new AppError(
			'MARKET_HISTORY_UNAVAILABLE',
			'Historical closing prices are temporarily unavailable for this portfolio.',
			502
		);
	}
	const updatedAccount = await replaceEstimatedFinancialAccountHistory(
		account.id,
		estimate.points,
		{
			latestObservedNetContributionsCents: estimate.currentNetContributionsCents
		}
	);
	return {
		availability: 'available',
		provider: 'plaid',
		account: updatedAccount,
		estimatedPointCount: updatedAccount.balanceHistory.filter(
			(point) => point.source === 'estimated'
		).length,
		startDate,
		endDate,
		unpricedSymbols: estimate.unpricedSymbols,
		refreshedAt: new Date().toISOString()
	};
}

export async function rebuildBrokerageHistory(
	financialAccountId: string
): Promise<BrokerageHistoryEstimateResponse> {
	const account = await getFinancialAccount(financialAccountId);
	if (/(?:^|\b)e\s*\*?\s*trade(?:\b|$)/i.test(account.institution ?? '')) {
		return rebuildEtradeBrokerageHistory(account.id);
	}
	return rebuildPlaidBrokerageHistory(account);
}
