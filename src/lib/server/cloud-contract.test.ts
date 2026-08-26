import { describe, expect, it } from 'vitest';
import {
	assertDistinctRuntimePasswords,
	assertRuntimeSessionsInvalidated,
	createPasswordRotationParameters,
	createScramVerifier,
	isAuthenticationRejection,
	PASSWORD_ROTATION_SQL,
	verifyExistingSchema
} from '../../../scripts/migrate-cloud.mjs';
import { CLOUD_TABLE_ACCESS, verifyCloudRoleBoundary } from './cloud-role.js';
import {
	CLOUD_SCHEMA_CATALOG_CONTRACT,
	CLOUD_SCHEMA_STATEMENTS,
	verifyCloudSchemaCatalog
} from './cloud-schema.js';
import { isDirectNeonDatabaseHost } from './neon-url.js';

function safeRoleState(): Record<string, boolean> {
	return {
		rolsuper: false,
		rolcreaterole: false,
		rolcreatedb: false,
		rolcanlogin: true,
		rolreplication: false,
		rolbypassrls: false,
		rolinherit: false,
		has_role_settings: false,
		has_database_role_settings: false,
		has_memberships: false,
		owns_database: false,
		owns_schema: false,
		owns_relation: false,
		can_create_in_schema: false,
		has_other_relation_access: false,
		has_sequence_access: false,
		can_execute_non_system_function: false,
		can_alter_system_parameter: false
	};
}

function exactPrivileges(table: string): Record<string, boolean> {
	const expected = CLOUD_TABLE_ACCESS.find(({ name }) => `public.${name}` === table);
	if (!expected) throw new Error('Unexpected table in contract test.');
	return {
		can_select: expected.select,
		can_insert: expected.insert,
		can_update: expected.update,
		can_delete: expected.delete,
		can_truncate: false,
		can_reference: false,
		can_trigger: false,
		can_maintain: false,
		can_reference_column: false,
		can_grant_select: false,
		can_grant_insert: false,
		can_grant_update: false,
		can_grant_delete: false,
		can_grant_select_column: false,
		can_grant_insert_column: false,
		can_grant_update_column: false,
		can_grant_reference_column: false,
		has_public_table_privilege: false,
		has_public_column_privilege: false
	};
}

function roleQuery(
	state: Record<string, boolean>,
	mutatePrivileges?: (table: string, privileges: Record<string, boolean>) => void
) {
	return async (text: string, parameters: unknown[] = []) => {
		if (text.includes('FROM pg_catalog.pg_roles')) return [state];
		if (text.includes('AS schema_usage')) {
			return [{ schema_usage: true, schema_create: false, database_create: false }];
		}
		if (text.includes('AS can_select')) {
			const table = String(parameters[1]);
			const privileges = exactPrivileges(table);
			mutatePrivileges?.(table, privileges);
			return [privileges];
		}
		throw new Error('Unexpected role contract query.');
	};
}

function catalogQuery(contract = CLOUD_SCHEMA_CATALOG_CONTRACT) {
	return async (text: string) => {
		if (text.includes('AS user_trigger_count'))
			return contract.relations.map((row) => ({ ...row }));
		if (text.includes('AS ordinal_position')) return contract.columns.map((row) => ({ ...row }));
		if (text.includes('AS constraint_type')) return contract.constraints.map((row) => ({ ...row }));
		if (text.includes('AS index_name')) return contract.indexes.map((row) => ({ ...row }));
		throw new Error('Unexpected schema contract query.');
	};
}

describe('cloud SQL security contract', () => {
	it('accepts only the exact restricted role and table privilege boundary', async () => {
		await expect(
			verifyCloudRoleBoundary(roleQuery(safeRoleState()), 'carddue_runtime')
		).resolves.toBeUndefined();
	});

	it('rejects role escalation and grants leaked through PUBLIC', async () => {
		await expect(
			verifyCloudRoleBoundary(
				roleQuery({ ...safeRoleState(), rolcreaterole: true }),
				'carddue_runtime'
			)
		).rejects.toThrow(/isolated/);

		await expect(
			verifyCloudRoleBoundary(
				roleQuery(safeRoleState(), (_table, privileges) => {
					privileges.has_public_column_privilege = true;
				}),
				'carddue_runtime'
			)
		).rejects.toThrow(/exact table privilege/);
	});

	it('rejects missing DML, MAINTAIN, and grant options', async () => {
		for (const field of ['can_insert', 'can_maintain', 'can_grant_select'] as const) {
			await expect(
				verifyCloudRoleBoundary(
					roleQuery(safeRoleState(), (_table, privileges) => {
						privileges[field] = field === 'can_insert' ? false : true;
					}),
					'carddue_runtime'
				)
			).rejects.toThrow(/exact table privilege/);
		}
	});

	it('accepts the exact catalog and rejects structural drift', async () => {
		await expect(verifyCloudSchemaCatalog(catalogQuery())).resolves.toBeUndefined();
		const columns = CLOUD_SCHEMA_CATALOG_CONTRACT.columns.map((row) => ({ ...row }));
		columns[0] = { ...columns[0], data_type: 'integer' };
		await expect(
			verifyCloudSchemaCatalog(catalogQuery({ ...CLOUD_SCHEMA_CATALOG_CONTRACT, columns }))
		).rejects.toThrow(/catalog/);
	});

	it('refuses to relabel a future schema version', async () => {
		const query = async (text: string) => {
			if (text.includes('AS relation_count')) return [{ relation_count: 5 }];
			if (text.includes("WHERE key = 'schema_version'")) return [{ value: '2' }];
			return catalogQuery()(text);
		};
		await expect(verifyExistingSchema(query)).rejects.toThrow(/cannot be migrated/);
	});

	it('uses public-qualified DDL and a non-plaintext SCRAM verifier', () => {
		for (const statement of CLOUD_SCHEMA_STATEMENTS) {
			expect(statement).not.toMatch(/(?:FROM|INTO|UPDATE|TABLE|REFERENCES) carddue_/);
		}
		const password = ['synthetic', 'database', 'password'].join('-');
		const verifier = createScramVerifier(password, Buffer.alloc(16, 5));
		expect(verifier).toMatch(
			/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/
		);
		expect(verifier).not.toContain(password);
		const parameters = createPasswordRotationParameters('carddue_runtime', password);
		expect(parameters[0]).toBe(password);
		expect(parameters[1]).toBe('carddue_runtime');
		expect(PASSWORD_ROTATION_SQL.join('\n')).toContain(
			"SET LOCAL password_encryption = 'scram-sha-256'"
		);
		expect(PASSWORD_ROTATION_SQL.join('\n')).toContain('$1');
		expect(PASSWORD_ROTATION_SQL.join('\n')).not.toContain(password);
	});

	it('accepts only an authentication SQLSTATE or the pinned Neon rejection shape', () => {
		const role = 'carddue_runtime';
		expect(isAuthenticationRejection({ code: '28P01' }, role)).toBe(true);
		expect(
			isAuthenticationRejection(
				{
					name: 'NeonDbError',
					code: '',
					message: "password authentication failed for user 'carddue_runtime'"
				},
				role
			)
		).toBe(true);
		expect(
			isAuthenticationRejection(
				{
					name: 'NeonDbError',
					code: undefined,
					message: "password authentication failed for user 'carddue_runtime'"
				},
				role
			)
		).toBe(false);
		expect(isAuthenticationRejection({ code: 'XX000' }, role)).toBe(false);
		expect(
			isAuthenticationRejection(
				{
					name: 'NeonDbError',
					code: '',
					message: 'password authentication failed for user "carddue_runtime"'
				},
				role
			)
		).toBe(false);
		expect(
			isAuthenticationRejection(
				{
					name: 'NeonDbError',
					code: '',
					message: "password authentication failed for user 'another_role'"
				},
				role
			)
		).toBe(false);
		expect(isAuthenticationRejection(new Error('network unavailable'), role)).toBe(false);
	});

	it('requires a distinct credential for an existing-role rotation', () => {
		expect(() => assertDistinctRuntimePasswords('current', 'replacement')).not.toThrow();
		expect(() => assertDistinctRuntimePasswords('same', 'same')).toThrow(/distinct/);
	});

	it('requires every prior runtime session to terminate with zero survivors', () => {
		expect(() => assertRuntimeSessionsInvalidated(true, 0)).not.toThrow();
		expect(() => assertRuntimeSessionsInvalidated(false, 0)).toThrow(/invalidated/);
		expect(() => assertRuntimeSessionsInvalidated(true, 1)).toThrow(/invalidated/);
	});

	it('accepts only direct Neon endpoint hosts', () => {
		expect(isDirectNeonDatabaseHost('ep-carddue-test.us-west-2.aws.neon.tech')).toBe(true);
		expect(isDirectNeonDatabaseHost('ep-carddue-test-pooler.us-west-2.aws.neon.tech')).toBe(false);
		expect(isDirectNeonDatabaseHost('database.example.test')).toBe(false);
	});
});
