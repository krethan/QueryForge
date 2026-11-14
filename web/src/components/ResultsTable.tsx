import {
  Button,
  InlineNotification,
  MenuButton,
  MenuItem,
  MenuItemDivider,
  MenuItemSelectable,
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
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { ApiError, api } from '../api/client';
import { colorStyle, type Cell, type FormatStyle, type RunResponse } from '../api/types';
import {
  NUMERIC_KINDS,
  cellText,
  compareCells,
  formatDateTime,
  formatDuration,
} from '../utils/format';
import { COPY_MAX_CELLS, COPY_MAX_CHARS, buildCopy, writeClipboard } from '../utils/gridCopy';

type Dir = 'NONE' | 'ASC' | 'DESC';
const PAGE_SIZES = [25, 50, 100, 250];
const MIN_COL_WIDTH = 48;
const MAX_COL_WIDTH = 1200;
const HEADERS_PREF = 'ub.copyHeaders';

/** A cell position: r is the row's index in the filtered + sorted list (not the page), c the column. */
interface Pos {
  r: number;
  c: number;
}
interface Selection {
  /** Selections are dropped when the result, filter or sort changes. */
  key: string;
  anchor: Pos;
  focus: Pos;
}
type CopyScope = 'cells' | 'rows' | 'page' | 'all';
type CopyNotice = { kind: 'success' | 'warning' | 'error'; text: string } | null;

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
const readHeadersPref = () => {
  try {
    return localStorage.getItem(HEADERS_PREF) === '1';
  } catch {
    return false;
  }
};

interface Props {
  result: RunResponse;
  toolbar?: ReactNode;
  /** Called with every loaded row (first page plus "Load next" pages) — used by charts. */
  onRowsChange?(rows: Cell[][], hasMore: boolean): void;
  /** Makes rows clickable (drill-down); return false for rows that cannot be opened. */
  onRowClick?(row: Cell[]): void;
  rowActionLabel?: string;
}

interface Loaded {
  executionId: string;
  rows: Cell[][];
  formatStyles: (FormatStyle | null)[][];
  hasMore: boolean;
  truncated: boolean;
  cursorId?: string;
  expired: boolean;
  error?: string;
}

const initial = (r: RunResponse): Loaded => ({
  executionId: r.executionId,
  rows: r.rows,
  formatStyles: r.formatStyles ?? [],
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
export function ResultsTable({
  result,
  toolbar,
  onRowsChange,
  onRowClick,
  rowActionLabel = 'Show detail rows',
}: Props) {
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
              formatStyles: [...l.formatStyles, ...(p.formatStyles ?? [])],
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

  // ---- cell selection, copy to clipboard and column widths ----
  const pageStart = (page - 1) * pageSize;
  const selKey = `${result.executionId}|${filter}|${sort.idx}:${sort.dir}`;
  const [selState, setSelState] = useState<Selection | null>(null);
  const selection =
    selState &&
    selState.key === selKey &&
    selState.focus.r < sorted.length &&
    selState.anchor.r < sorted.length
      ? selState
      : null;
  const range = selection
    ? {
        r0: Math.min(selection.anchor.r, selection.focus.r),
        r1: Math.max(selection.anchor.r, selection.focus.r),
        c0: Math.min(selection.anchor.c, selection.focus.c),
        c1: Math.max(selection.anchor.c, selection.focus.c),
      }
    : null;
  const select = (anchor: Pos, focus: Pos) => setSelState({ key: selKey, anchor, focus });
  const inRange = (r: number, c: number) =>
    !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
  // roving tab stop: the selection's focus cell when it is on this page, else the page's first cell
  const active =
    selection && selection.focus.r >= pageStart && selection.focus.r < pageStart + pageRows.length
      ? selection.focus
      : { r: pageStart, c: 0 };

  const gridRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  useEffect(() => {
    if (!pendingFocus.current || !selection) return;
    pendingFocus.current = false;
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-cell="${selection.focus.r}:${selection.focus.c}"]`)
      ?.focus();
  });

  const [withHeaders, setWithHeaders] = useState(readHeadersPref);
  const [notice, setNotice] = useState<CopyNotice>(null);
  const toggleHeaders = (on: boolean) => {
    setWithHeaders(on);
    try {
      localStorage.setItem(HEADERS_PREF, on ? '1' : '0');
    } catch {
      /* private mode: keep the choice for this page only */
    }
  };

  const copy = async (scope: CopyScope, sel = range) => {
    const allCols = columns.map((_, i) => i);
    let src: Cell[][];
    let cols = allCols;
    if (scope === 'page') src = pageRows.map((x) => x.r);
    else if (scope === 'all') src = sorted.map((x) => x.r);
    else {
      if (!sel) {
        setNotice({
          kind: 'warning',
          text: 'Nothing is selected. Click a cell, then Shift+click, drag or use Shift+arrow keys to select more.',
        });
        return;
      }
      src = sorted.slice(sel.r0, sel.r1 + 1).map((x) => x.r);
      if (scope === 'cells') cols = allCols.slice(sel.c0, sel.c1 + 1);
    }
    const built = buildCopy(columns, src, cols, withHeaders);
    if (!built.ok) {
      setNotice(
        built.reason === 'empty'
          ? { kind: 'warning', text: 'There are no rows to copy.' }
          : {
              kind: 'warning',
              text:
                built.reason === 'too-many-cells'
                  ? `Too much to copy: that is ${built.cells.toLocaleString()} cells and the limit is ${COPY_MAX_CELLS.toLocaleString()}. Select fewer rows or columns, or use Export to Excel.`
                  : `Too much to copy: the text is over ${(COPY_MAX_CHARS / 1_000_000).toLocaleString()} million characters. Select fewer rows or columns, or use Export to Excel.`,
            },
      );
      return;
    }
    try {
      await writeClipboard(built.text, built.html);
      setNotice({
        kind: 'success',
        text: `Copied ${built.rows.toLocaleString()} ${built.rows === 1 ? 'row' : 'rows'} × ${built.columns} ${built.columns === 1 ? 'column' : 'columns'}${built.header ? ' with headers' : ''} to the clipboard.`,
      });
    } catch (e) {
      setNotice({
        kind: 'error',
        text: `Could not copy to the clipboard: ${(e as Error).message || 'the browser refused.'}`,
      });
    }
  };

  // mouse: click selects a cell, Shift+click or drag extends; neither then opens a drill-down
  const drag = useRef(false);
  const suppressClick = useRef(false);
  useEffect(() => {
    const up = () => {
      drag.current = false;
    };
    document.addEventListener('mouseup', up);
    return () => document.removeEventListener('mouseup', up);
  }, []);
  const onCellMouseDown = (e: ReactMouseEvent<HTMLElement>, p: Pos) => {
    if (e.button !== 0) return;
    e.preventDefault(); // our selection replaces the browser's text selection
    e.currentTarget.focus();
    if (e.shiftKey && selection) {
      suppressClick.current = true;
      select(selection.anchor, p);
    } else {
      suppressClick.current = false;
      drag.current = true;
      select(p, p);
    }
  };
  const onCellMouseEnter = (e: ReactMouseEvent<HTMLElement>, p: Pos) => {
    if (!drag.current || !selection || (e.buttons & 1) === 0) return;
    if (selection.focus.r === p.r && selection.focus.c === p.c) return;
    suppressClick.current = true;
    select(selection.anchor, p);
  };

  const onCellKeyDown = (e: KeyboardEvent<HTMLElement>, p: Pos) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const lastRow = sorted.length - 1;
    const lastCol = columns.length - 1;
    const cur = selection?.focus ?? p;
    let next: Pos | null = null;
    if (mod && key === 'c' && !e.altKey) {
      const native = window.getSelection?.()?.toString();
      if (native) return; // the user selected text with the mouse: let the browser copy it
      e.preventDefault();
      e.stopPropagation();
      if (range) void copy('cells');
      else {
        select(p, p);
        void copy('cells', { r0: p.r, r1: p.r, c0: p.c, c1: p.c });
      }
      return;
    }
    if (mod && key === 'a') {
      e.preventDefault();
      e.stopPropagation();
      select({ r: 0, c: 0 }, { r: lastRow, c: lastCol });
      return;
    }
    if (key === 'Escape' && selection) {
      e.stopPropagation();
      setSelState(null);
      return;
    }
    if (key === ' ' && e.shiftKey) {
      // Shift+Space: widen the selection to whole rows (as in Excel)
      e.preventDefault();
      e.stopPropagation();
      const a = selection?.anchor ?? p;
      select({ r: a.r, c: 0 }, { r: cur.r, c: lastCol });
      return;
    }
    switch (key) {
      case 'ArrowUp':
        next = { r: Math.max(0, cur.r - 1), c: cur.c };
        break;
      case 'ArrowDown':
        next = { r: Math.min(lastRow, cur.r + 1), c: cur.c };
        break;
      case 'ArrowLeft':
        next = { r: cur.r, c: Math.max(0, cur.c - 1) };
        break;
      case 'ArrowRight':
        next = { r: cur.r, c: Math.min(lastCol, cur.c + 1) };
        break;
      case 'Home':
        next = mod ? { r: 0, c: 0 } : { r: cur.r, c: 0 };
        break;
      case 'End':
        next = mod ? { r: lastRow, c: lastCol } : { r: cur.r, c: lastCol };
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    pendingFocus.current = true;
    select(e.shiftKey && selection ? selection.anchor : e.shiftKey ? cur : next, next);
    const targetPage = Math.floor(next.r / pageSize) + 1;
    if (targetPage !== page) setPage(targetPage);
  };

  // column widths: the first resize fixes every column at its current width
  const [widthState, setWidthState] = useState<{ id: string; w: number[] } | null>(null);
  const widths =
    widthState && widthState.id === result.executionId && widthState.w.length === columns.length
      ? widthState.w
      : null;
  const measured = (): number[] => {
    if (widths) return widths;
    const ths = gridRef.current?.querySelectorAll<HTMLElement>('thead th') ?? [];
    return columns.map((_, i) => Math.round(ths[i]?.getBoundingClientRect().width || 0) || 150);
  };
  const setWidth = (ci: number, w: number, base = measured()) => {
    const next = [...base];
    next[ci] = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.round(w)));
    setWidthState({ id: result.executionId, w: next });
  };
  const onResizePointerDown = (e: ReactPointerEvent<HTMLElement>, ci: number) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    const base = measured();
    const startX = e.clientX;
    const move = (ev: PointerEvent) => setWidth(ci, base[ci] + ev.clientX - startX, base);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onResizeKeyDown = (e: KeyboardEvent<HTMLElement>, ci: number) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const base = measured();
      setWidth(ci, base[ci] + (e.key === 'ArrowRight' ? step : -step), base);
    } else if (e.key === 'Escape' || e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setWidthState(null);
    }
  };

  const modKey = isMac() ? '⌘' : 'Ctrl+';
  const gridHelpId = useId();
  const rowsWord = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'row' : 'rows'}`;

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
      <p id={gridHelpId} className="cds--visually-hidden">
        Use the arrow keys to move between cells and Shift with an arrow key to select a range.
        Shift+Space selects whole rows, {modKey}A selects all rows and {modKey}C copies the
        selection for pasting into Excel. The Copy menu has more options.
      </p>
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
            {rows.length > 0 && columns.length > 0 && (
              <MenuButton
                label="Copy"
                kind="ghost"
                size="lg"
                menuAlignment="bottom-end"
                className="qf-copy-menu"
              >
                <MenuItem
                  label="Copy selected cells"
                  shortcut={`${modKey}C`}
                  disabled={!range}
                  onClick={() => void copy('cells')}
                />
                <MenuItem
                  label="Copy selected rows (all columns)"
                  disabled={!range}
                  onClick={() => void copy('rows')}
                />
                <MenuItem
                  label={`Copy this page (${rowsWord(pageRows.length)})`}
                  onClick={() => void copy('page')}
                />
                <MenuItem
                  label={
                    filter.trim()
                      ? `Copy all matching rows (${rowsWord(sorted.length)})`
                      : `Copy all loaded rows (${rowsWord(sorted.length)})`
                  }
                  onClick={() => void copy('all')}
                />
                <MenuItemDivider />
                <MenuItemSelectable
                  label="Include column headers"
                  selected={withHeaders}
                  onChange={(on: boolean) => toggleHeaders(on)}
                />
              </MenuButton>
            )}
            {toolbar}
          </TableToolbarContent>
        </TableToolbar>
        <div className="qf-grid-status">
          {range && (
            <span className="qf-grid-selection">
              Selected: {rowsWord(range.r1 - range.r0 + 1)} × {range.c1 - range.c0 + 1}{' '}
              {range.c1 === range.c0 ? 'column' : 'columns'}
            </span>
          )}
          <span role="status" aria-live="polite" className="qf-copy-status">
            {notice?.kind === 'success' ? notice.text : ''}
          </span>
        </div>
        {notice && notice.kind !== 'success' && (
          <InlineNotification
            kind={notice.kind}
            role="alert"
            lowContrast
            title={notice.kind === 'error' ? 'Copy failed.' : 'Not copied.'}
            subtitle={notice.text}
            onCloseButtonClick={() => setNotice(null)}
          />
        )}
        {columns.length === 0 || rows.length === 0 ? (
          <div className="qf-empty" role="status">
            <h2>No rows returned</h2>
            <p>The query ran successfully but returned an empty result set.</p>
          </div>
        ) : (
          <div
            className={`qf-table-scroll${widths ? ' qf-grid-fixed' : ''}`}
            ref={gridRef}
            onCopy={(e) => {
              // a native copy (for example from a context menu) while cells are selected
              if (!range || window.getSelection?.()?.toString()) return;
              const built = buildCopy(
                columns,
                sorted.slice(range.r0, range.r1 + 1).map((x) => x.r),
                columns.map((_, i) => i).slice(range.c0, range.c1 + 1),
                withHeaders,
              );
              if (!built.ok) return;
              e.clipboardData.setData('text/plain', built.text);
              e.clipboardData.setData('text/html', built.html);
              e.preventDefault();
            }}
          >
            <Table
              size="sm"
              useZebraStyles
              aria-label="Query results"
              role="grid"
              aria-multiselectable="true"
              aria-describedby={gridHelpId}
              style={
                widths
                  ? { tableLayout: 'fixed', width: widths.reduce((a, b) => a + b, 0) }
                  : undefined
              }
            >
              {widths && (
                <colgroup>
                  {widths.map((w, i) => (
                    <col key={columns[i].key} style={{ width: w }} />
                  ))}
                </colgroup>
              )}
              <TableHead>
                <TableRow>
                  {columns.map((c, i) => (
                    <TableHeader
                      key={c.key}
                      isSortable
                      isSortHeader={sort.idx === i}
                      sortDirection={sort.idx === i ? sort.dir : 'NONE'}
                      onClick={() => cycle(i)}
                      decorator={
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`Resize column ${c.label}`}
                          aria-valuenow={widths?.[i] ?? undefined}
                          aria-valuemin={MIN_COL_WIDTH}
                          aria-valuemax={MAX_COL_WIDTH}
                          tabIndex={0}
                          className="qf-col-resize"
                          title="Drag (or focus and use the arrow keys) to resize. Double-click to reset all widths."
                          onPointerDown={(e) => onResizePointerDown(e, i)}
                          onKeyDown={(e) => onResizeKeyDown(e, i)}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setWidthState(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      }
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
                {pageRows.map(({ r, i }, j) => (
                  <TableRow
                    key={i}
                    {...(onRowClick
                      ? {
                          className: 'qf-row-drill',
                          tabIndex: 0,
                          title: rowActionLabel,
                          'data-testid': 'drill-row',
                          onClick: () => {
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            onRowClick(r);
                          },
                          onKeyDown: (e: KeyboardEvent) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onRowClick(r);
                            }
                          },
                        }
                      : {})}
                  >
                    {r.map((v, ci) => {
                      const p = { r: pageStart + j, c: ci };
                      const selected = inRange(p.r, ci);
                      const isActive = active.r === p.r && active.c === ci;
                      return (
                        <TableCell
                          key={columns[ci].key}
                          data-cell={`${p.r}:${ci}`}
                          tabIndex={isActive ? 0 : -1}
                          aria-selected={selected}
                          onMouseDown={(e: ReactMouseEvent<HTMLElement>) => onCellMouseDown(e, p)}
                          onMouseEnter={(e: ReactMouseEvent<HTMLElement>) => onCellMouseEnter(e, p)}
                          onKeyDown={(e: KeyboardEvent<HTMLElement>) => onCellKeyDown(e, p)}
                          className={
                            [
                              NUMERIC_KINDS.has(columns[ci].kind) ? 'qf-num' : '',
                              selected ? 'qf-cell-selected' : '',
                              selection && isActive ? 'qf-cell-active' : '',
                            ]
                              .filter(Boolean)
                              .join(' ') || undefined
                          }
                          data-format-color={current.formatStyles[i]?.[ci]?.color}
                          style={
                            current.formatStyles[i]?.[ci]
                              ? colorStyle(current.formatStyles[i]?.[ci]!.color)
                              : undefined
                          }
                        >
                          {renderCell(v, ci)}
                        </TableCell>
                      );
                    })}
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
