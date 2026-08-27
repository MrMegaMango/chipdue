import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_SEGMENTS = new Set([
	'.aws',
	'.azure',
	'.config',
	'.gnupg',
	'.kube',
	'.local',
	'.ssh',
	'AppData'
]);
const FUNCTION_ROOT_ENTRIES = new Set([
	'.svelte-kit',
	'node_modules',
	'.vc-config.json',
	'package.json'
]);
const SECRET_ENVIRONMENT_NAMES = [
	'DATABASE_URL',
	'CARDDUE_MASTER_KEY',
	'CARDDUE_OWNER_PASSWORD_HASH',
	'CARDDUE_MIGRATION_DATABASE_URL',
	'CARDDUE_DATABASE_PASSWORD',
	'CARDDUE_GOOGLE_CLIENT_ID',
	'CARDDUE_GOOGLE_CLIENT_SECRET',
	'PLAID_CLIENT_ID',
	'PLAID_SECRET'
];
const SENSITIVE_ENVIRONMENT_NAME =
	/(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)(?:$|_)/i;
const PRIVATE_KEY_HEADER = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;
const COMPACT_JWT =
	/(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
const CHECKOUT_SCAN_IGNORES = new Set(['.git', '.svelte-kit', '.vercel', 'build', 'node_modules']);

/** @param {string | undefined} value */
export function isPrivateUserHome(value) {
	if (!value) return false;
	return (
		/^\/root\/?$/.test(value) ||
		/^\/(?:home|Users)\/[^/]+\/?$/.test(value) ||
		/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i.test(value) ||
		/^\\\\[^\\/]+[\\/]Users[\\/][^\\/]+[\\/]?$/i.test(value)
	);
}

/**
 * @param {string} root
 * @param {string} candidate
 */
function isWithin(root, candidate) {
	const fromRoot = relative(root, candidate);
	return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..');
}

/** @param {string} name */
function forbiddenFilename(name) {
	const lower = name.toLowerCase();
	return (
		lower === '.env' ||
		lower.startsWith('.env.') ||
		/\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/.test(lower) ||
		/\.(?:har|ics|key|log|map|p12|pem|pfx)$/.test(lower) ||
		lower.endsWith('.trace.zip')
	);
}

/** @param {string} root */
function collect(root) {
	const files = [];
	const functionRoots = [];
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			const segments = relative(root, path).split(sep);
			if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
				throw new Error(
					'Vercel output contains a traced private-home directory; deployment was blocked.'
				);
			}
			if (entry.isSymbolicLink()) {
				const target = realpathSync(path);
				if (!isWithin(root, target)) {
					throw new Error('Vercel output contains a link outside its build directory.');
				}
				continue;
			}
			if (entry.isDirectory()) {
				if (entry.name.endsWith('.func')) functionRoots.push(path);
				pending.push(path);
			} else if (entry.isFile()) {
				if (forbiddenFilename(entry.name)) {
					throw new Error(
						'Vercel output contains a forbidden private artifact; deployment was blocked.'
					);
				}
				files.push(path);
			}
		}
	}
	return { files, functionRoots };
}

/** @param {string[]} functionRoots */
function verifyFunctionRoots(functionRoots) {
	if (functionRoots.length === 0) {
		throw new Error('Vercel output does not contain a server Function.');
	}
	for (const root of functionRoots) {
		for (const entry of readdirSync(root)) {
			if (!FUNCTION_ROOT_ENTRIES.has(entry)) {
				throw new Error(
					'Vercel output contains an unexpected Function-root artifact; deployment was blocked.'
				);
			}
		}
	}
}

function forbiddenValues() {
	const values = [];
	const names = new Set([
		...SECRET_ENVIRONMENT_NAMES,
		...Object.keys(process.env).filter((name) => SENSITIVE_ENVIRONMENT_NAME.test(name))
	]);
	for (const name of names) {
		const value = process.env[name];
		if (value && Buffer.byteLength(value) >= 8)
			values.push({ label: name, value: Buffer.from(value) });
	}
	const homes = new Set([process.env.HOME, process.env.USERPROFILE]);
	for (const home of homes) {
		if (home && isPrivateUserHome(home)) {
			values.push({ label: 'private home path', value: Buffer.from(home) });
		}
	}
	return values;
}

/** @param {string} text */
function containsPrivateKeyMaterial(text) {
	PRIVATE_KEY_HEADER.lastIndex = 0;
	let match;
	while ((match = PRIVATE_KEY_HEADER.exec(text)) !== null) {
		const footer = `-----END ${match[1]}-----`;
		const footerIndex = text.indexOf(footer, PRIVATE_KEY_HEADER.lastIndex);
		if (footerIndex === -1) continue;
		const encodedBody = text.slice(PRIVATE_KEY_HEADER.lastIndex, footerIndex);
		if (encodedBody.length > 128 * 1024) return true;
		const normalizedBody = encodedBody
			.replaceAll('\\r\\n', '\n')
			.replaceAll('\\n', '\n')
			.replaceAll('\\r', '\n')
			.replaceAll('\r\n', '\n')
			.replaceAll('\r', '\n');
		if (!normalizedBody.startsWith('\n') || !normalizedBody.endsWith('\n')) continue;
		const lines = normalizedBody.slice(1, -1).replaceAll('\r', '').split('\n');
		while (lines[0]?.includes(':')) lines.shift();
		while (lines[0] === '') lines.shift();
		const compact = lines.join('');
		if (
			compact.length >= 64 &&
			compact.length % 4 === 0 &&
			/^[A-Za-z0-9+/]+={0,2}$/.test(compact) &&
			Buffer.from(compact, 'base64').byteLength >= 48
		) {
			return true;
		}
	}
	return false;
}

/** @param {string[]} files */
function verifyFileContents(files) {
	const forbidden = forbiddenValues();
	for (const path of files) {
		if (statSync(path).size === 0) continue;
		const content = readFileSync(path);
		const text = content.toString('utf8');
		if (containsPrivateKeyMaterial(text) || COMPACT_JWT.test(text)) {
			throw new Error('Vercel output contains credential-shaped material; deployment was blocked.');
		}
		for (const candidate of forbidden) {
			if (content.includes(candidate.value)) {
				throw new Error(`Vercel output embeds ${candidate.label}; deployment was blocked.`);
			}
		}
	}
}

export function assertCredentialFreeCheckout(checkoutPath = resolve('.')) {
	const requested = resolve(checkoutPath);
	if (!existsSync(requested) || !lstatSync(requested).isDirectory()) {
		throw new Error('The Vercel build checkout is unavailable.');
	}
	const root = realpathSync.native(requested);
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current) continue;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			if (entry.isDirectory() && CHECKOUT_SCAN_IGNORES.has(entry.name)) continue;
			if (entry.isSymbolicLink()) {
				throw new Error('The Vercel checkout contains a symbolic link; deployment was blocked.');
			}
			const environmentNamed = entry.name.startsWith('.env');
			const allowedExample = entry.name === '.env.example';
			if (environmentNamed && !allowedExample) {
				throw new Error('The Vercel checkout contains an environment file.');
			}
			if (entry.isDirectory()) pending.push(resolve(current, entry.name));
		}
	}
}

export function verifyVercelOutput(outputPath = resolve('.vercel', 'output')) {
	const requested = resolve(outputPath);
	if (!existsSync(requested) || !lstatSync(requested).isDirectory()) {
		throw new Error('Vercel output directory is missing.');
	}
	const root = realpathSync.native(requested);
	const { files, functionRoots } = collect(root);
	verifyFunctionRoots(functionRoots);
	verifyFileContents(files);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
	try {
		verifyVercelOutput(process.argv[2]);
		console.log('Vercel output privacy verification passed.');
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Vercel output verification failed.');
		process.exitCode = 1;
	}
}
