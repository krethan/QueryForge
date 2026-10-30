import {
  Button,
  InlineNotification,
  Pagination,
  Table,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
} from '@carbon/react';
import { WarningAlt } from '@carbon/icons-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import type { Cell, RunResponse } from '../api/types';
import {
  NUMERIC_KINDS,
  cellText,
  compareCells,
  formatDateTime,
  formatDuration,
} from '../utils/format';

type Dir = 'NONE' | 'ASC' | 'DESC';
const PAGE_SIZES = [25, 50, 100, 250];

interface Props {
  result: RunResponse;
  toolbar?: ReactNode;
  /** Called with every loaded row (first page plus "Load next" pages) — used by charts. */
  onRowsChange?(rows: Cell[][], hasMore: boolean): void;
}

interface Loaded {
  executionId: string;
  rows: Cell[][];
  hasMore: boolean;
  truncated: boolean;
  cursorId?: string;
  expired: boolean;
  error?: string;
}

const initial = (r: RunResponse): Loaded => ({
  executionId: r.executionId,
  rows: r.rows,
  hasMore: !!r.hasMore && !!r.cursor,
  truncated: r.truncated,
  cursorId: r.cursor?.id,
  expired: false,
});

/**
 * Interactive results grid: client-side sort / filter / pagination over the
 * rows loaded so far. The server returns the first page and, when more rows
 * exist, a short-lived cursor; "Load next" appends the next page (bounded by
 * MAX_RESULT_ROWS). NULL is rendered as a distinct, styled marker so it never
 * looks like an empty string.
 */
export function ResultsTable({ result, toolbar, onRowsChange }: Props) {
  const { columns } = result;
  const [loaded, setLoaded] = useState<Loaded>(() => initial(result));
  const [loading, setLoading] = useState(false);
  // a new result replaces the loaded rows (derived-state reset during render)
  const current = loaded.executionId === result.executionId ? loaded : initial(result);
  if (current !== loaded) setLoaded(current);
  const rows = current.rows;
  const notify = useRef(onRowsChange);
  notify.current = onRowsChange;
  useEffect(() => {
    notify.current?.(current.rows, current.hasMore);
  }, [current.rows, current.hasMore]);

  // release an abandoned server cursor when the result is replaced or the grid unmounts
  const open = useRef<string | undefined>(undefined);
  open.current = current.hasMore ? current.cursorId : undefined;
  useEffect(() => {
    return () => {
      if (open.current) void api.closeCursor(open.current);
    };
  }, [result.executionId]);

  const loadMore = async () => {
    if (!current.cursorId || loading) return;
    setLoading(true);
    try {
      const p = await api.nextPage(current.cursorId);
      setLoaded((l) =>
        l.executionId !== result.executionId
          ? l
          : {
              ...l,
              rows: [...l.rows, ...p.rows],
              hasMore: p.hasMore,
              truncated: p.truncated,
              error: undefined,
            },
      );
    } catch (e) {
      const expired = e instanceof ApiError && e.status === 410;
      setLoaded((l) => ({
        ...l,
        hasMore: expired ? false : l.hasMore,
        expired,
        error: expired ? undefined : (e as Error).message,
      }));
    } finally {
      setLoading(false);
    }
  };
  const [sort, setSort] = useState<{ idx: number; dir: Dir }>({ idx: -1, dir: 'NONE' });
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const indexed = rows.map((r, i) => ({ r, i }));
    if (!f) return indexed;
    return indexed.filter(({ r }) =>
      r.some((v, ci) => v !== null && cellText(v, columns[ci]).toLowerCase().includes(f)),
    );
  }, [rows, columns, filter]);

  const sorted = useMemo(() => {
    if (sort.idx < 0 || sort.dir === 'NONE') return filtered;
    const col = columns[sort.idx];
    const m = sort.dir === 'ASC' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // keep NULLs last in both directions
      if (a.r[sort.idx] === null || b.r[sort.idx] === null)
        return compareCells(a.r[sort.idx], b.r[sort.idx], col);
      return m * compareCells(a.r[sort.idx], b.r[sort.idx], col) || a.i - b.i;
    });
  }, [filtered, sort, columns]);

  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const cycle = (idx: number) =>
    setSort((s) =>
      s.idx !== idx
        ? { idx, dir: 'ASC' }
        : { idx, dir: s.dir === 'ASC' ? 'DESC' : s.dir === 'DESC' ? 'NONE' : 'ASC' },
    );

  const renderCell = (v: Cell, ci: number) => {
    const col = columns[ci];
    if (v === null)
      return (
        <span className="qf-null" title="NULL">
          NULL
        </span>
      );
    return cellText(v, col);
  };

  return (
    <div>
      <div className="qf-results-meta" aria-live="polite">
        <span>
          <strong>{rows.length.toLocaleString()}</strong> {rows.length === 1 ? 'row' : 'rows'}
          {current.hasMore ? ' loaded · more available' : ''}
        </span>
        <span>{columns.length} columns</span>
        <span>Duration: {formatDuration(result.durationMs)}</span>
        <span>Executed: {formatDateTime(result.completedAt)}</span>
        <span>Source: {result.dataSource}</span>
      </div>
      {current.truncated && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Results limited."
          subtitle={
            result.pagingUnavailable && rows.length < result.maxRows
              ? `More rows exist, but the server has too many open result cursors right now, so only the first ${rows.length.toLocaleString()} rows are shown. Run the query again later or export to Excel for the full result.`
              : `Only the first ${result.maxRows.toLocaleString()} rows are shown. Refine the query or export to Excel for a larger result set.`
          }
        />
      )}
      {current.expired && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Result cursor expired."
          subtitle="The server released this result after a period of inactivity. Run the query again to load more rows."
        />
      )}
      {current.error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Could not load more rows."
          subtitle={current.error}
        />
      )}
      <TableContainer title={undefined}>
        <TableToolbar aria-label="Results toolbar">
          <TableToolbarContent>
            <TableToolbarSearch
              persistent
              placeholder="Filter displayed rows"
              onChange={(e: unknown) => {
                const t = (e as { target?: { value?: string } })?.target?.value ?? '';
                setFilter(t);
                setPage(1);
              }}
            />
            {toolbar}
          </TableToolbarContent>
        </TableToolbar>
        {columns.length === 0 || rows.length === 0 ? (
          <div className="qf-empty" role="status">
            <h2>No rows returned</h2>
            <p>The query ran successfully but returned an empty result set.</p>
          </div>
        ) : (
          <div className="qf-table-scroll">
            <Table size="sm" useZebraStyles aria-label="Query results">
              <TableHead>
                <TableRow>
                  {columns.map((c, i) => (
                    <TableHeader
                      key={c.key}
                      isSortable
                      isSortHeader={sort.idx === i}
                      sortDirection={sort.idx === i ? sort.dir : 'NONE'}
                      onClick={() => cycle(i)}
                      title={`${c.name} · ${c.type}${c.precision ? `(${c.precision}${c.scale ? `,${c.scale}` : ''})` : ''}${c.nullable ? ' · nullable' : ''}`}
                    >
                      {c.label}
                      {c.precisionAtRisk && (
                        <span
                          className="qf-precision-risk"
                          role="img"
                          aria-label="Precision may be reduced"
                          title="This server runtime cannot guarantee exact digits for this column (run the server on Node.js 22 or later). Export to Excel keeps values as received."
                        >
                          <WarningAlt size={14} />
                        </span>
                      )}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <tbody aria-live="polite">
                {pageRows.map(({ r, i }) => (
                  <TableRow key={i}>
                    {r.map((v, ci) => (
                      <TableCell
                        key={columns[ci].key}
                        className={NUMERIC_KINDS.has(columns[ci].kind) ? 'qf-num' : undefined}
                      >
                        {renderCell(v, ci)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {current.hasMore && (
          <div className="qf-more-rows" role="status">
            <span>More rows are available on the server.</span>
            <Button size="sm" kind="tertiary" disabled={loading} onClick={() => void loadMore()}>
              {loading
                ? 'Loading…'
                : `Load next ${(result.cursor?.pageSize ?? 0).toLocaleString()} rows`}
            </Button>
          </div>
        )}
        {rows.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            pageSizes={PAGE_SIZES}
            totalItems={sorted.length}
            onChange={({ page: p, pageSize: s }: { page: number; pageSize: number }) => {
              setPage(p);
              setPageSize(s);
            }}
          />
        )}
      </TableContainer>
    </div>
  );
}
