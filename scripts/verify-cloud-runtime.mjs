import { neon } from '@neondatabase/serverless';
import { isCloudRuntimeRoleName, verifyCloudRoleBoundary } from '../src/lib/server/cloud-role.js';
import { CLOUD_SCHEMA_VERSION, verifyCloudSchemaCatalog } from '../src/lib/server/cloud-schema.js';
import { isDirectNeonDatabaseHost } from '../src/lib/server/neon-url.js';

let failurePhase = 'configuration validation';

function databaseUrl() {
	const value = process.env.DATABASE_URL?.trim();
	if (!value) throw new Error('Missing DATABASE_URL.');
	const parsed = new URL(value);
	const modes = parsed.searchParams.getAll('sslmode');
	const role = decodeURIComponent(parsed.username);
	if (
		!['postgres:', 'postgresql:'].includes(parsed.protocol) ||
		!parsed.hostname ||
		!isDirectNeonDatabaseHost(parsed.hostname) ||
		!parsed.username ||
		!parsed.password ||
		parsed.pathname === '/' ||
		parsed.hash ||
		[...parsed.searchParams.keys()].some((parameter) => parameter !== 'sslmode') ||
		modes.length !== 1 ||
		!['require', 'verify-full'].includes(modes[0] ?? '') ||
		!isCloudRuntimeRoleName(role)
	) {
		throw new Error('The runtime database URL is not securely restricted.');
	}
	return { value, role };
}

async function main() {
	const config = databaseUrl();
	const sql = neon(config.value);
	const query = (text, parameters = []) => sql.query(text, parameters);

	failurePhase = 'database identity validation';
	const identity = (
		await query(`SELECT current_user AS current_user, session_user AS session_user`)
	)[0];
	if (!identity || identity.current_user !== config.role || identity.session_user !== config.role) {
		throw new Error('The runtime database identity is unsafe.');
	}

	failurePhase = 'role privilege validation';
	await verifyCloudRoleBoundary(query, config.role);

	failurePhase = 'schema catalog validation';
	await verifyCloudSchemaCatalog(query);
	const schema = await query(
		`SELECT value FROM public.carddue_metadata WHERE key = 'schema_version'`
	);
	if (schema.length !== 1 || schema[0].value !== String(CLOUD_SCHEMA_VERSION)) {
		throw new Error('The cloud schema version does not match this ChipDue release.');
	}

	console.log(`Restricted cloud runtime verified for schema ${CLOUD_SCHEMA_VERSION}.`);
}

main().catch(() => {
	console.error(
		`Cloud runtime verification failed during ${failurePhase}. No credential was printed.`
	);
	process.exitCode = 1;
});
