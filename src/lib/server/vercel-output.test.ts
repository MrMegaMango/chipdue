import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	assertCredentialFreeCheckout,
	isPrivateUserHome,
	verifyVercelOutput
} from '../../../scripts/verify-vercel-output.mjs';

describe.sequential('Vercel output privacy verification', () => {
	let output: string;
	let checkout: string;
	let previousMasterKey: string | undefined;
	let previousVercelToken: string | undefined;
	let previousHome: string | undefined;

	beforeEach(() => {
		previousMasterKey = process.env.CARDDUE_MASTER_KEY;
		previousVercelToken = process.env.VERCEL_TOKEN;
		previousHome = process.env.HOME;
		delete process.env.CARDDUE_MASTER_KEY;
		delete process.env.VERCEL_TOKEN;
		output = mkdtempSync(join(tmpdir(), 'carddue-vercel-output-test-'));
		checkout = mkdtempSync(join(tmpdir(), 'carddue-vercel-checkout-test-'));
		const functionRoot = join(output, 'functions', 'app.func');
		mkdirSync(join(functionRoot, '.svelte-kit'), { recursive: true });
		mkdirSync(join(functionRoot, 'node_modules'), { recursive: true });
		writeFileSync(join(functionRoot, '.vc-config.json'), '{}');
		writeFileSync(join(functionRoot, 'package.json'), '{}');
		mkdirSync(join(output, 'static'), { recursive: true });
		writeFileSync(join(output, 'static', 'app.js'), 'console.log("synthetic build");');
	});

	afterEach(() => {
		if (previousMasterKey === undefined) delete process.env.CARDDUE_MASTER_KEY;
		else process.env.CARDDUE_MASTER_KEY = previousMasterKey;
		if (previousVercelToken === undefined) delete process.env.VERCEL_TOKEN;
		else process.env.VERCEL_TOKEN = previousVercelToken;
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(output, { recursive: true, force: true });
		rmSync(checkout, { recursive: true, force: true });
	});

	it('accepts a minimal clean function bundle', () => {
		expect(() => verifyVercelOutput(output)).not.toThrow();
	});

	it('skips Vercel workspace HOME while blocking actual private user homes', () => {
		const linuxPrivateHome = ['', 'home', 'private'].join('/');
		expect(isPrivateUserHome('/vercel')).toBe(false);
		expect(isPrivateUserHome(linuxPrivateHome)).toBe(true);
		expect(isPrivateUserHome('C:\\Users\\Private')).toBe(true);

		process.env.HOME = '/vercel';
		writeFileSync(join(output, 'static', 'app.js'), 'const source = "/vercel/path0";');
		expect(() => verifyVercelOutput(output)).not.toThrow();

		process.env.HOME = linuxPrivateHome;
		writeFileSync(
			join(output, 'static', 'app.js'),
			`const source = "${linuxPrivateHome}/project";`
		);
		expect(() => verifyVercelOutput(output)).toThrow(/private home path/);
	});

	it('blocks private files and traced home directories', () => {
		writeFileSync(join(output, 'functions', 'app.func', 'records.sqlite'), 'synthetic');
		expect(() => verifyVercelOutput(output)).toThrow(/private artifact/);

		rmSync(join(output, 'functions', 'app.func', 'records.sqlite'));
		mkdirSync(join(output, 'functions', 'app.func', '.local', 'share'), { recursive: true });
		writeFileSync(join(output, 'functions', 'app.func', '.local', 'share', 'auth.json'), '{}');
		expect(() => verifyVercelOutput(output)).toThrow(/private-home/);
	});

	it('blocks a configured secret embedded in output', () => {
		process.env.CARDDUE_MASTER_KEY = Buffer.alloc(32, 17).toString('base64url');
		writeFileSync(
			join(output, 'static', 'app.js'),
			`const leaked = "${process.env.CARDDUE_MASTER_KEY}";`
		);
		expect(() => verifyVercelOutput(output)).toThrow(/CARDDUE_MASTER_KEY/);
	});

	it('blocks conservative token environment values embedded in output', () => {
		process.env.VERCEL_TOKEN = 'synthetic_vercel_token_for_output_test';
		writeFileSync(join(output, 'static', 'app.js'), process.env.VERCEL_TOKEN);
		expect(() => verifyVercelOutput(output)).toThrow(/VERCEL_TOKEN/);
	});

	it('blocks credential-shaped output without relying on environment values', () => {
		writeFileSync(
			join(output, 'static', 'app.js'),
			['eyJhbGciOiJub25lIn0', 'eyJzdWIiOiJzeW50aGV0aWMifQ', 'synthetic_signature'].join('.')
		);
		expect(() => verifyVercelOutput(output)).toThrow(/credential-shaped/);

		const label = ['PRIVATE', 'KEY'].join(' ');
		const encodedBody = Buffer.alloc(48, 37)
			.toString('base64')
			.match(/.{1,64}/g)!
			.join('\n');
		const pem = `-----BEGIN ${label}-----\n${encodedBody}\n-----END ${label}-----`;
		expect(encodedBody.replaceAll('\n', '')).toHaveLength(64);
		writeFileSync(join(output, 'static', 'app.js'), pem);
		expect(() => verifyVercelOutput(output)).toThrow(/credential-shaped/);

		writeFileSync(join(output, 'static', 'app.js'), pem.replaceAll('\n', '\\n'));
		expect(() => verifyVercelOutput(output)).toThrow(/credential-shaped/);

		writeFileSync(
			join(output, 'static', 'app.js'),
			`-----BEGIN ${label}-----\n${'A'.repeat(128 * 1024)}\n-----END ${label}-----`
		);
		expect(() => verifyVercelOutput(output)).toThrow(/credential-shaped/);
	});

	it('allows an isolated private-key sentinel used by cryptography libraries', () => {
		writeFileSync(
			join(output, 'static', 'app.js'),
			['const sentinel = "-----BEGIN ', 'PRIVATE KEY-----";'].join('')
		);
		expect(() => verifyVercelOutput(output)).not.toThrow();
	});

	it('rejects every checkout environment-file basename except the example', () => {
		writeFileSync(join(checkout, '.env.example'), 'SYNTHETIC_DOCUMENTATION_ONLY=1\n');
		expect(() => assertCredentialFreeCheckout(checkout)).not.toThrow();
		writeFileSync(join(checkout, '.env.local'), 'SYNTHETIC_TEST_ONLY=1\n');
		expect(() => assertCredentialFreeCheckout(checkout)).toThrow(/environment file/);
		rmSync(join(checkout, '.env.local'));
		writeFileSync(join(checkout, '.envrc'), 'SYNTHETIC_TEST_ONLY=1\n');
		expect(() => assertCredentialFreeCheckout(checkout)).toThrow(/environment file/);
	});

	it('rejects an external non-environment symlink with a generic error', () => {
		symlinkSync(join(output, 'static', 'app.js'), join(checkout, 'linked-source.js'));
		expect(() => assertCredentialFreeCheckout(checkout)).toThrow(
			'The Vercel checkout contains a symbolic link; deployment was blocked.'
		);
	});

	it('keeps every supported Vercel build path behind the verified wrapper', () => {
		const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		const vercelConfig = JSON.parse(readFileSync(resolve('vercel.json'), 'utf8')) as {
			buildCommand: string;
		};
		const wrapper = readFileSync(resolve('scripts', 'build-vercel.mjs'), 'utf8');
		expect(packageJson.scripts.build).toBe('node scripts/build-vercel.mjs');
		expect(packageJson.scripts['build:vercel']).toBe('node scripts/build-vercel.mjs --vercel');
		expect(vercelConfig.buildCommand).toBe('npm run build:vercel');
		expect(wrapper).toContain('verifyVercelOutput');
		expect(wrapper).toContain("process.env.VERCEL === '1'");
	});
});
