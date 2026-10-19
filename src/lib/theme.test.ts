import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeTheme, setThemePreference, theme } from './theme.svelte';

const storageKey = 'chipdue-theme';
const appHtml = readFileSync(new URL('../app.html', import.meta.url), 'utf8');
const startupScript = appHtml.match(/<script nonce="%sveltekit\.nonce%">([\s\S]*?)<\/script>/);

function mockBrowser() {
	const saved = new Map<string, string>();
	const storage = {
		getItem: vi.fn((key: string) => saved.get(key) ?? null),
		setItem: vi.fn((key: string, value: string) => saved.set(key, value)),
		removeItem: vi.fn((key: string) => saved.delete(key))
	};
	const media = Object.assign(new EventTarget(), { matches: false });
	const browser = Object.assign(new EventTarget(), { matchMedia: vi.fn(() => media) });
	const meta = {
		content: '#f1ede5',
		setAttribute(_name: string, value: string) {
			this.content = value;
		}
	};
	const document = {
		documentElement: { dataset: {} as Record<string, string> },
		querySelector: vi.fn(() => meta)
	};
	vi.stubGlobal('window', browser);
	vi.stubGlobal('document', document);
	vi.stubGlobal('localStorage', storage);
	return { saved, storage, media, browser, meta, document };
}

describe('color theme preference', () => {
	let environment: ReturnType<typeof mockBrowser>;
	let dispose: (() => void) | undefined;

	function startBeforeHydration() {
		runInNewContext(startupScript![1], {
			window: environment.browser,
			document: environment.document,
			localStorage: environment.storage
		});
	}

	function systemAppearance(dark: boolean) {
		environment.media.matches = dark;
		environment.media.dispatchEvent(new Event('change'));
	}

	function storageChanged(key: string | null) {
		environment.browser.dispatchEvent(Object.assign(new Event('storage'), { key }));
	}

	beforeEach(() => {
		environment = mockBrowser();
		theme.preference = 'system';
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		vi.unstubAllGlobals();
	});

	it('allows its prepaint script under the existing nonce policy before app styles and hydration', () => {
		expect(startupScript).not.toBeNull();
		expect(appHtml.indexOf(startupScript![0])).toBeLessThan(appHtml.indexOf('%sveltekit.head%'));
		expect(appHtml.indexOf('name="theme-color"')).toBeLessThan(appHtml.indexOf(startupScript![0]));
	});

	it.each([
		{ saved: null, systemDark: true, preference: 'system', resolved: 'dark' },
		{ saved: null, systemDark: false, preference: 'system', resolved: 'light' },
		{ saved: 'unknown', systemDark: true, preference: 'system', resolved: 'dark' },
		{ saved: 'dark', systemDark: false, preference: 'dark', resolved: 'dark' },
		{ saved: 'light', systemDark: true, preference: 'light', resolved: 'light' }
	])(
		'keeps startup and hydration consistent for $saved with system dark=$systemDark',
		(testCase) => {
			if (testCase.saved !== null) environment.saved.set(storageKey, testCase.saved);
			environment.media.matches = testCase.systemDark;
			startBeforeHydration();
			expect(environment.document.documentElement.dataset.theme).toBe(testCase.resolved);
			expect(environment.meta.content).toBe(testCase.resolved === 'dark' ? '#101620' : '#f1ede5');

			dispose = initializeTheme();
			expect(theme.preference).toBe(testCase.preference);
			expect(environment.document.documentElement.dataset.theme).toBe(testCase.resolved);
			expect(environment.storage.setItem).not.toHaveBeenCalled();
		}
	);

	it('follows system changes only until a manual override, then resumes when System is selected', () => {
		dispose = initializeTheme();
		systemAppearance(true);
		expect(environment.document.documentElement.dataset.theme).toBe('dark');

		setThemePreference('light');
		expect([...environment.saved]).toEqual([[storageKey, 'light']]);
		systemAppearance(false);
		systemAppearance(true);
		expect(environment.document.documentElement.dataset.theme).toBe('light');
		expect(environment.meta.content).toBe('#f1ede5');

		setThemePreference('system');
		expect(environment.saved.size).toBe(0);
		expect(environment.document.documentElement.dataset.theme).toBe('dark');
		systemAppearance(false);
		expect(environment.document.documentElement.dataset.theme).toBe('light');
	});

	it('still applies system and manual appearance when storage reads and writes throw', () => {
		const unavailable = () => {
			throw new Error('Browser storage is unavailable');
		};
		environment.storage.getItem.mockImplementation(unavailable);
		environment.storage.setItem.mockImplementation(unavailable);
		environment.storage.removeItem.mockImplementation(unavailable);
		environment.media.matches = true;
		startBeforeHydration();
		dispose = initializeTheme();
		expect(environment.document.documentElement.dataset.theme).toBe('dark');

		setThemePreference('light');
		expect(theme.preference).toBe('light');
		expect(environment.document.documentElement.dataset.theme).toBe('light');
		setThemePreference('system');
		expect(environment.document.documentElement.dataset.theme).toBe('dark');
	});

	it('syncs appearance across tabs and releases all listeners on cleanup', () => {
		dispose = initializeTheme();
		environment.saved.set(storageKey, 'dark');
		storageChanged('unrelated-key');
		expect(theme.preference).toBe('system');
		storageChanged(storageKey);
		expect(theme.preference).toBe('dark');
		expect(environment.document.documentElement.dataset.theme).toBe('dark');

		environment.saved.clear();
		storageChanged(null);
		expect(theme.preference).toBe('system');
		environment.media.matches = true;
		environment.browser.dispatchEvent(new Event('pageshow'));
		expect(environment.document.documentElement.dataset.theme).toBe('dark');

		dispose();
		dispose = undefined;
		systemAppearance(false);
		environment.saved.set(storageKey, 'light');
		storageChanged(storageKey);
		environment.browser.dispatchEvent(new Event('pageshow'));
		expect(theme.preference).toBe('system');
		expect(environment.document.documentElement.dataset.theme).toBe('dark');
	});
});
