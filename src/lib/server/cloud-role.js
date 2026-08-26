export const CLOUD_RUNTIME_ROLE_PATTERN = /^carddue_[a-z0-9_]{1,54}$/;

/** @typedef {Record<string, unknown>} CloudRoleRow */
/** @typedef {(text: string, parameters?: unknown[]) => Promise<CloudRoleRow[]>} CloudRoleQuery */

export const CLOUD_TABLE_ACCESS = Object.freeze([
	Object.freeze({
		name: 'carddue_metadata',
		select: true,
		insert: true,
		update: true,
		delete: false
	}),
	...[
		'carddue_plaid_items',
		'carddue_cards',
		'carddue_auth_sessions',
		'carddue_auth_rate_limits'
	].map((name) => Object.freeze({ name, select: true, insert: true, update: true, delete: true }))
]);

export const CLOUD_TABLE_NAMES = Object.freeze(CLOUD_TABLE_ACCESS.map(({ name }) => name));

/** @param {string} value */
export function isCloudRuntimeRoleName(value) {
	return CLOUD_RUNTIME_ROLE_PATTERN.test(value) && !value.includes('owner');
}

const ROLE_STATE_QUERY = `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
       r.rolreplication, r.rolbypassrls, r.rolinherit,
       COALESCE(pg_catalog.array_length(r.rolconfig, 1), 0) > 0 AS has_role_settings,
	   EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_db_role_setting setting
	     JOIN pg_catalog.pg_database current_database
	       ON current_database.datname = pg_catalog.current_database()
	     WHERE (setting.setrole = r.oid AND setting.setdatabase IN (0, current_database.oid))
	        OR (setting.setrole = 0 AND setting.setdatabase = current_database.oid)
	   ) AS has_database_role_settings,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_auth_members membership WHERE membership.member = r.oid
       ) AS has_memberships,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_database database WHERE database.datdba = r.oid
       ) AS owns_database,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_namespace namespace WHERE namespace.nspowner = r.oid
       ) AS owns_schema,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_class relation WHERE relation.relowner = r.oid
       ) AS owns_relation,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_namespace namespace
         WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND pg_catalog.has_schema_privilege(r.rolname, namespace.oid, 'CREATE')
       ) AS can_create_in_schema,
       EXISTS (
         SELECT 1
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND NOT (namespace.nspname = 'public' AND relation.relname = ANY($2::text[]))
           AND (
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'SELECT') OR
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'INSERT') OR
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'UPDATE') OR
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'DELETE') OR
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'TRUNCATE') OR
             pg_catalog.has_table_privilege(r.rolname, relation.oid, 'REFERENCES') OR
		     pg_catalog.has_table_privilege(r.rolname, relation.oid, 'TRIGGER') OR
		     pg_catalog.has_table_privilege(r.rolname, relation.oid, 'MAINTAIN') OR
		     pg_catalog.has_any_column_privilege(r.rolname, relation.oid, 'SELECT') OR
		     pg_catalog.has_any_column_privilege(r.rolname, relation.oid, 'INSERT') OR
		     pg_catalog.has_any_column_privilege(r.rolname, relation.oid, 'UPDATE') OR
		     pg_catalog.has_any_column_privilege(r.rolname, relation.oid, 'REFERENCES')
           )
       ) AS has_other_relation_access,
       EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_class sequence
	     JOIN pg_catalog.pg_namespace namespace ON namespace.oid = sequence.relnamespace
	     WHERE sequence.relkind = 'S'
	       AND namespace.nspname !~ '^pg_'
	       AND namespace.nspname <> 'information_schema'
	       AND (
	         pg_catalog.has_sequence_privilege(r.rolname, sequence.oid, 'USAGE') OR
	         pg_catalog.has_sequence_privilege(r.rolname, sequence.oid, 'SELECT') OR
	         pg_catalog.has_sequence_privilege(r.rolname, sequence.oid, 'UPDATE')
	       )
	   ) AS has_sequence_access,
	   EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = procedure.pronamespace
		 WHERE namespace.nspname !~ '^pg_'
           AND namespace.nspname <> 'information_schema'
           AND pg_catalog.has_function_privilege(r.rolname, procedure.oid, 'EXECUTE')
	   ) AS can_execute_non_system_function,
	   EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_settings setting
	     WHERE pg_catalog.has_parameter_privilege(r.rolname, setting.name, 'ALTER SYSTEM')
	   ) AS can_alter_system_parameter
FROM pg_catalog.pg_roles r
WHERE r.rolname = $1`;

const ROLE_CAPABILITY_QUERY = `SELECT
       pg_catalog.has_schema_privilege($1, 'public', 'USAGE') AS schema_usage,
       pg_catalog.has_schema_privilege($1, 'public', 'CREATE') AS schema_create,
       pg_catalog.has_database_privilege($1, pg_catalog.current_database(), 'CREATE') AS database_create`;

const TABLE_PRIVILEGE_QUERY = `SELECT
       pg_catalog.has_table_privilege($1, $2, 'SELECT') AS can_select,
       pg_catalog.has_table_privilege($1, $2, 'INSERT') AS can_insert,
       pg_catalog.has_table_privilege($1, $2, 'UPDATE') AS can_update,
       pg_catalog.has_table_privilege($1, $2, 'DELETE') AS can_delete,
       pg_catalog.has_table_privilege($1, $2, 'TRUNCATE') AS can_truncate,
       pg_catalog.has_table_privilege($1, $2, 'REFERENCES') AS can_reference,
	   pg_catalog.has_table_privilege($1, $2, 'TRIGGER') AS can_trigger,
	   pg_catalog.has_table_privilege($1, $2, 'MAINTAIN') AS can_maintain,
	   pg_catalog.has_any_column_privilege($1, $2, 'REFERENCES') AS can_reference_column,
	   pg_catalog.has_table_privilege($1, $2, 'SELECT WITH GRANT OPTION') AS can_grant_select,
	   pg_catalog.has_table_privilege($1, $2, 'INSERT WITH GRANT OPTION') AS can_grant_insert,
	   pg_catalog.has_table_privilege($1, $2, 'UPDATE WITH GRANT OPTION') AS can_grant_update,
	   pg_catalog.has_table_privilege($1, $2, 'DELETE WITH GRANT OPTION') AS can_grant_delete,
	   pg_catalog.has_any_column_privilege($1, $2, 'SELECT WITH GRANT OPTION') AS can_grant_select_column,
	   pg_catalog.has_any_column_privilege($1, $2, 'INSERT WITH GRANT OPTION') AS can_grant_insert_column,
	   pg_catalog.has_any_column_privilege($1, $2, 'UPDATE WITH GRANT OPTION') AS can_grant_update_column,
	   pg_catalog.has_any_column_privilege($1, $2, 'REFERENCES WITH GRANT OPTION') AS can_grant_reference_column,
	   EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_class relation,
	          LATERAL pg_catalog.aclexplode(
	            COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
	          ) privilege
	     WHERE relation.oid = pg_catalog.to_regclass($2)
	       AND privilege.grantee = 0
	   ) AS has_public_table_privilege,
	   EXISTS (
	     SELECT 1
	     FROM pg_catalog.pg_class relation
	     JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid,
	          LATERAL pg_catalog.aclexplode(attribute.attacl) privilege
	     WHERE relation.oid = pg_catalog.to_regclass($2)
	       AND attribute.attnum > 0
	       AND NOT attribute.attisdropped
	       AND attribute.attacl IS NOT NULL
	       AND privilege.grantee = 0
	   ) AS has_public_column_privilege`;

/** @param {CloudRoleRow | undefined} state */
export function assertRestrictedCloudRoleAttributes(state) {
	if (
		!state ||
		state.rolsuper ||
		state.rolcreaterole ||
		state.rolcreatedb ||
		!state.rolcanlogin ||
		state.rolreplication ||
		state.rolbypassrls ||
		state.rolinherit ||
		state.has_role_settings ||
		state.has_database_role_settings ||
		state.has_memberships ||
		state.owns_database ||
		state.owns_schema ||
		state.owns_relation
	) {
		throw new Error('The runtime role is not an isolated, non-owner SQL role.');
	}
}

/** @param {CloudRoleRow | undefined} state */
export function assertRestrictedCloudRoleState(state) {
	if (!state) {
		throw new Error('The runtime role is not an isolated, non-owner SQL role.');
	}
	assertRestrictedCloudRoleAttributes(state);
	if (
		state.can_create_in_schema ||
		state.has_other_relation_access ||
		state.has_sequence_access ||
		state.can_execute_non_system_function ||
		state.can_alter_system_parameter
	) {
		throw new Error('The runtime role is not an isolated, non-owner SQL role.');
	}
}

/**
 * @param {CloudRoleQuery} query
 * @param {string} role
 */
export async function readCloudRoleState(query, role) {
	const rows = await query(ROLE_STATE_QUERY, [role, CLOUD_TABLE_NAMES]);
	return rows[0];
}

/**
 * @param {CloudRoleQuery} query
 * @param {string} role
 */
export async function readCloudRoleCapabilities(query, role) {
	return (await query(ROLE_CAPABILITY_QUERY, [role]))[0];
}

/**
 * @param {CloudRoleQuery} query
 * @param {string} role
 * @param {string} qualifiedTable
 */
export async function readCloudTablePrivileges(query, role, qualifiedTable) {
	return (await query(TABLE_PRIVILEGE_QUERY, [role, qualifiedTable]))[0];
}

/**
 * @param {CloudRoleQuery} query
 * @param {string} role
 */
export async function verifyCloudRolePrivileges(query, role) {
	const capabilities = await readCloudRoleCapabilities(query, role);
	if (!capabilities?.schema_usage || capabilities.schema_create || capabilities.database_create) {
		throw new Error('The runtime role failed the effective DDL privilege check.');
	}

	for (const expected of CLOUD_TABLE_ACCESS) {
		const qualified = `public.${expected.name}`;
		const privileges = await readCloudTablePrivileges(query, role, qualified);
		if (
			!privileges ||
			Boolean(privileges.can_select) !== expected.select ||
			Boolean(privileges.can_insert) !== expected.insert ||
			Boolean(privileges.can_update) !== expected.update ||
			Boolean(privileges.can_delete) !== expected.delete ||
			privileges.can_truncate ||
			privileges.can_reference ||
			privileges.can_trigger ||
			privileges.can_maintain ||
			privileges.can_reference_column ||
			privileges.can_grant_select ||
			privileges.can_grant_insert ||
			privileges.can_grant_update ||
			privileges.can_grant_delete ||
			privileges.can_grant_select_column ||
			privileges.can_grant_insert_column ||
			privileges.can_grant_update_column ||
			privileges.can_grant_reference_column ||
			privileges.has_public_table_privilege ||
			privileges.has_public_column_privilege
		) {
			throw new Error('The runtime role failed the exact table privilege check.');
		}
	}
}

/**
 * @param {CloudRoleQuery} query
 * @param {string} role
 */
export async function verifyCloudRoleBoundary(query, role) {
	if (!isCloudRuntimeRoleName(role)) {
		throw new Error('The runtime database identity is not a dedicated CardDue role.');
	}
	assertRestrictedCloudRoleState(await readCloudRoleState(query, role));
	await verifyCloudRolePrivileges(query, role);
}
