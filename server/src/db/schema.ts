/** Metadata object names (unqualified, upper case). The schema comes from META_SCHEMA. */
export const T = {
  version: 'QF_SCHEMA_VERSION',
  users: 'QF_USERS',
  reports: 'QF_REPORTS',
  executions: 'QF_EXECUTIONS',
} as const;

/** Unqualified metadata object names that reporting SQL may never mention. */
export const PROTECTED_METADATA_OBJECTS = Object.values(T);

/** Current UTC timestamp expression for Db2 for i. */
export const NOW_UTC = '(CURRENT TIMESTAMP - CURRENT TIMEZONE)';

/** Qualified name; schema is validated as a plain identifier by config. */
export const q = (schema: string, table: string) => `${schema}.${table}`;
