import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const BOOTSTRAP_TOKEN_DOMAIN = 'carddue:google-oidc-bootstrap-token:v1\0';
const script = new URL('../../../scripts/generate-google-bootstrap.mjs', import.meta.url);
const temporaryDirectories: string[] = [];

function makePrivateDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), 'carddue-google-bootstrap-test-'));
	chmodSync(directory, 0o700);
	temporaryDirectories.push(directory);
	return directory;
}

function runGenerator(output: string) {
	return spawnSync(process.execPath, [script.pathname, '--output', output], {
		encoding: 'utf8'
	});
}

describe('Google bootstrap secret generator', () => {
	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it('writes a fresh protected token and verifier without printing either', () => {
		const directory = makePrivateDirectory();
		const output = join(directory, 'bootstrap.json');
		const result = runGenerator(output);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');

		const bundle = JSON.parse(readFileSync(output, 'utf8')) as {
			version: number;
			googleBootstrapToken: string;
			googleBootstrapHash: string;
		};
		expect(bundle).toMatchObject({ version: 1 });
		expect(bundle.googleBootstrapToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(bundle.googleBootstrapHash).toBe(
			`sha256$${createHash('sha256')
				.update(BOOTSTRAP_TOKEN_DOMAIN, 'utf8')
				.update(bundle.googleBootstrapToken, 'ascii')
				.digest('base64url')}`
		);
		expect(result.stdout).not.toContain(bundle.googleBootstrapToken);
		expect(result.stdout).not.toContain(bundle.googleBootstrapHash);
		if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);

		const overwrite = runGenerator(output);
		expect(overwrite.status).not.toBe(0);
		expect(readFileSync(output, 'utf8')).toContain(bundle.googleBootstrapToken);
	});

	it('rejects a relative output path', () => {
		const output = `relative-google-bootstrap-${process.pid}.json`;
		const result = runGenerator(output);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('must be absolute');
		expect(existsSync(output)).toBe(false);
	});

	it('rejects an output beneath a Git ancestor', () => {
		const directory = makePrivateDirectory();
		mkdirSync(join(directory, '.git'));
		const output = join(directory, 'bootstrap.json');
		const result = runGenerator(output);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Git worktree');
		expect(existsSync(output)).toBe(false);
	});

	it('rejects an output reached through a linked ancestor', () => {
		const directory = makePrivateDirectory();
		const target = join(directory, 'target');
		const linked = join(directory, 'linked');
		mkdirSync(target, { mode: 0o700 });
		symlinkSync(target, linked, 'dir');
		const output = join(linked, 'bootstrap.json');
		const result = runGenerator(output);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('linked ancestor');
		expect(existsSync(join(target, 'bootstrap.json'))).toBe(false);
	});

	it.runIf(process.platform !== 'win32')(
		'rejects an insecure existing directory without changing its mode',
		() => {
			const directory = makePrivateDirectory();
			chmodSync(directory, 0o755);
			const output = join(directory, 'bootstrap.json');
			const result = runGenerator(output);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('owner-only');
			expect(statSync(directory).mode & 0o777).toBe(0o755);
			expect(existsSync(output)).toBe(false);
		}
	);
});
