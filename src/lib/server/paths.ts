import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { AppError } from './errors';

export interface DataPaths {
	dataDirectory: string;
	database: string;
	masterKey: string;
}

function configuredHomeDirectory(): string | undefined {
	return process.platform === 'win32'
		? process.env.USERPROFILE?.trim() || undefined
		: process.env.HOME?.trim() || undefined;
}

function userHomeDirectory(): string {
	const value = configuredHomeDirectory();
	if (!value) {
		throw new AppError(
			'PRIVATE_HOME_UNAVAILABLE',
			'The private application-data directory could not be located.',
			500
		);
	}
	return value;
}

function defaultDataDirectory(): string {
	if (process.platform === 'win32') {
		return join(
			process.env.LOCALAPPDATA ?? join(userHomeDirectory(), 'AppData', 'Local'),
			'CardDue'
		);
	}

	if (process.platform === 'darwin') {
		return join(userHomeDirectory(), 'Library', 'Application Support', 'CardDue');
	}

	return join(process.env.XDG_DATA_HOME ?? join(userHomeDirectory(), '.local', 'share'), 'carddue');
}

function lstatIfPresent(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw new AppError('UNSAFE_DATA_PATH', 'A private storage path could not be inspected.', 500);
	}
}

function rejectFinalSymlink(path: string): void {
	if (lstatIfPresent(path)?.isSymbolicLink()) {
		throw new AppError('UNSAFE_DATA_PATH', 'Private storage paths cannot be symbolic links.', 500);
	}
}

function resolveThroughExistingAncestor(path: string): string {
	let current = resolve(path);
	const missingSegments: string[] = [];

	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) break;
		missingSegments.unshift(basename(current));
		current = parent;
	}

	try {
		return resolve(realpathSync.native(current), ...missingSegments);
	} catch {
		throw new AppError('UNSAFE_DATA_PATH', 'A private storage path could not be resolved.', 500);
	}
}

function findCheckoutRoot(start: string): string | null {
	let current = resolveThroughExistingAncestor(start);
	while (true) {
		if (existsSync(join(current, '.git'))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function isWithin(parent: string, candidate: string): boolean {
	const pathFromParent = relative(resolve(parent), resolve(candidate));
	return (
		pathFromParent === '' ||
		(!pathFromParent.startsWith(`..${sep}`) &&
			pathFromParent !== '..' &&
			!isAbsolute(pathFromParent))
	);
}

function requireOutsideCheckout(target: string): void {
	const checkout = findCheckoutRoot(target);
	if (checkout && isWithin(checkout, target)) {
		throw new AppError(
			'UNSAFE_DATA_PATH',
			'Private data storage must be outside a Git checkout.',
			500
		);
	}
}

function rejectBroadCustomDataDirectory(dataDirectory: string): void {
	if (process.env.CARDDUE_DATA_DIR === undefined) return;
	const homeDirectory = configuredHomeDirectory();
	const broadDirectories = [
		parse(dataDirectory).root,
		tmpdir(),
		...(homeDirectory ? [homeDirectory] : [])
	].map((path) => resolveThroughExistingAncestor(path));
	if (broadDirectories.includes(dataDirectory)) {
		throw new AppError(
			'UNSAFE_DATA_PATH',
			'The custom data path must be a dedicated private directory.',
			500
		);
	}
}

export function assertPrivateFilePath(path: string): void {
	const stat = lstatIfPresent(path);
	if (!stat) return;
	if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
		throw new AppError(
			'UNSAFE_DATA_PATH',
			'Private storage files must be regular, non-linked files.',
			500
		);
	}
}

export function getDataPaths(): DataPaths {
	const requestedDataDirectory = resolve(process.env.CARDDUE_DATA_DIR ?? defaultDataDirectory());
	rejectFinalSymlink(requestedDataDirectory);
	const dataDirectory = resolveThroughExistingAncestor(requestedDataDirectory);

	const requestedMasterKey = resolve(
		process.env.CARDDUE_MASTER_KEY_PATH ?? join(dataDirectory, 'master.key')
	);
	rejectFinalSymlink(requestedMasterKey);
	const masterKey = resolveThroughExistingAncestor(requestedMasterKey);
	const database = join(dataDirectory, 'carddue.sqlite3');

	requireOutsideCheckout(dataDirectory);
	requireOutsideCheckout(masterKey);
	rejectBroadCustomDataDirectory(dataDirectory);
	assertPrivateFilePath(masterKey);
	assertPrivateFilePath(database);
	assertPrivateFilePath(`${database}-wal`);
	assertPrivateFilePath(`${database}-shm`);

	return { dataDirectory, database, masterKey };
}

export function ensurePrivateDataDirectory(): DataPaths {
	const paths = getDataPaths();
	const dataDirectoryExisted = existsSync(paths.dataDirectory);
	const mayHardenDataDirectory =
		!dataDirectoryExisted || process.env.CARDDUE_DATA_DIR === undefined;
	mkdirSync(paths.dataDirectory, { recursive: true, mode: 0o700 });
	const dataDirectoryStat = lstatIfPresent(paths.dataDirectory);
	if (!dataDirectoryStat?.isDirectory() || dataDirectoryStat.isSymbolicLink()) {
		throw new AppError('UNSAFE_DATA_PATH', 'The private data path is not a directory.', 500);
	}
	if (process.platform !== 'win32') {
		if (mayHardenDataDirectory) {
			chmodSync(paths.dataDirectory, 0o700);
		} else if ((dataDirectoryStat.mode & 0o077) !== 0) {
			throw new AppError(
				'INSECURE_DATA_DIRECTORY',
				'The custom data directory must be accessible only to its owner.',
				500
			);
		}
	}

	const keyParent = dirname(paths.masterKey);
	const keyParentExisted = existsSync(keyParent);
	if (!keyParentExisted) mkdirSync(keyParent, { recursive: true, mode: 0o700 });
	const keyParentStat = lstatIfPresent(keyParent);
	if (!keyParentStat?.isDirectory() || keyParentStat.isSymbolicLink()) {
		throw new AppError('UNSAFE_DATA_PATH', 'The master key parent is not a directory.', 500);
	}
	if (process.platform !== 'win32') {
		if (!keyParentExisted || (keyParent === paths.dataDirectory && mayHardenDataDirectory)) {
			chmodSync(keyParent, 0o700);
		} else if ((keyParentStat.mode & 0o077) !== 0) {
			throw new AppError(
				'INSECURE_MASTER_KEY_DIRECTORY',
				'The master key directory must be accessible only to its owner.',
				500
			);
		}
	}

	assertPrivateFilePath(paths.database);
	assertPrivateFilePath(`${paths.database}-wal`);
	assertPrivateFilePath(`${paths.database}-shm`);
	assertPrivateFilePath(paths.masterKey);
	return paths;
}
