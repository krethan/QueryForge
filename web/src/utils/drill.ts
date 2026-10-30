import type { Cell, DrillInfo, DrillKeys, DrillValue, ResultColumn } from '../api/types';
import type { ChartDef } from './chartData';

/** How a report drills: its configured target wins over automatic builder detail rows. */
export function drillMode(info: DrillInfo | undefined | null): 'target' | 'builder' | null {
  if (info?.target) return 'target';
  if (info?.builder) return 'builder';
  return null;
}

/** Result columns the user can drill on for this report (null when drill is unavailable). */
export function drillFields(info: DrillInfo | undefined | null): string[] | null {
  const mode = drillMode(info);
  if (mode === 'target') return info!.target!.fields;
  if (mode === 'builder') return info!.builder!.fields;
  return null;
}

/** A cell as a drill value (binary and boolean cells cannot be drilled on). */
export function drillValue(v: Cell): DrillValue | undefined {
  if (v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  return undefined;
}

const colIndex = (columns: { name: string }[], name: string) => {
  const i = columns.findIndex((c) => c.name === name);
  return i >= 0 ? i : columns.findIndex((c) => c.name.toUpperCase() === name.toUpperCase());
};

/** Keys for a clicked grouped table row: the value of each drill field in that row. */
export function keysForRow(
  fields: string[],
  columns: ResultColumn[],
  row: Cell[],
): DrillKeys | null {
  const keys: DrillKeys = {};
  for (const f of fields) {
    const i = colIndex(columns, f);
    if (i < 0) continue;
    const v = drillValue(row[i]);
    if (v === undefined) return null;
    keys[columns[i].name] = v;
  }
  return Object.keys(keys).length ? keys : null;
}

// must match chartData's category label
const chartLabel = (v: Cell) =>
  v === null || v === undefined ? '(null)' : typeof v === 'object' ? '[binary]' : String(v);

/**
 * Keys for a clicked chart element. The chart only knows the labels it drew, so they
 * are mapped back to the raw values of the X (and series) fields in the loaded rows.
 */
export function keysForPoint(
  def: ChartDef,
  fields: string[],
  columns: { name: string }[],
  rows: Cell[][],
  point: { key: string; group?: string },
): DrillKeys | null {
  const xi = colIndex(columns, def.x);
  const si = def.series ? colIndex(columns, def.series) : -1;
  if (xi < 0) return null;
  const allowed = new Set(fields.map((f) => f.toUpperCase()));
  const row = rows.find(
    (r) =>
      chartLabel(r[xi]) === point.key &&
      (si < 0 || point.group === undefined || chartLabel(r[si]) === point.group),
  );
  if (!row) return null;
  const keys: DrillKeys = {};
  for (const i of si >= 0 ? [xi, si] : [xi]) {
    if (!allowed.has(columns[i].name.toUpperCase())) continue;
    const v = drillValue(row[i]);
    if (v === undefined) return null;
    keys[columns[i].name] = v;
  }
  return Object.keys(keys).length ? keys : null;
}

/** ?drill= query value for opening a report with a drill applied. */
export const encodeDrill = (keys: DrillKeys) => JSON.stringify(keys);
export function decodeDrill(s: string | null): DrillKeys | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: DrillKeys = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x === null || typeof x === 'string' || typeof x === 'number') out[k] = x;
      else return null;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}
