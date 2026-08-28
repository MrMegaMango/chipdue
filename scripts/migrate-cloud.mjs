import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import {
	assertRestrictedCloudRoleAttributes,
	CLOUD_TABLE_ACCESS,
	CLOUD_TABLE_NAMES,
	isCloudRuntimeRoleName,
	readCloudRoleState,
	verifyCloudRoleBoundary
} from '../src/lib/server/cloud-role.js';
import {
	cloudSchemaRelationCount,
	CLOUD_SCHEMA_STATEMENTS,
	CLOUD_SCHEMA_VERSION,
	CLOUD_SCHEMA_VERSION_STATEMENT,
	CLOUD_TABLE_COLUMNS,
	verifyCloudSchemaCatalog
} from '../src/lib/server/cloud-schema.js';
import { isDirectNeonDatabaseHost } from '../src/lib/server/neon-url.js';

const SCRAM_ITERATIONS = 4096;
let failurePhase = 'configuration validation';

/** @typedef {Record<string, unknown>} MigrationRow */
/** @typedef {(text: string, parameters?: unknown[]) => Promise<MigrationRow[]>} MigrationQuery */

/** @param {string} name */
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing ${name}.`);
	return value;
}

/** @param {string} name */
function validatedDatabaseUrl(name) {
	const value = required(name);
	const parsed = new URL(value);
	const sslModes = parsed.searchParams.getAll('sslmode');
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!parsed.hostname ||
		!isDirectNeonDatabaseHost(parsed.hostname) ||
		!parsed.username ||
		!parsed.password ||
		parsed.pathname === '/' ||
		parsed.hash ||
		[...parsed.searchParams.keys()].some((parameter) => parameter !== 'sslmode') ||
		sslModes.length !== 1 ||
		!['require', 'verify-full'].includes(sslModes[0] ?? '')
	) {
		throw new Error('The database URL is invalid or does not require TLS.');
	}
	return { value, role: decodeURIComponent(parsed.username) };
}

function runtimeRole() {
	const value = required('CARDDUE_DATABASE_ROLE');
	if (!isCloudRuntimeRoleName(value)) {
		throw new Error('The runtime role must be a dedicated lowercase carddue_* role.');
	}
	return value;
}

function runtimeRolePassword() {
	return databasePassword('CARDDUE_DATABASE_PASSWORD');
}

/** @param {string} name */
function databasePassword(name) {
	const value = required(name);
	if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').length !== 32) {
		throw new Error('A runtime database password must be a generated 256-bit base64url value.');
	}
	return value;
}

/** @param {string} value */
function quoteIdentifier(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

/** @param {number} milliseconds */
function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/**
 * @param {string} password
 * @param {Buffer} salt
 */
export function createScramVerifier(password, salt = randomBytes(16)) {
	if (!Buffer.isBuffer(salt) || salt.length < 16 || salt.length > 64) {
		throw new Error('A valid SCRAM salt is required.');
	}
	const saltedPassword = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
	const clientKey = createHmac('sha256', saltedPassword).update('Client Key', 'utf8').digest();
	const storedKey = createHash('sha256').update(clientKey).digest();
	const serverKey = createHmac('sha256', saltedPassword).update('Server Key', 'utf8').digest();
	const verifier = `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
	saltedPassword.fill(0);
	clientKey.fill(0);
	storedKey.fill(0);
	serverKey.fill(0);
	return verifier;
}

/**
 * @param {string} role
 * @param {string} password
 */
export function createPasswordRotationParameters(role, password) {
	if (!isCloudRuntimeRoleName(role)) throw new Error('A valid ChipDue runtime role is required.');
	return [password, role];
}

/** @param {MigrationQuery} query */
export async function verifyExistingSchema(query) {
	const relationCount = await cloudSchemaRelationCount(query);
	if (relationCount === 0) return;
	await verifyCloudSchemaCatalog(query);
	const rows = await query(
		`SELECT value FROM public.carddue_metadata WHERE key = 'schema_version'`
	);
	if (rows.length > 1 || (rows.length === 1 && rows[0].value !== String(CLOUD_SCHEMA_VERSION))) {
		throw new Error('The existing cloud schema version cannot be migrated by this release.');
	}
}

const CONFIGURE_PASSWORD_ROTATION = `WITH configured AS (
  SELECT pg_catalog.set_config('carddue.migration_password', $1, true) AS password,
         pg_catalog.set_config('carddue.migration_role', $2, true) AS role
)
SELECT pg_catalog.length(password) > 0 AND pg_catalog.length(role) > 0 AS configured
FROM configured`;

const APPLY_PASSWORD_ROTATION = `DO $carddue_rotation$
BEGIN
  EXECUTE pg_catalog.format(
    'ALTER ROLE %I WITH PASSWORD %L',
    pg_catalog.current_setting('carddue.migration_role'),
    pg_catalog.current_setting('carddue.migration_password')
  );
END
$carddue_rotation$`;

const CLEAR_PASSWORD_ROTATION = `SELECT
  pg_catalog.set_config('carddue.migration_password', '', true) = '' AND
  pg_catalog.set_config('carddue.migration_role', '', true) = '' AS cleared`;

export const PASSWORD_ROTATION_SQL = Object.freeze([
	`SET LOCAL password_encryption = 'scram-sha-256'`,
	CONFIGURE_PASSWORD_ROTATION,
	APPLY_PASSWORD_ROTATION,
	CLEAR_PASSWORD_ROTATION
]);

/** @param {unknown} error */
export function sqlState(error) {
	if (!error || typeof error !== 'object' || !('code' in error)) return '';
	const code = String(error.code);
	return /^[0-9A-Z]{5}$/.test(code) ? code : '';
}

/**
 * @param {unknown} error
 * @param {string} role
 */
export function isAuthenticationRejection(error, role) {
	if (sqlState(error) === '28P01') return true;
	if (!isCloudRuntimeRoleName(role) || !error || typeof error !== 'object') return false;
	const candidate = /** @type {Record<string, unknown>} */ (error);
	return (
		candidate.name === 'NeonDbError' &&
		Object.hasOwn(candidate, 'code') &&
		candidate.code === '' &&
		candidate.message === `password authentication failed for user '${role}'`
	);
}

/**
 * @param {string} currentPassword
 * @param {string} newPassword
 */
export function assertDistinctRuntimePasswords(currentPassword, newPassword) {
	if (currentPassword === newPassword) {
		throw new Error('An existing runtime role requires a distinct replacement password.');
	}
}

/**
 * @param {unknown} allTerminated
 * @param {unknown} remainingCount
 */
export function assertRuntimeSessionsInvalidated(allTerminated, remainingCount) {
	if (allTerminated !== true || Number(remainingCount ?? -1) !== 0) {
		throw new Error('Existing runtime database sessions could not be invalidated.');
	}
}

/**
 * @param {import('@neondatabase/serverless').NeonQueryFunction<false, false>} sql
 * @param {{ value: string }} migration
 * @param {string} role
 * @param {string} roleIdentifier
 * @param {string} database
 * @param {string} currentPassword
 * @param {string} newPassword
 */
async function rotateExistingRuntimePassword(
	sql,
	migration,
	role,
	roleIdentifier,
	database,
	currentPassword,
	newPassword
) {
	assertDistinctRuntimePasswords(currentPassword, newPassword);
	const rotationParameters = createPasswordRotationParameters(role, newPassword);
	const currentUrl = new URL(migration.value);
	currentUrl.username = role;
	currentUrl.password = currentPassword;
	const runtimeSql = neon(currentUrl.toString());
	currentUrl.password = '';
	let runtimeIdentity;
	try {
		runtimeIdentity = (
			await runtimeSql.query(`SELECT current_user AS current_user, session_user AS session_user`)
		)[0];
	} catch (error) {
		rotationParameters[0] = '';
		throw error;
	}
	if (
		!runtimeIdentity ||
		runtimeIdentity.current_user !== role ||
		runtimeIdentity.session_user !== role
	) {
		rotationParameters[0] = '';
		throw new Error('The current runtime credential resolved to an unexpected role.');
	}

	let ownerDenied = false;
	try {
		await sql.transaction((transaction) => [
			transaction.query(`SET LOCAL ROLE neon_superuser`),
			transaction.query(PASSWORD_ROTATION_SQL[0]),
			transaction.query(CONFIGURE_PASSWORD_ROTATION, rotationParameters),
			transaction.query(`ALTER ROLE ${roleIdentifier} RESET ALL`),
			transaction.query(
				`ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(database)} RESET ALL`
			),
			transaction.query(APPLY_PASSWORD_ROTATION),
			transaction.query(CLEAR_PASSWORD_ROTATION)
		]);
	} catch (error) {
		if (sqlState(error) !== '42501') {
			rotationParameters[0] = '';
			throw error;
		}
		ownerDenied = true;
	}

	try {
		if (ownerDenied) {
			await runtimeSql.transaction((transaction) => [
				transaction.query(PASSWORD_ROTATION_SQL[0]),
				transaction.query(CONFIGURE_PASSWORD_ROTATION, rotationParameters),
				transaction.query(`ALTER ROLE ${roleIdentifier} RESET ALL`),
				transaction.query(
					`ALTER ROLE ${roleIdentifier} IN DATABASE ${quoteIdentifier(database)} RESET ALL`
				),
				transaction.query(APPLY_PASSWORD_ROTATION),
				transaction.query(CLEAR_PASSWORD_ROTATION)
			]);
		}
	} finally {
		rotationParameters[0] = '';
	}

	const newUrl = new URL(migration.value);
	newUrl.username = role;
	newUrl.password = newPassword;
	const newSql = neon(newUrl.toString());
	newUrl.password = '';
	const newIdentity = (
		await newSql.query(`SELECT current_user AS current_user, session_user AS session_user`)
	)[0];
	if (!newIdentity || newIdentity.current_user !== role || newIdentity.session_user !== role) {
		throw new Error('The replacement runtime credential could not be verified.');
	}

	const oldUrl = new URL(migration.value);
	oldUrl.username = role;
	oldUrl.password = currentPassword;
	const oldConnection = oldUrl.toString();
	oldUrl.password = '';
	let oldRejected = false;
	for (let attempt = 0; attempt < 10 && !oldRejected; attempt += 1) {
		try {
			await neon(oldConnection).query(`SELECT 1 AS connected`);
		} catch (error) {
			oldRejected = isAuthenticationRejection(error, role);
			if (!oldRejected) throw error;
		}
		if (!oldRejected && attempt < 9) await delay(500);
	}
	if (!oldRejected) throw new Error('The previous runtime credential is still accepted.');
}

async function main() {
	const role = runtimeRole();
	const password = runtimeRolePassword();
	const roleIdentifier = quoteIdentifier(role);
	const migration = validatedDatabaseUrl('CARDDUE_MIGRATION_DATABASE_URL');
	const sql = neon(migration.value);
	/** @type {MigrationQuery} */
	const query = (text, parameters = []) => sql.query(text, parameters);

	failurePhase = 'migration identity validation';
	const identity = (
		await query(
			`SELECT current_user AS current_user, session_user AS session_user,
			        current_database() AS current_database`
		)
	)[0];
	if (
		!identity ||
		identity.current_user !== identity.session_user ||
		identity.current_user !== migration.role ||
		identity.current_user === role
	) {
		throw new Error('The migration connection must use one unchanged database owner identity.');
	}
	failurePhase = 'migration authority validation';
	const authority = (
		await query(
			`SELECT pg_catalog.pg_has_role(current_user, 'neon_superuser', 'SET') AS can_assume_neon_admin,
			        pg_catalog.current_setting('password_encryption') AS password_encryption`
		)
	)[0];
	if (
		!authority?.can_assume_neon_admin ||
		String(authority.password_encryption).toLowerCase() !== 'scram-sha-256'
	) {
		throw new Error('The migration identity cannot assume the Neon administrative role.');
	}

	failurePhase = 'existing schema validation';
	await verifyExistingSchema(query);

	failurePhase = 'runtime role preflight';
	const existing = await readCloudRoleState(query, role);
	if (existing) {
		assertRestrictedCloudRoleAttributes({
			...existing,
			has_role_settings: false,
			has_database_role_settings: false
		});
	}

	failurePhase = 'runtime credential rotation';
	try {
		if (existing) {
			const currentPassword = databasePassword('CARDDUE_CURRENT_DATABASE_PASSWORD');
			await rotateExistingRuntimePassword(
				sql,
				migration,
				role,
				roleIdentifier,
				String(identity.current_database),
				currentPassword,
				password
			);
		} else {
			let verifier = createScramVerifier(password);
			try {
				await sql.transaction((transaction) => [
					transaction.query(`SET LOCAL ROLE neon_superuser`),
					transaction.query(
						`CREATE ROLE ${roleIdentifier} WITH LOGIN PASSWORD '${verifier}' NOINHERIT`
					)
				]);
			} finally {
				verifier = '';
			}
		}
	} catch (error) {
		const code = sqlState(error);
		if (code) failurePhase = `${failurePhase} (SQLSTATE ${code})`;
		throw error;
	}
	failurePhase = 'runtime session invalidation';
	let allTerminated = false;
	let remainingCount = -1;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		let terminationResults;
		try {
			terminationResults = await sql.transaction((transaction) => [
				transaction.query(`SET LOCAL ROLE neon_superuser`),
				transaction.query(`SET LOCAL statement_timeout = '5s'`),
				transaction.query(
					`WITH terminated AS MATERIALIZED (
					   SELECT pg_catalog.pg_terminate_backend(activity.pid, 5000) AS result
					   FROM pg_catalog.pg_stat_activity activity
					   WHERE activity.usename = $1
					     AND activity.pid <> pg_catalog.pg_backend_pid()
					 )
					 SELECT COALESCE(pg_catalog.bool_and(result), true) AS all_terminated,
					        pg_catalog.count(*)::integer AS target_count
					 FROM terminated`,
					[role]
				),
				transaction.query(
					`SELECT pg_catalog.count(*)::integer AS remaining_count
					 FROM pg_catalog.pg_stat_activity activity
					 WHERE activity.usename = $1
					   AND activity.pid <> pg_catalog.pg_backend_pid()`,
					[role]
				)
			]);
		} catch (error) {
			const code = sqlState(error);
			if (code) failurePhase = `${failurePhase} (SQLSTATE ${code})`;
			throw error;
		}
		allTerminated = terminationResults[2]?.[0]?.all_terminated === true;
		remainingCount = Number(terminationResults[3]?.[0]?.remaining_count ?? -1);
		if (!allTerminated) {
			failurePhase = 'runtime session termination confirmation';
			break;
		}
		if (remainingCount === 0) break;
		if (attempt < 9) await delay(500);
	}
	if (allTerminated && remainingCount !== 0) {
		failurePhase = 'runtime session survivor check';
	}
	assertRuntimeSessionsInvalidated(allTerminated, remainingCount);
	failurePhase = 'runtime SCRAM storage verification';
	const scramResults = await sql.transaction((transaction) => [
		transaction.query(`SET LOCAL ROLE neon_superuser`),
		transaction.query(
			`SELECT EXISTS (
			   SELECT 1 FROM pg_catalog.pg_authid role_record
			   WHERE role_record.rolname = $1
			     AND role_record.rolpassword LIKE 'SCRAM-SHA-256$%'
			 ) AS stored_scram`,
			[role]
		)
	]);
	if (!scramResults[1]?.[0]?.stored_scram) {
		throw new Error('The runtime role password is not stored as a SCRAM verifier.');
	}
	failurePhase = 'runtime role attribute verification';
	assertRestrictedCloudRoleAttributes(await readCloudRoleState(query, role));

	failurePhase = 'schema and privilege migration';
	const tableList = CLOUD_TABLE_NAMES.map((table) => `public.${quoteIdentifier(table)}`).join(', ');
	const mutableTableList = CLOUD_TABLE_ACCESS.filter(({ delete: canDelete }) => canDelete)
		.map(({ name }) => `public.${quoteIdentifier(name)}`)
		.join(', ');
	const columnRevokes = Object.entries(CLOUD_TABLE_COLUMNS).flatMap(([table, columns]) => {
		const columnList = columns.map(quoteIdentifier).join(', ');
		const privileges = `SELECT (${columnList}), INSERT (${columnList}), UPDATE (${columnList}), REFERENCES (${columnList})`;
		const target = `public.${quoteIdentifier(table)}`;
		return [
			`REVOKE ${privileges} ON TABLE ${target} FROM PUBLIC`,
			`REVOKE ${privileges} ON TABLE ${target} FROM ${roleIdentifier}`
		];
	});
	await sql.transaction((transaction) => [
		...CLOUD_SCHEMA_STATEMENTS.map((statement) => transaction.query(statement)),
		transaction.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`),
		transaction.query(`REVOKE CREATE ON SCHEMA public FROM ${roleIdentifier}`),
		transaction.query(`GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`),
		transaction.query(`REVOKE ALL PRIVILEGES ON TABLE ${tableList} FROM PUBLIC`),
		transaction.query(
			`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${roleIdentifier}`
		),
		transaction.query(
			`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${roleIdentifier}`
		),
		transaction.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC`),
		transaction.query(
			`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${roleIdentifier}`
		),
		transaction.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`),
		...columnRevokes.map((statement) => transaction.query(statement)),
		transaction.query(
			`GRANT SELECT, INSERT, UPDATE ON TABLE public.carddue_metadata TO ${roleIdentifier}`
		),
		transaction.query(
			`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${mutableTableList} TO ${roleIdentifier}`
		)
	]);

	failurePhase = 'post-migration contract verification';
	await verifyCloudSchemaCatalog(query);
	await verifyCloudRoleBoundary(query, role);

	failurePhase = 'schema version commit';
	await query(CLOUD_SCHEMA_VERSION_STATEMENT);
	const versionRows = await query(
		`SELECT value FROM public.carddue_metadata WHERE key = 'schema_version'`
	);
	if (versionRows.length !== 1 || versionRows[0].value !== String(CLOUD_SCHEMA_VERSION)) {
		throw new Error('The cloud schema version could not be committed.');
	}

	console.log(`Cloud schema ${CLOUD_SCHEMA_VERSION} migrated for a restricted runtime role.`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
	main().catch(() => {
		console.error(`Cloud migration failed during ${failurePhase}. No credential was printed.`);
		process.exitCode = 1;
	});
}
