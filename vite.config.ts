import { defineConfig } from 'vitest/config';
import nodeAdapter from '@sveltejs/adapter-node';
import vercelAdapter from '@sveltejs/adapter-vercel';
import { sveltekit } from '@sveltejs/kit/vite';

const adapter =
	process.env.VERCEL === '1'
		? vercelAdapter({ runtime: 'nodejs22.x', regions: ['pdx1'], maxDuration: 30 })
		: nodeAdapter();

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter,
			csp: {
				mode: 'nonce',
				directives: {
					'default-src': ['self'],
					'script-src': ['self', 'https://cdn.plaid.com'],
					'style-src': ['self', 'unsafe-inline'],
					'style-src-elem': ['self', 'unsafe-inline'],
					'style-src-attr': ['unsafe-inline'],
					'frame-src': ['https://cdn.plaid.com'],
					'connect-src': [
						'self',
						'https://cdn.plaid.com',
						'https://sandbox.plaid.com',
						'https://production.plaid.com'
					],
					'img-src': ['self', 'data:', 'https://cdn.plaid.com'],
					'font-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'frame-ancestors': ['none']
				}
			},
			csrf: {
				trustedOrigins: []
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
