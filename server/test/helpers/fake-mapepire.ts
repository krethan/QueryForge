import type { ColumnMetaData, DaemonServer, JDBCOptions, QueryResult } from '@ibm/mapepire-js';
import type { JobFactory, QueryLike, SqlJobLike } from '../../src/db/types.js';

export interface Scripted {
  columns: Partial<ColumnMetaData>[];
  rows: unknown[][];
  /** delay before each response in ms */
  delayMs?: number;
  error?: { message: string; sqlState?: string; sqlCode?: number };
  /** Fail the Nth fetch of this statement (0 = execute, 1 = first fetchMore, ...). */
  failOnFetch?: { index: number; message: string };
  connectError?: string;
}

export const col = (
  name: string,
  type: string,
  precision = 10,
  scale = 0,
  nullable = 1,
): Partial<ColumnMetaData> => ({
  name,
  label: name,
  type,
  precision,
  scale,
  nullable,
  display_size: precision,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** @ibm/mapepire-js 1.0.2: Query's default rowsToFetch, used by SQLJob.execute(). */
export const MAPEPIRE_DEFAULT_ROWS = 100;

type QueryState = 'NOT_YET_RUN' | 'RUN_MORE_DATA_AVAILABLE' | 'RUN_DONE' | 'ERROR';

/** One statement run through FakeJob.query(), with the cursor bookkeeping tests assert on. */
export interface FakeQueryRecord {
  sql: string;
  state: QueryState;
  /** Calls to Query.close(). */
  closeCalls: number;
  /** close() calls that would send `sqlclose` to the server (an open server-side cursor). */
  serverCloses: number;
}

/**
 * Emulates @ibm/mapepire-js 1.0.2 + mapepire-server paging closely enough to catch truncation:
 * - Query.execute()/fetchMore() default to 100 rows, and SQLJob.execute() is query().execute()
 *   followed by close(), so it returns at most 100 rows.
 * - `is_done` is only true once a fetch returns fewer rows than requested (the server stops
 *   when ResultSet.next() is false), so a block of exactly N rows reports more data available.
 * - fetchMore() after the statement is fully run throws, like the real Query.
 */
export class FakeJob implements SqlJobLike {
  connectedWith?: DaemonServer;
  closed = false;
  queries: string[] = [];
  /** QueryOptions passed alongside each query (parameters are bound, never inlined). */
  queryOptions: ({ isTerseResults?: boolean; parameters?: unknown[] } | undefined)[] = [];
  fetchSizes: number[] = [];
  readonly runs: FakeQueryRecord[] = [];
  constructor(
    public options: JDBCOptions,
    /** Second argument is the bound parameters, for scripts that care (the demo catalog does). */
    private script: (sql: string, parameters?: unknown[]) => Scripted,
  ) {}
  /** Statements whose server-side cursor is still open (read partially and never closed). */
  openCursors(): FakeQueryRecord[] {
    return this.runs.filter((r) => r.state === 'RUN_MORE_DATA_AVAILABLE');
  }
  async connect(server: DaemonServer) {
    this.connectedWith = server;
    const s = this.script('__connect__');
    if (s.connectError) throw new Error(s.connectError);
    return { job: 'QZDASOINIT/QUSER/123456', success: true };
  }
  query<T>(sql: string, opts?: { isTerseResults?: boolean; parameters?: unknown[] }): QueryLike<T> {
    this.queries.push(sql);
    this.queryOptions.push(opts);
    const s = this.script(sql, opts?.parameters);
    const rec: FakeQueryRecord = { sql, state: 'NOT_YET_RUN', closeCalls: 0, serverCloses: 0 };
    this.runs.push(rec);
    let pos = 0;
    let fetches = 0;
    let opened = false;
    const page = async (n: number): Promise<QueryResult<T>> => {
      if (typeof n !== 'number' || n <= 0) throw new Error('rowsToFetch must be greater than 0');
      const index = fetches++;
      try {
        if (this.closed) throw new Error('websocket closed');
        if (s.delayMs) await sleep(s.delayMs);
        if (this.closed) throw new Error('websocket closed');
        if (s.error)
          throw new Error(
            [s.error.message, s.error.sqlState, s.error.sqlCode]
              .filter((x) => x !== undefined)
              .join(', '),
          );
        if (s.failOnFetch && s.failOnFetch.index === index) throw new Error(s.failOnFetch.message);
      } catch (e) {
        rec.state = 'ERROR';
        throw e;
      }
      opened = true;
      this.fetchSizes.push(n);
      const data = s.rows.slice(pos, pos + n);
      pos += data.length;
      const isDone = data.length < n;
      rec.state = isDone ? 'RUN_DONE' : 'RUN_MORE_DATA_AVAILABLE';
      return {
        id: 'q',
        success: true,
        sql_rc: 0,
        sql_state: '00000',
        execution_time: 1,
        metadata: { column_count: s.columns.length, columns: s.columns as ColumnMetaData[] },
        is_done: isDone,
        has_results: true,
        update_count: -1,
        data: data as T[],
      };
    };
    return {
      execute: (n = MAPEPIRE_DEFAULT_ROWS) => {
        if (rec.state === 'RUN_MORE_DATA_AVAILABLE')
          return Promise.reject(new Error('Statement has already been run'));
        if (rec.state === 'RUN_DONE')
          return Promise.reject(new Error('Statement has already been fully run'));
        return page(n);
      },
      fetchMore: (n = MAPEPIRE_DEFAULT_ROWS) => {
        if (rec.state === 'NOT_YET_RUN')
          return Promise.reject(new Error('Statement has not yet been run'));
        if (rec.state === 'RUN_DONE')
          return Promise.reject(new Error('Statement has already been fully run'));
        return page(n);
      },
      close: async () => {
        rec.closeCalls++;
        if (opened && rec.state !== 'RUN_DONE') rec.serverCloses++;
        rec.state = 'RUN_DONE';
        return {};
      },
    };
  }
  /** SQLJob.execute(): one default-size block (100 rows), then close. */
  async execute<T>(sql: string, opts?: { isTerseResults?: boolean; parameters?: unknown[] }) {
    const q = this.query<T>(sql, opts);
    const res = await q.execute();
    await q.close();
    return res;
  }
  async close() {
    this.closed = true;
  }
}

export function fakeFactory(script: (sql: string, parameters?: unknown[]) => Scripted) {
  const jobs: FakeJob[] = [];
  const factory: JobFactory = (opts) => {
    const j = new FakeJob(opts, script);
    jobs.push(j);
    return j;
  };
  return { factory, jobs };
}
