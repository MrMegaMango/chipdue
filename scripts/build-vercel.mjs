import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertCredentialFreeCheckout, verifyVercelOutput } from './verify-vercel-output.mjs';

const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const vercelBuild = process.env.VERCEL === '1' || process.argv.includes('--vercel');
if (vercelBuild) {
	try {
		assertCredentialFreeCheckout();
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Vercel checkout verification failed.');
		process.exit(1);
	}
}
const result = spawnSync(process.execPath, [viteCli, 'build'], {
	stdio: 'inherit',
	env: vercelBuild ? { ...process.env, VERCEL: '1' } : process.env
});

if (result.error) {
	console.error(`Unable to start the Vercel build: ${result.error.message}`);
}

if (result.status === 0 && vercelBuild) {
	try {
		verifyVercelOutput();
		console.log('Vercel output privacy verification passed.');
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Vercel output verification failed.');
		process.exitCode = 1;
	}
} else if (result.status !== 0) {
	process.exitCode = result.status ?? 1;
}
