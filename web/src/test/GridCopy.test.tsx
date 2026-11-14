import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsTable } from '../components/ResultsTable';
import type { ResultColumn, RunResponse } from '../api/types';
import {
  COPY_MAX_CELLS,
  COPY_MAX_CHARS,
  buildCopy,
  copyValue,
  tsvField,
  writeClipboard,
} from '../utils/gridCopy';

const col = (
  key: string,
  kind: ResultColumn['kind'],
  extra: Partial<ResultColumn> = {},
): ResultColumn => ({
  key,
  name: key.toUpperCase(),
  label: key.toUpperCase(),
  type: kind.toUpperCase(),
  kind,
  precision: 31,
  scale: 2,
  nullable: true,
  ...extra,
});

describe('copy value conversion (same rules as the XLSX export)', () => {
  it('escapes tabs, line breaks and quotes for tab-separated text', () => {
    expect(tsvField('plain')).toBe('plain');
    expect(tsvField('a\tb')).toBe('"a\tb"');
    expect(tsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(tsvField('cr\rhere')).toBe('"cr\rhere"');
    expect(tsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('writes NULL as an empty cell and booleans as TRUE/FALSE', () => {
    expect(copyValue(null, col('t', 'text'))).toEqual({ text: '', asText: false });
    expect(copyValue(true, col('b', 'boolean')).text).toBe('TRUE');
    expect(copyValue(false, col('b', 'boolean')).text).toBe('FALSE');
  });

  it('keeps exact decimals, and marks values Excel cannot hold as text', () => {
    expect(copyValue('10.50', col('d', 'decimal'))).toEqual({ text: '10.50', asText: false });
    expect(copyValue('-3', col('d', 'decimal'))).toEqual({ text: '-3', asText: false });
    expect(copyValue('12345678901234567.89', col('d', 'decimal'))).toEqual({
      text: '12345678901234567.89',
      asText: true,
    });
    expect(copyValue('9007199254740993', col('i', 'integer'))).toEqual({
      text: '9007199254740993',
      asText: true,
    });
    expect(copyValue(42, col('i', 'integer'))).toEqual({ text: '42', asText: false });
    expect(copyValue(1.25, col('f', 'float'))).toEqual({ text: '1.25', asText: false });
  });

  it('writes dates and Db2 timestamps as ISO text with milliseconds', () => {
    expect(copyValue('2026-10-23', col('d', 'date')).text).toBe('2026-10-23');
    expect(copyValue('2026-10-23-14.05.09.123456', col('t', 'timestamp')).text).toBe(
      '2026-10-23 14:05:09.123',
    );
    expect(copyValue('2026-10-23 14:05:09', col('t', 'timestamp')).text).toBe(
      '2026-10-23 14:05:09.000',
    );
    expect(copyValue('2026-02-30', col('d', 'date'))).toEqual({
      text: '2026-02-30',
      asText: true,
    });
  });

  it('neutralises text that a spreadsheet would read as a formula', () => {
    expect(copyValue('=HYPERLINK("x")', col('t', 'text')).text).toBe(`'=HYPERLINK("x")`);
    expect(copyValue('+1', col('t', 'text')).text).toBe("'+1");
    expect(copyValue('-5', col('t', 'text')).text).toBe("'-5");
    expect(copyValue('@SUM', col('t', 'text')).text).toBe("'@SUM");
    expect(copyValue('00123', col('t', 'text'))).toEqual({ text: '00123', asText: true });
    expect(copyValue({ $binary: true, size: 16 }, col('b', 'binary')).text).toBe(
      '[binary: 16 bytes]',
    );
  });

  it('builds CRLF rows with an optional header and an HTML table that keeps text as text', () => {
    const cols = [col('id', 'integer'), col('note', 'text')];
    const rows = [
      [1, 'a\tb'],
      [2, null],
      [3, '<x & "y">'],
    ];
    const plain = buildCopy(cols, rows, [0, 1], false);
    expect(plain.ok && plain.text).toBe('1\t"a\tb"\r\n2\t\r\n3\t"<x & ""y"">"');
    const withHeader = buildCopy(cols, rows, [1], true);
    if (!withHeader.ok) throw new Error('expected ok');
    expect(withHeader.text.split('\r\n')[0]).toBe('NOTE');
    expect(withHeader.rows).toBe(3);
    expect(withHeader.columns).toBe(1);
    expect(withHeader.html).toContain('<th');
    expect(withHeader.html).toContain('&lt;x &amp; &quot;y&quot;&gt;');
    expect(withHeader.html).toContain("mso-number-format:'\\@'");
    const lines = buildCopy([col('n', 'text')], [['one\ntwo']], [0], false);
    expect(lines.ok && lines.html).toContain('one<br style="mso-data-placement:same-cell">two');
  });

  it('refuses copies over the cell or size cap', () => {
    const cols = [col('a', 'text'), col('b', 'text')];
    const rows = Array.from({ length: COPY_MAX_CELLS / 2 + 1 }, () => ['x', 'y']);
    const big = buildCopy(cols, rows, [0, 1], false);
    expect(big).toEqual({ ok: false, reason: 'too-many-cells', cells: COPY_MAX_CELLS + 2 });
    const huge = buildCopy([col('a', 'text')], [['x'.repeat(COPY_MAX_CHARS + 1)]], [0], false);
    expect(huge.ok).toBe(false);
    expect(!huge.ok && huge.reason).toBe('too-large');
    expect(buildCopy(cols, [], [0], false)).toEqual({ ok: false, reason: 'empty', cells: 0 });
  });
});

describe('writeClipboard', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('uses writeText when rich clipboard items are unavailable', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await writeClipboard('a\tb', '<table></table>');
    expect(writeText).toHaveBeenCalledWith('a\tb');
  });

  it('falls back to the copy command and reports a refusal', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn((cmd: string) => {
      const ev = new Event('copy') as ClipboardEvent;
      const data: Record<string, string> = {};
      Object.defineProperty(ev, 'clipboardData', {
        value: { setData: (t: string, v: string) => (data[t] = v) },
      });
      document.dispatchEvent(ev);
      exec.data = data;
      return cmd === 'copy';
    }) as ReturnType<typeof vi.fn> & { data?: Record<string, string> };
    document.execCommand = exec as unknown as typeof document.execCommand;
    await writeClipboard('x', '<b>x</b>');
    expect(exec.data).toEqual({ 'text/plain': 'x', 'text/html': '<b>x</b>' });
    document.execCommand = (() => false) as unknown as typeof document.execCommand;
    await expect(writeClipboard('x', 'x')).rejects.toThrow(/did not allow/);
  });
});

const result: RunResponse = {
  executionId: 'grid-1',
  columns: [col('id', 'integer', { scale: 0 }), col('amt', 'decimal'), col('note', 'text')],
  rows: [
    [1, '10.00', 'first'],
    [2, null, 'tab\there'],
    [3, '9.50', '=cmd'],
  ],
  rowCount: 3,
  truncated: false,
  maxRows: 5000,
  startedAt: '2026-11-13T10:00:00.000Z',
  completedAt: '2026-11-13T10:00:01.000Z',
  durationMs: 10,
  dataSource: 'TEST400',
};

const cell = (r: number, c: number) =>
  screen.getByRole('grid').querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`)!;
const selectedCount = () =>
  screen.getByRole('grid').querySelectorAll('[aria-selected="true"]').length;

describe('results grid selection and copy', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let user: ReturnType<typeof userEvent.setup>;
  beforeEach(() => {
    localStorage.clear();
    user = userEvent.setup();
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  it('is an accessible multi-select grid with one tab stop and keyboard help', () => {
    render(<ResultsTable result={result} />);
    const grid = screen.getByRole('grid', { name: 'Query results' });
    expect(grid).toHaveAttribute('aria-multiselectable', 'true');
    expect(grid).toHaveAccessibleDescription(/arrow keys/);
    expect(grid.querySelectorAll('td[tabindex="0"]')).toHaveLength(1);
    expect(cell(0, 0)).toHaveAttribute('tabindex', '0');
    expect(selectedCount()).toBe(0);
  });

  it('selects a range with click and Shift+click, then copies it with Ctrl+C', async () => {
    render(<ResultsTable result={result} />);
    await user.click(cell(0, 1));
    await user.keyboard('{Shift>}');
    await user.click(cell(2, 2));
    await user.keyboard('{/Shift}');
    expect(selectedCount()).toBe(6);
    expect(screen.getByText(/Selected: 3 rows × 2 columns/)).toBeInTheDocument();
    cell(2, 2).focus();
    await user.keyboard('{Control>}c{/Control}');
    expect(writeText).toHaveBeenCalledWith('10.00\tfirst\r\n\t"tab\there"\r\n9.50\t\'=cmd');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Copied 3 rows × 2 columns to the clipboard.',
    );
  });

  it('copies the focused cell when nothing is selected', async () => {
    render(<ResultsTable result={result} />);
    cell(0, 0).focus();
    fireEvent.keyDown(cell(0, 0), { key: 'c', ctrlKey: true });
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('1');
  });

  it('moves and extends the selection with the keyboard', async () => {
    render(<ResultsTable result={result} />);
    await user.click(cell(0, 0));
    await user.keyboard('{ArrowDown}');
    expect(cell(1, 0)).toHaveFocus();
    expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(selectedCount()).toBe(2);
    await user.keyboard('{Shift>} {/Shift}'); // Shift+Space: whole rows
    expect(selectedCount()).toBe(3);
    await user.keyboard('{Control>}a{/Control}');
    expect(selectedCount()).toBe(9);
    await user.keyboard('{Escape}');
    expect(selectedCount()).toBe(0);
  });

  it('copies selected rows, the page or all matching rows from the Copy menu, with headers', async () => {
    render(<ResultsTable result={result} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('menuitem', { name: /Copy selected cells/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Include column headers' }));
    expect(localStorage.getItem('ub.copyHeaders')).toBe('1');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy all loaded rows \(3 rows\)/ }));
    expect(writeText).toHaveBeenLastCalledWith(
      'ID\tAMT\tNOTE\r\n1\t10.00\tfirst\r\n2\t\t"tab\there"\r\n3\t9.50\t\'=cmd',
    );

    await user.type(screen.getByRole('searchbox'), 'first');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy all matching rows \(1 row\)/ }));
    expect(writeText).toHaveBeenLastCalledWith('ID\tAMT\tNOTE\r\n1\t10.00\tfirst');

    await user.clear(screen.getByRole('searchbox'));
    await user.click(cell(1, 2));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy selected rows/ }));
    expect(writeText).toHaveBeenLastCalledWith('ID\tAMT\tNOTE\r\n2\t\t"tab\there"');

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy this page \(3 rows\)/ }));
    expect(writeText).toHaveBeenCalledTimes(3 + 1);
  });

  it('explains when a copy is over the size cap or the browser refuses', async () => {
    const many: RunResponse = {
      ...result,
      executionId: 'grid-big',
      rows: Array.from({ length: Math.ceil(COPY_MAX_CELLS / 3) + 1 }, (_, i) => [i, '1.00', 'x']),
    };
    render(<ResultsTable result={many} />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy all loaded rows/ }));
    expect(writeText).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Too much to copy: that is 100,005 cells and the limit is 100,000\. .*Export to Excel/,
    );

    writeText.mockRejectedValue(new Error('denied'));
    document.execCommand = (() => false) as unknown as typeof document.execCommand;
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await user.click(screen.getByRole('menuitem', { name: /Copy this page/ }));
    expect(await screen.findByText(/Could not copy to the clipboard/)).toBeInTheDocument();
  });

  it('keeps drill-down on a plain click but not after a Shift+click or a drag', () => {
    const onRowClick = vi.fn();
    render(<ResultsTable result={result} onRowClick={onRowClick} />);
    fireEvent.mouseDown(cell(0, 0), { button: 0 });
    fireEvent.click(cell(0, 0));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(cell(1, 1), { button: 0, shiftKey: true });
    fireEvent.click(cell(1, 1));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(cell(2, 0), { button: 0 });
    fireEvent.mouseEnter(cell(2, 1), { buttons: 1 });
    fireEvent.click(cell(2, 1));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(selectedCount()).toBe(2);
  });
});

describe('column resizing', () => {
  it('resizes a column from the keyboard and resets all widths', async () => {
    const user = userEvent.setup();
    const { container } = render(<ResultsTable result={result} />);
    const handle = screen.getByRole('separator', { name: 'Resize column AMT' });
    expect(handle).not.toHaveAttribute('aria-valuenow');
    handle.focus();
    await user.keyboard('{ArrowRight}');
    expect(handle).toHaveAttribute('aria-valuenow', '166');
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}');
    expect(handle).toHaveAttribute('aria-valuenow', '102');
    expect(container.querySelectorAll('colgroup col')).toHaveLength(3);
    expect(within(screen.getByRole('grid')).getAllByRole('columnheader')[1]).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(container.querySelector('colgroup')).toBeNull();
  });

  it('resizes with a pointer drag and does not sort the column', () => {
    // jsdom has no PointerEvent; a MouseEvent subclass carries clientX/button the same way
    const w = window as unknown as { PointerEvent?: typeof MouseEvent };
    w.PointerEvent ??= class extends MouseEvent {};
    const { container } = render(<ResultsTable result={result} />);
    const handle = screen.getByRole('separator', { name: 'Resize column ID' });
    fireEvent.pointerDown(handle, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 140 });
    fireEvent.pointerUp(window);
    expect(handle).toHaveAttribute('aria-valuenow', '190');
    expect(container.querySelector('col')).toHaveStyle({ width: '190px' });
    expect(screen.getAllByRole('columnheader')[0]).toHaveAttribute('aria-sort', 'none');
  });
});
