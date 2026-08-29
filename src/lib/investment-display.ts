export type CashSweepAction = 'added' | 'used' | 'moved';

export function isCashSweepSecurity(
	tickerSymbol: string | null | undefined,
	securityName: string | null | undefined
): boolean {
	return (
		tickerSymbol?.toUpperCase() === 'QACDS' || /(?:cash|deposit)\s+sweep/i.test(securityName ?? '')
	);
}

export function cashSweepAction(type: string, subtype: string): CashSweepAction {
	const movement = (subtype || type).toLowerCase();
	if (movement === 'sell' || movement === 'withdrawal') return 'used';
	if (movement === 'buy' || movement === 'deposit') return 'added';
	return 'moved';
}
