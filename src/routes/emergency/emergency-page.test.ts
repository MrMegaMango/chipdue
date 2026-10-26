import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EmergencySnapshot } from '$lib/emergency';
import type { AccountBonus, Card } from '$lib/types';
import { savedDeadlines, savedSessionChanged } from './+page.svelte';

function snapshot(
	cards: Partial<Card>[] = [],
	bonuses: Partial<AccountBonus>[] = []
): EmergencySnapshot {
	return {
		version: 1,
		capturedAt: '2026-10-24T15:00:00Z',
		cards: cards as Card[],
		accounts: [],
		bonuses: bonuses as AccountBonus[],
		activity: [],
		transactionLimit: 100
	};
}

describe('saved-finances deadlines', () => {
	it('reloads after an account switch while leaving an unchanged session alone', () => {
		const first = { configured: true, authenticated: true, sessionRef: 'first-session' };
		expect(savedSessionChanged(null, first)).toBe(true);
		expect(savedSessionChanged(first, { ...first })).toBe(false);
		expect(savedSessionChanged(first, { ...first, sessionRef: 'second-session' })).toBe(true);
		expect(savedSessionChanged(first, { ...first, authenticated: false, sessionRef: null })).toBe(
			false
		);
	});

	it('puts today and upcoming dates before past saved dates without declaring them overdue', () => {
		const saved = snapshot([
			{ id: 'older', nickname: 'Older card', dueDate: '2026-10-01' },
			{ id: 'soon', nickname: 'Soon card', dueDate: '2026-10-28' },
			{ id: 'today', nickname: 'Today card', dueDate: '2026-10-25' },
			{ id: 'yesterday', nickname: 'Recent card', dueDate: '2026-10-24' },
			{ id: 'unknown', nickname: 'Unknown card', dueDate: null }
		]);
		expect(savedDeadlines(saved, '2026-10-25').map((deadline) => deadline.id)).toEqual([
			'card:today',
			'card:soon',
			'card:yesterday',
			'card:older'
		]);
		expect(saved.cards[0].id).toBe('older');
	});

	it('does not present paid or abandoned offers as still awaiting qualification or payout', () => {
		const saved = snapshot(
			[],
			[
				{
					id: 'paid',
					name: 'Paid offer',
					status: 'paid',
					requirementDeadline: '2026-10-20',
					expectedPayoutDate: '2026-10-22',
					safeToCloseDate: '2027-01-01',
					feeFreeDowngradeDate: null
				},
				{
					id: 'abandoned',
					name: 'Abandoned offer',
					status: 'abandoned',
					requirementDeadline: '2026-10-26',
					expectedPayoutDate: '2026-10-30',
					safeToCloseDate: null,
					feeFreeDowngradeDate: '2026-10-29'
				},
				{
					id: 'active',
					name: 'Active offer',
					status: 'active',
					requirementDeadline: '2026-10-27',
					expectedPayoutDate: null,
					safeToCloseDate: null,
					feeFreeDowngradeDate: null
				}
			]
		);
		expect(savedDeadlines(saved, '2026-10-25')).toEqual([
			{
				id: 'bonus:active:Requirement deadline',
				name: 'Active offer',
				label: 'Requirement deadline',
				date: '2026-10-27'
			},
			{
				id: 'bonus:paid:Saved close date',
				name: 'Paid offer',
				label: 'Saved close date',
				date: '2027-01-01'
			}
		]);
	});

	it('keeps the emergency view independent of live financial APIs and persistent browser storage', () => {
		const source = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
		for (const forbidden of [
			'/api/dashboard',
			'/api/plaid',
			'/api/accounts',
			'/api/cards',
			'/api/bonuses',
			'localStorage',
			'sessionStorage',
			'indexedDB',
			'setInterval'
		]) {
			expect(source).not.toContain(forbidden);
		}
		const mutations = [...source.matchAll(/method:\s*'([^']+)'/g)].map((match) => match[1]);
		expect(mutations).toEqual(['POST']);
		expect(source).toContain("resolve('/api/emergency/logout')");
		expect(source).toContain('Provider last synced:');
		expect(source).toContain('Copy saved');
	});
});
