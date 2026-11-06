import { Table, TableCell, TableHead, TableHeader, TableRow } from '@carbon/react';
import {
  colorStyle,
  type Cell,
  type FormatStyle,
  type PivotKey,
  type PivotResult,
} from '../api/types';

export type PivotDrillKeys = Record<string, PivotKey>;

interface Props {
  pivot: PivotResult;
  /** Makes cells and totals clickable; called with the row/column fields to filter on. */
  onCellDrill?(keys: PivotDrillKeys, label: string): void;
  styles?: (FormatStyle | null)[][];
}

const text = (v: Cell) => (v === null ? '' : typeof v === 'object' ? '[binary]' : String(v));

/**
 * Server-pivoted crosstab: row fields down the side (sticky), one column per
 * distinct column-field value (NULL gets its own "(null)" column), a Total
 * column and a Total row. Values are shown exactly as the server returned them.
 */
export function PivotTable({ pivot, onCellDrill, styles }: Props) {
  const nRow = pivot.rowFields.length;
  const colName = pivot.columnField.name;
  const rowKeys = (keys: PivotKey[]) =>
    Object.fromEntries(pivot.rowFields.map((f, i) => [f.name, keys[i]])) as PivotDrillKeys;
  const cell = (
    value: Cell,
    keys: PivotDrillKeys | null,
    label: string,
    total = false,
    key?: string,
    style?: FormatStyle | null,
  ) => (
    <TableCell
      key={key}
      className={`qf-num${total ? ' qf-pivot-total' : ''}`}
      style={style ? colorStyle(style.color) : undefined}
    >
      {keys && onCellDrill ? (
        <button
          type="button"
          className="qf-pivot-cell"
          title={`Show the rows behind ${label}`}
          aria-label={`${text(value) || 'empty'}: show the rows behind ${label}`}
          onClick={() => onCellDrill(keys, label)}
        >
          {text(value) || <span className="qf-null">(empty)</span>}
        </button>
      ) : (
        text(value)
      )}
    </TableCell>
  );
  return (
    <div className="qf-pivot-scroll" data-testid="pivot-table">
      <Table size="sm" useZebraStyles aria-label={`Pivot: ${pivot.value.label}`}>
        <TableHead>
          <TableRow>
            {pivot.rowFields.map((f, i) => (
              <TableHeader key={f.name} className={i === 0 ? 'qf-pivot-sticky' : undefined}>
                {f.label}
              </TableHeader>
            ))}
            {pivot.columns.map((c) => (
              <TableHeader key={c.label} className="qf-num">
                {c.value === null ? <span className="qf-null">{c.label}</span> : c.label}
              </TableHeader>
            ))}
            <TableHeader className="qf-num qf-pivot-total">Total</TableHeader>
          </TableRow>
        </TableHead>
        <tbody>
          {pivot.rows.map((r) => {
            const rk = rowKeys(r.keys);
            const rowLabel = r.labels.join(' / ');
            return (
              <TableRow key={r.labels.join('\u0001') + r.keys.map(String).join('\u0001')}>
                {r.labels.map((l, i) => (
                  <TableCell
                    key={i}
                    className={i === 0 ? 'qf-pivot-sticky' : undefined}
                    style={
                      styles?.[pivot.rows.indexOf(r)]?.[i]
                        ? colorStyle(styles[pivot.rows.indexOf(r)][i]!.color)
                        : undefined
                    }
                  >
                    {r.keys[i] === null ? <span className="qf-null">{l}</span> : l}
                  </TableCell>
                ))}
                {pivot.columns.map((c, ci) =>
                  cell(
                    r.cells[ci],
                    r.present[ci] ? { ...rk, [colName]: c.value } : null,
                    `${rowLabel}, ${c.label}`,
                    false,
                    `c${ci}`,
                    styles?.[pivot.rows.indexOf(r)]?.[nRow + ci],
                  ),
                )}
                {cell(
                  r.total,
                  rk,
                  `${rowLabel} (all ${pivot.columnField.label})`,
                  true,
                  'total',
                  styles?.[pivot.rows.indexOf(r)]?.[nRow + pivot.columns.length],
                )}
              </TableRow>
            );
          })}
          <TableRow className="qf-pivot-total-row">
            <TableCell className="qf-pivot-sticky qf-pivot-total">Total</TableCell>
            {pivot.rowFields.slice(1).map((f) => (
              <TableCell key={f.name} className="qf-pivot-total" />
            ))}
            {pivot.columns.map((c, ci) =>
              cell(
                pivot.columnTotals[ci],
                { [colName]: c.value },
                `${c.label} (all rows)`,
                true,
                `t${ci}`,
                styles?.[pivot.rows.length]?.[nRow + ci],
              ),
            )}
            {cell(
              pivot.grandTotal,
              {},
              'the grand total',
              true,
              'grand',
              styles?.[pivot.rows.length]?.[nRow + pivot.columns.length],
            )}
          </TableRow>
        </tbody>
      </Table>
      {nRow > 0 && (
        <p className="qf-pivot-meta" role="status">
          {pivot.rows.length.toLocaleString()} row(s) × {pivot.columns.length} column(s) from{' '}
          {pivot.groupCount.toLocaleString()} group(s). {pivot.value.label}.
          {!pivot.exact && ' Some totals use floating-point arithmetic.'}
        </p>
      )}
    </div>
  );
}
