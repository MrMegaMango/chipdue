import { randomBytes, scrypt } from 'node:crypto';
import {
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync,
	closeSync
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function fail(message) {
	console.error(message);
	process.exitCode = 1;
}

function parseOutputPath() {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
		throw new Error('Usage: npm run cloud:secrets -- --output /private/path/chipdue-recovery.json');
	}
	if (!isAbsolute(args[1])) throw new Error('The recovery bundle path must be absolute.');
	return resolve(args[1]);
}

function nearestExistingAncestor(path) {
	let current = path;
	const suffix = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) throw new Error('No existing ancestor was found for the output path.');
		suffix.unshift(current.slice(parent.length + (parent.endsWith('/') ? 0 : 1)));
		current = parent;
	}
	const canonical = realpathSync.native(current);
	return suffix.reduce((base, segment) => join(base, segment), canonical);
}

function assertNoGitAncestor(path) {
	let current = dirname(path);
	const root = parse(current).root;
	while (true) {
		if (existsSync(join(current, '.git'))) {
			throw new Error('Refusing to write a recovery bundle inside a Git worktree.');
		}
		if (current === root) return;
		current = dirname(current);
	}
}

function assertExistingPathIsPrivateDirectory(path) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error('The recovery bundle directory must be a real directory, not a link.');
	}
	if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
		throw new Error('The existing recovery bundle directory must be owner-only (mode 0700).');
	}
}

async function main() {
	process.umask(0o077);
	const requested = parseOutputPath();
	const canonical = nearestExistingAncestor(requested);
	if (canonical !== requested) {
		throw new Error('The output path changes after resolving an existing linked ancestor.');
	}
	if (existsSync(requested))
		throw new Error('The recovery bundle already exists; refusing to overwrite it.');
	assertNoGitAncestor(requested);

	const directory = dirname(requested);
	if (existsSync(directory)) {
		assertExistingPathIsPrivateDirectory(directory);
	} else {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		assertExistingPathIsPrivateDirectory(directory);
	}

	const loginPassword = randomBytes(24).toString('base64url');
	const masterKey = randomBytes(32).toString('base64url');
	const databaseRolePassword = randomBytes(32).toString('base64url');
	const salt = randomBytes(16);
	const derived = await deriveKey(loginPassword, salt, 32, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
		maxmem: 64 * 1024 * 1024
	});
	const ownerPasswordHash = [
		'scrypt',
		SCRYPT_N,
		SCRYPT_R,
		SCRYPT_P,
		salt.toString('base64url'),
		Buffer.from(derived).toString('base64url')
	].join('$');

	const bundle = `${JSON.stringify(
		{
			version: 1,
			loginPassword,
			masterKey,
			ownerPasswordHash,
			databaseRolePassword
		},
		null,
		2
	)}\n`;
	const file = openSync(
		requested,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
		0o600
	);
	try {
		writeFileSync(file, bundle, { encoding: 'utf8' });
	} finally {
		closeSync(file);
	}
	console.log('Cloud recovery bundle created with owner-only permissions.');
}

main().catch((error) => fail(error instanceof Error ? error.message : 'Secret generation failed.'));
