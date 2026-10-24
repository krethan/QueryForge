import type { ColumnMetaData, DaemonServer, JDBCOptions, QueryResult } from '@ibm/mapepire-js';
import type { JobFactory, QueryLike, SqlJobLike } from '../../src/db/types.js';

export interface Scripted {
  columns: Partial<ColumnMetaData>[];
  rows: unknown[][];
  /** delay before each response in ms */
  delayMs?: number;
  error?: { message: string; sqlState?: string; sqlCode?: number };
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

export class FakeJob implements SqlJobLike {
  connectedWith?: DaemonServer;
  closed = false;
  queries: string[] = [];
  fetchSizes: number[] = [];
  constructor(
    public options: JDBCOptions,
    private script: (sql: string) => Scripted,
  ) {}
  async connect(server: DaemonServer) {
    this.connectedWith = server;
    const s = this.script('__connect__');
    if (s.connectError) throw new Error(s.connectError);
    return { job: 'QZDASOINIT/QUSER/123456', success: true };
  }
  query<T>(sql: string): QueryLike<T> {
    this.queries.push(sql);
    const s = this.script(sql);
    let pos = 0;
    const page = async (n: number): Promise<QueryResult<T>> => {
      if (this.closed) throw new Error('websocket closed');
      if (s.delayMs) await sleep(s.delayMs);
      if (this.closed) throw new Error('websocket closed');
      if (s.error)
        throw new Error(
          [s.error.message, s.error.sqlState, s.error.sqlCode]
            .filter((x) => x !== undefined)
            .join(', '),
        );
      this.fetchSizes.push(n);
      const data = s.rows.slice(pos, pos + n);
      pos += data.length;
      return {
        id: 'q',
        success: true,
        sql_rc: 0,
        sql_state: '00000',
        execution_time: 1,
        metadata: { column_count: s.columns.length, columns: s.columns as ColumnMetaData[] },
        is_done: pos >= s.rows.length,
        has_results: true,
        update_count: -1,
        data: data as T[],
      };
    };
    return {
      execute: (n = 100) => page(n),
      fetchMore: (n = 100) => page(n),
      close: async () => ({}),
    };
  }
  async execute<T>(sql: string) {
    return this.query<T>(sql).execute();
  }
  async close() {
    this.closed = true;
  }
}

export function fakeFactory(script: (sql: string) => Scripted) {
  const jobs: FakeJob[] = [];
  const factory: JobFactory = (opts) => {
    const j = new FakeJob(opts, script);
    jobs.push(j);
    return j;
  };
  return { factory, jobs };
}
