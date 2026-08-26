import { execFileSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const values = new Set([homedir(), userInfo().username]);

for (const key of ['user.name', 'user.email']) {
	try {
		const value = execFileSync('git', ['config', '--global', '--get', key], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
		if (value) values.add(value);
	} catch {
		// A missing global value is fine.
	}
}

const destination = resolve(root, '.privacy-denylist');
writeFileSync(
	destination,
	'# Local private values that must never appear in a publishable file.\n' +
		[...values].join('\n') +
		'\n',
	{ mode: 0o600 }
);
chmodSync(destination, 0o600);
console.log(`Initialized a private denylist with ${values.size} redacted values.`);
