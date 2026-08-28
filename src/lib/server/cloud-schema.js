import { CLOUD_TABLE_NAMES } from './cloud-role.js';

/** @typedef {Record<string, unknown>} CloudCatalogRow */
/** @typedef {(text: string, parameters?: unknown[]) => Promise<CloudCatalogRow[]>} CloudCatalogQuery */

export const CLOUD_SCHEMA_VERSION = 1;

export const CLOUD_SCHEMA_STATEMENTS = Object.freeze([
	`CREATE TABLE IF NOT EXISTS public.carddue_metadata (
	  key TEXT PRIMARY KEY,
	  value TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS public.carddue_plaid_items (
	  id UUID PRIMARY KEY,
	  item_ref TEXT NOT NULL UNIQUE,
	  item_id_enc TEXT NOT NULL,
	  access_token_enc TEXT NOT NULL,
	  institution_name_enc TEXT,
	  status TEXT NOT NULL CHECK (status IN ('healthy', 'needs_update')) DEFAULT 'healthy',
	  last_synced_at TEXT,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS public.carddue_cards (
	  id UUID PRIMARY KEY,
	  source TEXT NOT NULL CHECK (source IN ('manual', 'plaid')),
	  plaid_item_id UUID REFERENCES public.carddue_plaid_items(id) ON DELETE CASCADE,
	  external_account_ref TEXT,
	  payload_enc TEXT NOT NULL,
	  last_synced_at TEXT,
	  created_at TEXT NOT NULL,
	  updated_at TEXT NOT NULL,
	  CHECK (
	    (source = 'manual' AND plaid_item_id IS NULL AND external_account_ref IS NULL) OR
	    (source = 'plaid' AND plaid_item_id IS NOT NULL AND external_account_ref IS NOT NULL)
	  ),
	  UNIQUE (plaid_item_id, external_account_ref)
	)`,
	`CREATE INDEX IF NOT EXISTS carddue_cards_source_idx
	 ON public.carddue_cards(source)`,
	`CREATE INDEX IF NOT EXISTS carddue_cards_plaid_item_idx
	 ON public.carddue_cards(plaid_item_id)`,
	`CREATE TABLE IF NOT EXISTS public.carddue_auth_sessions (
	  token_hash TEXT PRIMARY KEY,
	  password_config_ref TEXT NOT NULL,
	  created_at BIGINT NOT NULL,
	  expires_at BIGINT NOT NULL,
	  last_seen_at BIGINT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS carddue_auth_sessions_expiry_idx
	 ON public.carddue_auth_sessions(expires_at)`,
	`CREATE TABLE IF NOT EXISTS public.carddue_auth_rate_limits (
	  bucket_ref TEXT PRIMARY KEY,
	  window_started_at BIGINT NOT NULL,
	  attempts INTEGER NOT NULL,
	  blocked_until BIGINT NOT NULL,
	  updated_at BIGINT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS carddue_auth_rate_limits_updated_idx
	 ON public.carddue_auth_rate_limits(updated_at)`
]);

export const CLOUD_SCHEMA_VERSION_STATEMENT = `INSERT INTO public.carddue_metadata (key, value)
 VALUES ('schema_version', '${CLOUD_SCHEMA_VERSION}')
 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

export const CLOUD_MIGRATION_STATEMENTS = Object.freeze([
	...CLOUD_SCHEMA_STATEMENTS,
	CLOUD_SCHEMA_VERSION_STATEMENT
]);

const EXPECTED_RELATIONS = Object.freeze(
	CLOUD_TABLE_NAMES.map((table_name) =>
		Object.freeze({
			table_name,
			relation_kind: 'r',
			persistence: 'p',
			is_partition: false,
			inheritance_count: 0,
			row_security: false,
			force_row_security: false,
			has_rules: false,
			user_trigger_count: 0
		})
	)
);

const EXPECTED_COLUMN_TABLE_STARTS = Object.freeze([
	{ index: 0 },
	{ index: 2 },
	{ index: 11 },
	{ index: 19 },
	{ index: 24 }
]);

const EXPECTED_COLUMNS = Object.freeze(
	[
		['carddue_metadata', 'key', 'text', true, ''],
		['carddue_metadata', 'value', 'text', true, ''],
		['carddue_plaid_items', 'id', 'uuid', true, ''],
		['carddue_plaid_items', 'item_ref', 'text', true, ''],
		['carddue_plaid_items', 'item_id_enc', 'text', true, ''],
		['carddue_plaid_items', 'access_token_enc', 'text', true, ''],
		['carddue_plaid_items', 'institution_name_enc', 'text', false, ''],
		['carddue_plaid_items', 'status', 'text', true, "'healthy'"],
		['carddue_plaid_items', 'last_synced_at', 'text', false, ''],
		['carddue_plaid_items', 'created_at', 'text', true, ''],
		['carddue_plaid_items', 'updated_at', 'text', true, ''],
		['carddue_cards', 'id', 'uuid', true, ''],
		['carddue_cards', 'source', 'text', true, ''],
		['carddue_cards', 'plaid_item_id', 'uuid', false, ''],
		['carddue_cards', 'external_account_ref', 'text', false, ''],
		['carddue_cards', 'payload_enc', 'text', true, ''],
		['carddue_cards', 'last_synced_at', 'text', false, ''],
		['carddue_cards', 'created_at', 'text', true, ''],
		['carddue_cards', 'updated_at', 'text', true, ''],
		['carddue_auth_sessions', 'token_hash', 'text', true, ''],
		['carddue_auth_sessions', 'password_config_ref', 'text', true, ''],
		['carddue_auth_sessions', 'created_at', 'bigint', true, ''],
		['carddue_auth_sessions', 'expires_at', 'bigint', true, ''],
		['carddue_auth_sessions', 'last_seen_at', 'bigint', true, ''],
		['carddue_auth_rate_limits', 'bucket_ref', 'text', true, ''],
		['carddue_auth_rate_limits', 'window_started_at', 'bigint', true, ''],
		['carddue_auth_rate_limits', 'attempts', 'integer', true, ''],
		['carddue_auth_rate_limits', 'blocked_until', 'bigint', true, ''],
		['carddue_auth_rate_limits', 'updated_at', 'bigint', true, '']
	].map(([table_name, column_name, data_type, not_null, default_expression], index) =>
		Object.freeze({
			table_name,
			column_name,
			data_type,
			not_null,
			default_expression,
			ordinal_position:
				index -
				Math.max(
					...EXPECTED_COLUMN_TABLE_STARTS.filter((start) => start.index <= index).map(
						(start) => start.index
					)
				) +
				1
		})
	)
);

export const CLOUD_TABLE_COLUMNS = Object.freeze(
	Object.fromEntries(
		CLOUD_TABLE_NAMES.map((table) => [
			table,
			Object.freeze(
				EXPECTED_COLUMNS.filter((column) => column.table_name === table).map((column) =>
					String(column.column_name)
				)
			)
		])
	)
);

const EXPECTED_CONSTRAINTS = Object.freeze(
	[
		['carddue_metadata', 'p', 'key', '', '', '', '', '', ''],
		['carddue_plaid_items', 'p', 'id', '', '', '', '', '', ''],
		['carddue_plaid_items', 'u', 'item_ref', '', '', '', '', '', ''],
		[
			'carddue_plaid_items',
			'c',
			'status',
			'',
			'',
			'',
			'',
			'',
			"checkstatus=anyarray['healthy','needs_update']"
		],
		['carddue_cards', 'p', 'id', '', '', '', '', '', ''],
		['carddue_cards', 'u', 'plaid_item_id,external_account_ref', '', '', '', '', '', ''],
		['carddue_cards', 'f', 'plaid_item_id', 'carddue_plaid_items', 'id', 'a', 'c', 's', ''],
		['carddue_cards', 'c', 'source', '', '', '', '', '', "checksource=anyarray['manual','plaid']"],
		[
			'carddue_cards',
			'c',
			'source,plaid_item_id,external_account_ref',
			'',
			'',
			'',
			'',
			'',
			"checksource='manual'andplaid_item_idisnullandexternal_account_refisnullorsource='plaid'andplaid_item_idisnotnullandexternal_account_refisnotnull"
		],
		['carddue_auth_sessions', 'p', 'token_hash', '', '', '', '', '', ''],
		['carddue_auth_rate_limits', 'p', 'bucket_ref', '', '', '', '', '', '']
	].map(
		([
			table_name,
			constraint_type,
			columns,
			foreign_table,
			foreign_columns,
			update_action,
			delete_action,
			match_type,
			check_expression
		]) =>
			Object.freeze({
				table_name,
				constraint_type,
				columns,
				foreign_table,
				foreign_columns,
				update_action,
				delete_action,
				match_type,
				check_expression,
				validated: true,
				deferrable: false,
				deferred: false,
				no_inherit: false,
				foreign_schema: constraint_type === 'f' ? 'public' : ''
			})
	)
);

const EXPECTED_INDEXES = Object.freeze(
	[
		['carddue_cards', 'carddue_cards_source_idx', 'source'],
		['carddue_cards', 'carddue_cards_plaid_item_idx', 'plaid_item_id'],
		['carddue_auth_sessions', 'carddue_auth_sessions_expiry_idx', 'expires_at'],
		['carddue_auth_rate_limits', 'carddue_auth_rate_limits_updated_idx', 'updated_at']
	].map(([table_name, index_name, columns]) =>
		Object.freeze({
			table_name,
			index_name,
			columns,
			access_method: 'btree',
			unique: false,
			valid: true,
			ready: true,
			has_predicate: false,
			has_expressions: false
		})
	)
);

export const CLOUD_SCHEMA_CATALOG_CONTRACT = Object.freeze({
	relations: EXPECTED_RELATIONS,
	columns: EXPECTED_COLUMNS,
	constraints: EXPECTED_CONSTRAINTS,
	indexes: EXPECTED_INDEXES
});

const RELATION_QUERY = `SELECT relation.relname AS table_name,
       relation.relkind::text AS relation_kind,
	   relation.relpersistence::text AS persistence,
	   relation.relispartition AS is_partition,
	   (
	     SELECT pg_catalog.count(*)::integer
	     FROM pg_catalog.pg_inherits inheritance
	     WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid
	   ) AS inheritance_count,
       relation.relrowsecurity AS row_security,
       relation.relforcerowsecurity AS force_row_security,
       relation.relhasrules AS has_rules,
       (
         SELECT pg_catalog.count(*)::integer
         FROM pg_catalog.pg_trigger trigger
         WHERE trigger.tgrelid = relation.oid AND NOT trigger.tgisinternal
       ) AS user_trigger_count
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
ORDER BY relation.relname`;

const COLUMN_QUERY = `SELECT relation.relname AS table_name,
       attribute.attnum::integer AS ordinal_position,
       attribute.attname AS column_name,
       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
       attribute.attnotnull AS not_null,
       COALESCE(pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid, true), '') AS default_expression
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
LEFT JOIN pg_catalog.pg_attrdef default_value
  ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
WHERE namespace.nspname = 'public'
  AND relation.relname = ANY($1::text[])
  AND attribute.attnum > 0
  AND NOT attribute.attisdropped
ORDER BY relation.relname, attribute.attnum`;

const CONSTRAINT_QUERY = `SELECT relation.relname AS table_name,
       constraint_record.contype::text AS constraint_type,
       COALESCE((
         SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY position.ordinality)
         FROM pg_catalog.unnest(constraint_record.conkey) WITH ORDINALITY AS position(attnum, ordinality)
         JOIN pg_catalog.pg_attribute attribute
           ON attribute.attrelid = relation.oid AND attribute.attnum = position.attnum
       ), '') AS columns,
       CASE WHEN constraint_record.contype = 'f' THEN foreign_relation.relname ELSE '' END AS foreign_table,
	   CASE WHEN constraint_record.contype = 'f' THEN foreign_namespace.nspname ELSE '' END AS foreign_schema,
       CASE WHEN constraint_record.contype = 'f' THEN COALESCE((
         SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY position.ordinality)
         FROM pg_catalog.unnest(constraint_record.confkey) WITH ORDINALITY AS position(attnum, ordinality)
         JOIN pg_catalog.pg_attribute attribute
           ON attribute.attrelid = foreign_relation.oid AND attribute.attnum = position.attnum
       ), '') ELSE '' END AS foreign_columns,
       CASE WHEN constraint_record.contype = 'f' THEN constraint_record.confupdtype::text ELSE '' END AS update_action,
       CASE WHEN constraint_record.contype = 'f' THEN constraint_record.confdeltype::text ELSE '' END AS delete_action,
       CASE WHEN constraint_record.contype = 'f' THEN constraint_record.confmatchtype::text ELSE '' END AS match_type,
       CASE WHEN constraint_record.contype = 'c'
         THEN pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
         ELSE ''
       END AS check_expression,
       constraint_record.convalidated AS validated,
       constraint_record.condeferrable AS deferrable,
	   constraint_record.condeferred AS deferred,
	   CASE WHEN constraint_record.contype = 'c'
	     THEN constraint_record.connoinherit
	     ELSE false
	   END AS no_inherit
FROM pg_catalog.pg_constraint constraint_record
JOIN pg_catalog.pg_class relation ON relation.oid = constraint_record.conrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
LEFT JOIN pg_catalog.pg_class foreign_relation ON foreign_relation.oid = constraint_record.confrelid
LEFT JOIN pg_catalog.pg_namespace foreign_namespace ON foreign_namespace.oid = foreign_relation.relnamespace
WHERE namespace.nspname = 'public'
  AND relation.relname = ANY($1::text[])
  AND constraint_record.contype IN ('p', 'u', 'f', 'c')
ORDER BY relation.relname, constraint_record.contype, columns`;

const INDEX_QUERY = `SELECT relation.relname AS table_name,
       index_relation.relname AS index_name,
       access_method.amname AS access_method,
       index_record.indisunique AS unique,
       index_record.indisvalid AS valid,
       index_record.indisready AS ready,
       index_record.indpred IS NOT NULL AS has_predicate,
       index_record.indexprs IS NOT NULL AS has_expressions,
       COALESCE((
         SELECT pg_catalog.string_agg(attribute.attname, ',' ORDER BY position.ordinality)
         FROM pg_catalog.unnest(index_record.indkey) WITH ORDINALITY AS position(attnum, ordinality)
         JOIN pg_catalog.pg_attribute attribute
           ON attribute.attrelid = relation.oid AND attribute.attnum = position.attnum
       ), '') AS columns
FROM pg_catalog.pg_index index_record
JOIN pg_catalog.pg_class relation ON relation.oid = index_record.indrelid
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_record.indexrelid
JOIN pg_catalog.pg_am access_method ON access_method.oid = index_relation.relam
LEFT JOIN pg_catalog.pg_constraint constraint_record
  ON constraint_record.conindid = index_record.indexrelid
WHERE namespace.nspname = 'public'
  AND relation.relname = ANY($1::text[])
  AND constraint_record.oid IS NULL
ORDER BY relation.relname, index_relation.relname`;

const PRESENCE_QUERY = `SELECT pg_catalog.count(*)::integer AS relation_count
FROM pg_catalog.pg_class relation
JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])`;

/** @param {unknown} value */
function canonicalDefault(value) {
	return String(value ?? '')
		.toLowerCase()
		.replace(/::(?:pg_catalog\.)?text/g, '')
		.replace(/[()\s]/g, '');
}

/** @param {unknown} value */
function canonicalCheck(value) {
	return canonicalDefault(value);
}

/** @param {CloudCatalogRow} row */
function comparableRelation(row) {
	return {
		table_name: String(row.table_name),
		relation_kind: String(row.relation_kind),
		persistence: String(row.persistence),
		is_partition: Boolean(row.is_partition),
		inheritance_count: Number(row.inheritance_count),
		row_security: Boolean(row.row_security),
		force_row_security: Boolean(row.force_row_security),
		has_rules: Boolean(row.has_rules),
		user_trigger_count: Number(row.user_trigger_count)
	};
}

/** @param {CloudCatalogRow} row */
function comparableColumn(row) {
	return {
		table_name: String(row.table_name),
		ordinal_position: Number(row.ordinal_position),
		column_name: String(row.column_name),
		data_type: String(row.data_type),
		not_null: Boolean(row.not_null),
		default_expression: canonicalDefault(row.default_expression)
	};
}

/** @param {CloudCatalogRow} row */
function comparableConstraint(row) {
	return {
		table_name: String(row.table_name),
		constraint_type: String(row.constraint_type),
		columns: String(row.columns),
		foreign_table: String(row.foreign_table),
		foreign_schema: String(row.foreign_schema),
		foreign_columns: String(row.foreign_columns),
		update_action: String(row.update_action),
		delete_action: String(row.delete_action),
		match_type: String(row.match_type),
		check_expression: canonicalCheck(row.check_expression),
		validated: Boolean(row.validated),
		deferrable: Boolean(row.deferrable),
		deferred: Boolean(row.deferred),
		no_inherit: Boolean(row.no_inherit)
	};
}

/** @param {CloudCatalogRow} row */
function comparableIndex(row) {
	return {
		table_name: String(row.table_name),
		index_name: String(row.index_name),
		columns: String(row.columns),
		access_method: String(row.access_method),
		unique: Boolean(row.unique),
		valid: Boolean(row.valid),
		ready: Boolean(row.ready),
		has_predicate: Boolean(row.has_predicate),
		has_expressions: Boolean(row.has_expressions)
	};
}

/**
 * @param {readonly CloudCatalogRow[]} actual
 * @param {readonly CloudCatalogRow[]} expected
 * @param {(row: CloudCatalogRow) => unknown} comparable
 */
function sameRows(actual, expected, comparable) {
	/** @param {readonly CloudCatalogRow[]} rows */
	const normalize = (rows) =>
		rows
			.map(comparable)
			.map((row) => JSON.stringify(row))
			.sort();
	return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

/** @param {CloudCatalogQuery} query */
export async function cloudSchemaRelationCount(query) {
	const rows = await query(PRESENCE_QUERY, [CLOUD_TABLE_NAMES]);
	return Number(rows[0]?.relation_count ?? 0);
}

/** @param {CloudCatalogQuery} query */
export async function readCloudSchemaCatalog(query) {
	const parameters = [CLOUD_TABLE_NAMES];
	const [relations, columns, constraints, indexes] = await Promise.all([
		query(RELATION_QUERY, parameters),
		query(COLUMN_QUERY, parameters),
		query(CONSTRAINT_QUERY, parameters),
		query(INDEX_QUERY, parameters)
	]);
	return { relations, columns, constraints, indexes };
}

/** @param {CloudCatalogQuery} query */
export async function verifyCloudSchemaCatalog(query) {
	const { relations, columns, constraints, indexes } = await readCloudSchemaCatalog(query);

	const expectedColumns = EXPECTED_COLUMNS.map((row) => ({
		...row,
		default_expression: canonicalDefault(row.default_expression)
	}));
	const expectedConstraints = EXPECTED_CONSTRAINTS.map((row) => ({
		...row,
		check_expression: canonicalCheck(row.check_expression)
	}));
	if (
		!sameRows(relations, EXPECTED_RELATIONS, comparableRelation) ||
		!sameRows(columns, expectedColumns, comparableColumn) ||
		!sameRows(constraints, expectedConstraints, comparableConstraint) ||
		!sameRows(indexes, EXPECTED_INDEXES, comparableIndex)
	) {
		throw new Error('The cloud schema catalog does not match this ChipDue release.');
	}
}
