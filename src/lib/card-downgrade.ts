import { getBonusChurnToday } from './bonus-churn';

export interface CardDowngradeDates {
	safeToCloseDate: string | null;
	feeFreeDowngradeDate?: string | null;
	feeFreeDowngradeDateSource?: 'issuer_confirmed' | 'estimated';
}

export function cardDowngradeTiming(bonus: CardDowngradeDates, today = getBonusChurnToday()) {
	const deadline = bonus.feeFreeDowngradeDate ?? null;
	const earliest = bonus.safeToCloseDate;
	const estimated = Boolean(deadline && bonus.feeFreeDowngradeDateSource === 'estimated');
	if (!deadline) {
		return {
			deadline,
			estimated,
			earliest,
			conflict: false,
			expired: false,
			message:
				'The latest fee-free date is not confirmed. The bonus hold date does not establish when an annual fee starts. Confirm the latest effective downgrade date with your issuer.'
		};
	}
	if (deadline < today) {
		return {
			deadline,
			estimated,
			earliest,
			conflict: false,
			expired: true,
			message:
				'This fee deadline has passed. Confirm current fee terms with your issuer before planning a downgrade.'
		};
	}
	const conflict = Boolean(earliest && deadline < earliest);
	return {
		deadline,
		estimated,
		earliest,
		conflict,
		expired: false,
		message: estimated
			? conflict
				? 'This estimated deadline falls before the saved bonus hold ends. Downgrading by then could put your bonus at risk. Fee timing still needs issuer confirmation.'
				: 'Estimated from the saved offer terms. Allow time for the downgrade to take effect; the exact fee cutoff still needs issuer confirmation.'
			: conflict
				? 'No fee-free window with the saved dates: the fee deadline is before the bonus hold ends. Ask your issuer to resolve this before downgrading.'
				: earliest
					? 'Use the saved issuer-confirmed deadline for the downgrade to take effect. The earliest date is the saved bonus hold date; all other offer requirements still apply.'
					: 'The fee deadline is saved, but the bonus hold date is missing. Confirm when you can downgrade without risking the bonus.'
	};
}
