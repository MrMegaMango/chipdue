/** @param {string} hostname */
export function isDirectNeonDatabaseHost(hostname) {
	const normalized = hostname.toLowerCase();
	const firstLabel = normalized.split('.')[0] ?? '';
	return (
		normalized.endsWith('.neon.tech') &&
		/^ep-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(firstLabel) &&
		!firstLabel.endsWith('-pooler')
	);
}
