import type { Card } from '$lib/types';

function escapeText(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('\r\n', '\\n')
		.replaceAll('\r', '\\n')
		.replaceAll('\n', '\\n')
		.replaceAll(',', '\\,')
		.replaceAll(';', '\\;');
}

function formatUtcTimestamp(date: Date): string {
	return date
		.toISOString()
		.replaceAll('-', '')
		.replaceAll(':', '')
		.replace(/\.\d{3}Z$/, 'Z');
}

function compactDate(value: string): string {
	return value.replaceAll('-', '');
}

function nextDate(value: string): string {
	const [year, month, day] = value.split('-').map(Number);
	const date = new Date(Date.UTC(year, month - 1, day + 1));
	return date.toISOString().slice(0, 10);
}

function formatMoney(cents: number, currency: string): string {
	try {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`;
	}
}

function description(card: Card, includeAmounts: boolean): string {
	const parts: string[] = [];
	if (includeAmounts && card.statementBalanceCents !== null) {
		parts.push(`Statement balance: ${formatMoney(card.statementBalanceCents, card.currency)}`);
	}
	if (includeAmounts && card.minimumPaymentCents !== null) {
		parts.push(`Minimum due: ${formatMoney(card.minimumPaymentCents, card.currency)}`);
	}
	if (card.last4) parts.push(`Card ending in ${card.last4}`);
	return parts.join('\n');
}

function foldLine(line: string): string[] {
	const lines: string[] = [];
	let current = '';
	let byteLength = 0;
	for (const character of line) {
		const characterBytes = Buffer.byteLength(character, 'utf8');
		const limit = lines.length === 0 ? 75 : 74;
		if (byteLength + characterBytes > limit) {
			lines.push(lines.length === 0 ? current : ` ${current}`);
			current = character;
			byteLength = characterBytes;
		} else {
			current += character;
			byteLength += characterBytes;
		}
	}
	lines.push(lines.length === 0 ? current : ` ${current}`);
	return lines;
}

export function createCalendar(cards: Card[], now = new Date(), includeAmounts = false): string {
	const logicalLines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//CardDue//Payment reminders//EN',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH'
	];

	for (const card of cards) {
		if (!card.dueDate) continue;
		logicalLines.push(
			'BEGIN:VEVENT',
			`UID:${card.id}@carddue.local`,
			`DTSTAMP:${formatUtcTimestamp(now)}`,
			`DTSTART;VALUE=DATE:${compactDate(card.dueDate)}`,
			`DTEND;VALUE=DATE:${compactDate(nextDate(card.dueDate))}`,
			`SUMMARY:${escapeText(`${card.nickname} payment due`)}`
		);
		const details = description(card, includeAmounts);
		if (details) logicalLines.push(`DESCRIPTION:${escapeText(details)}`);
		logicalLines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
	}

	logicalLines.push('END:VCALENDAR');
	return `${logicalLines.flatMap(foldLine).join('\r\n')}\r\n`;
}
