import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function git(args, options = {}) {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		...options
	});
}

const output = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
const files = output.split('\0').filter(Boolean);
const failures = new Set();

const forbiddenNames = [
	/(^|\/)\.env(?:\.|$)/i,
	/(^|\/)(?:data|runtime|exports|backups|screenshots)(?:\/|$)/i,
	/(^|\/)\.privacy-denylist$/i,
	/\.(?:db|sqlite|sqlite3)(?:[-.].*)?$/i,
	/\.(?:log|har|map|pem|key|p12|pfx|ics)$/i,
	/\.trace\.zip$/i
];

const forbiddenBinaryExtensions = new Set([
	'.7z',
	'.gif',
	'.gz',
	'.jpeg',
	'.jpg',
	'.pdf',
	'.png',
	'.tar',
	'.webp',
	'.zip'
]);

const contentRules = [
	['private-key', /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/],
	['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/],
	['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
	['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
	['openai-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}\b/],
	[
		'plaid-token',
		/\b(?:access|link|public)-(?:development|production|sandbox)-[A-Za-z0-9_-]{8,}\b/
	],
	[
		'configured-plaid-credential',
		/PLAID_(?:CLIENT_ID|SECRET)\s*=\s*["']?(?!(?:replace|example|your|<))[A-Za-z0-9_-]{8,}/i
	],
	['absolute-linux-home-path', /\/home\/[A-Za-z0-9._-]+\//],
	['absolute-windows-home-path', /[A-Za-z]:[\\/]Users[\\/][^\\/\r\n]+[\\/]/i]
];

const allowedEmailDomains = new Set(['example.com', 'example.invalid', 'users.noreply.github.com']);
const emailPattern = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

let denylist = [];
try {
	denylist = readFileSync(resolve(root, '.privacy-denylist'), 'utf8')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'));
} catch {
	// The denylist is optional in CI and intentionally ignored by Git.
}

function fail(file, rule) {
	failures.add(`${file} (${rule})`);
}

function passesLuhn(digits) {
	let sum = 0;
	let doubleDigit = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let value = Number(digits[index]);
		if (doubleDigit) {
			value *= 2;
			if (value > 9) value -= 9;
		}
		sum += value;
		doubleDigit = !doubleDigit;
	}
	return sum % 10 === 0;
}

for (const file of files) {
	if (/[^\x20-\x7e]/.test(file)) fail(file, 'non-printable-filename');
	if (file !== '.env.example' && forbiddenNames.some((pattern) => pattern.test(file))) {
		fail(file, 'private-filename');
	}
	if (forbiddenBinaryExtensions.has(extname(file).toLowerCase())) fail(file, 'binary-file');

	const absolute = resolve(root, file);
	let stats;
	try {
		stats = lstatSync(absolute);
	} catch {
		fail(file, 'unreadable-file');
		continue;
	}

	if (stats.isSymbolicLink()) {
		fail(file, `symlink:${readlinkSync(absolute).startsWith('/') ? 'absolute' : 'unexpected'}`);
		continue;
	}
	if (!stats.isFile()) continue;
	if (stats.size > 5 * 1024 * 1024) {
		fail(file, 'file-too-large-to-audit');
		continue;
	}

	const buffer = readFileSync(absolute);
	if (buffer.includes(0)) {
		fail(file, 'binary-content');
		continue;
	}
	const text = buffer.toString('utf8');

	for (const [rule, pattern] of contentRules) {
		if (pattern.test(text)) fail(file, rule);
	}

	for (const match of text.matchAll(emailPattern)) {
		if (!allowedEmailDomains.has(match[1].toLowerCase())) fail(file, 'email-address');
	}

	for (const candidate of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
		const digits = candidate[0].replace(/\D/g, '');
		if (
			digits.length >= 13 &&
			digits.length <= 19 &&
			!/^(\d)\1+$/.test(digits) &&
			passesLuhn(digits)
		) {
			fail(file, 'possible-payment-card-number');
		}
	}

	const lowerText = text.toLowerCase();
	for (const privateValue of denylist) {
		if (privateValue.length >= 4 && lowerText.includes(privateValue.toLowerCase())) {
			fail(file, 'local-denylist-match');
		}
	}
}

for (const args of [
	['diff', '--check'],
	['diff', '--cached', '--check']
]) {
	try {
		git(args);
	} catch {
		fail('git-diff', 'whitespace-error');
	}
}

if (process.env.CI !== 'true') {
	try {
		const identity = git(['var', 'GIT_AUTHOR_IDENT']);
		const email = identity.match(/<([^>]+)>/)?.[1] ?? '';
		if (!email.endsWith('@users.noreply.github.com'))
			fail('git-config', 'non-noreply-author-email');
	} catch {
		fail('git-config', 'missing-local-author-identity');
	}
}

if (failures.size > 0) {
	console.error('Privacy check failed. Matching values are intentionally redacted:');
	for (const failure of [...failures].sort()) console.error(`- ${failure}`);
	process.exit(1);
}

console.log(`Privacy check passed for ${files.length} publishable files.`);
