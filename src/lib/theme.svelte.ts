export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'chipdue-theme';
export const theme = $state<{ preference: ThemePreference }>({ preference: 'system' });

function readPreference(): ThemePreference {
	try {
		const saved = localStorage.getItem(STORAGE_KEY);
		return saved === 'light' || saved === 'dark' ? saved : 'system';
	} catch {
		return 'system';
	}
}

function applyTheme(): void {
	const dark =
		theme.preference === 'dark' ||
		(theme.preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.dataset.theme = dark ? 'dark' : 'light';
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute('content', dark ? '#101620' : '#f1ede5');
}

export function setThemePreference(preference: ThemePreference): void {
	theme.preference = preference;
	applyTheme();
	try {
		if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, preference);
	} catch {
		// The selection still works for this visit when browser storage is unavailable.
	}
}

export function initializeTheme(): () => void {
	theme.preference = readPreference();
	applyTheme();
	const media = window.matchMedia('(prefers-color-scheme: dark)');
	const syncPreference = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY || event.key === null) {
			theme.preference = readPreference();
			applyTheme();
		}
	};
	media.addEventListener('change', applyTheme);
	window.addEventListener('storage', syncPreference);
	window.addEventListener('pageshow', applyTheme);
	return () => {
		media.removeEventListener('change', applyTheme);
		window.removeEventListener('storage', syncPreference);
		window.removeEventListener('pageshow', applyTheme);
	};
}
