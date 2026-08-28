import { createHash, randomBytes } from 'node:crypto';
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import process from 'node:process';

const BOOTSTRAP_TOKEN_DOMAIN = 'carddue:google-oidc-bootstrap-token:v1\0';

function fail(message) {
	console.error(message);
	process.exitCode = 1;
}

function parseOutputPath() {
	const args = process.argv.slice(2);
	if (args.length !== 2 || args[0] !== '--output' || !args[1]) {
		throw new Error(
			'Usage: npm run google:bootstrap -- --output /private/path/chipdue-google-bootstrap.json'
		);
	}
	if (!isAbsolute(args[1])) throw new Error('The bootstrap bundle path must be absolute.');
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
			throw new Error('Refusing to write a bootstrap bundle inside a Git worktree.');
		}
		if (current === root) return;
		current = dirname(current);
	}
}

function assertExistingPathIsPrivateDirectory(path) {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error('The bootstrap bundle directory must be a real directory, not a link.');
	}
	if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
		throw new Error('The existing bootstrap bundle directory must be owner-only (mode 0700).');
	}
}

function main() {
	process.umask(0o077);
	const requested = parseOutputPath();
	const canonical = nearestExistingAncestor(requested);
	if (canonical !== requested) {
		throw new Error('The output path changes after resolving an existing linked ancestor.');
	}
	if (existsSync(requested)) {
		throw new Error('The bootstrap bundle already exists; refusing to overwrite it.');
	}
	assertNoGitAncestor(requested);

	const directory = dirname(requested);
	if (existsSync(directory)) {
		assertExistingPathIsPrivateDirectory(directory);
	} else {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		assertExistingPathIsPrivateDirectory(directory);
	}

	const setupToken = randomBytes(32).toString('base64url');
	const bootstrapHash = `sha256$${createHash('sha256')
		.update(BOOTSTRAP_TOKEN_DOMAIN, 'utf8')
		.update(setupToken, 'ascii')
		.digest('base64url')}`;
	const bundle = `${JSON.stringify(
		{
			version: 1,
			googleBootstrapToken: setupToken,
			googleBootstrapHash: bootstrapHash
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
	console.log('Google bootstrap bundle created with owner-only permissions.');
}

try {
	main();
} catch (error) {
	fail(error instanceof Error ? error.message : 'Bootstrap generation failed.');
}
