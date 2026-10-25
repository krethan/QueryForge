import type {
  ColumnMetaData,
  DaemonServer,
  JDBCOptions,
  QueryOptions,
  QueryResult,
} from '@ibm/mapepire-js';

/**
 * Minimal structural view of the @ibm/mapepire-js SQLJob / Query API (v1.0.2)
 * that QueryForge relies on. Keeping it structural lets unit tests inject fakes
 * without touching a real IBM i system.
 */
export interface QueryLike<T = unknown> {
  execute(rowsToFetch?: number): Promise<QueryResult<T>>;
  fetchMore(rowsToFetch?: number): Promise<QueryResult<T>>;
  close(): Promise<unknown>;
}

export interface SqlJobLike {
  connect(server: DaemonServer, application?: string): Promise<unknown>;
  query<T>(sql: string, opts?: QueryOptions): QueryLike<T>;
  execute<T>(sql: string, opts?: QueryOptions): Promise<QueryResult<T>>;
  endTransaction?(type: 'COMMIT' | 'ROLLBACK'): Promise<unknown>;
  close(): Promise<void>;
}

export type JobFactory = (options: JDBCOptions) => SqlJobLike;

export type { ColumnMetaData, DaemonServer, JDBCOptions, QueryResult };

/** Parameterised statement executor used by the metadata repositories. */
export interface MetadataDb {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: (string | number | null)[],
  ): Promise<T[]>;
  /** Returns the update count. */
  update(sql: string, params?: (string | number | null)[]): Promise<number>;
  transaction<R>(fn: (tx: Omit<MetadataDb, 'transaction'>) => Promise<R>): Promise<R>;
  ping(): Promise<void>;
  close(): Promise<void>;
}
