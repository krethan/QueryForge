import {
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
import { useMemo, useState, type ReactNode } from 'react';
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
}

/**
 * Interactive results grid: client-side sort / filter / pagination over the
 * rows returned by the server (which are capped at MAX_RESULT_ROWS). NULL is
 * rendered as a distinct, styled marker so it never looks like an empty string.
 */
export function ResultsTable({ result, toolbar }: Props) {
  const { columns, rows } = result;
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
          <strong>{result.rowCount.toLocaleString()}</strong>{' '}
          {result.rowCount === 1 ? 'row' : 'rows'}
        </span>
        <span>{columns.length} columns</span>
        <span>Duration: {formatDuration(result.durationMs)}</span>
        <span>Executed: {formatDateTime(result.completedAt)}</span>
        <span>Source: {result.dataSource}</span>
      </div>
      {result.truncated && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Results limited."
          subtitle={`Only the first ${result.maxRows.toLocaleString()} rows are shown. Refine the query or export to Excel for a larger result set.`}
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
