import { z } from 'zod';
import { tokenize } from '../sql/lexer.js';
import { AppError } from '../util/errors.js';

export const PARAMETER_TYPES = ['string', 'integer', 'decimal', 'date', 'list'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];
/** Value bound to a Mapepire parameter marker (a subset of mapepire-js BindingValue). */
export type BoundValue = string | number | null;

/** Parameters a user can be prompted for. */
export const MAX_PARAMS = 20;
/** All markers, including fixed Report Builder filter values (IN lists can be long). */
export const MAX_TOTAL_PARAMS = 250;
const MAX_STRING = 1000;

export const parameterDefSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]{0,29}$/,
        'Parameter names must start with a letter (letters, digits, _; max 30).',
      ),
    label: z.string().trim().min(1, 'Parameter label is required').max(80),
    type: z.enum(PARAMETER_TYPES),
    required: z.boolean().default(false),
    defaultValue: z
      .string()
      .max(MAX_STRING)
      .nullable()
      .optional()
      .transform((v) => (v === '' ? null : (v ?? null))),
    options: z
      .array(z.object({ value: z.string().min(1).max(256), label: z.string().max(256).optional() }))
      .max(200)
      .optional(),
    /**
     * Fixed value written by the Report Builder for a filter that is not "Ask when run".
     * It is never prompted, its value is always the default, and client values are ignored.
     */
    fixed: z.boolean().optional(),
    /**
     * Report Builder LIKE filter: the value is escaped (\, %, _) and wrapped in % wildcards
     * on the server, for a marker written as `LIKE ? ESCAPE '\'`.
     */
    match: z.enum(['contains', 'startsWith', 'endsWith']).optional(),
  })
  .superRefine((p, ctx) => {
    if (p.fixed && p.defaultValue === null)
      ctx.addIssue({ code: 'custom', message: `Fixed parameter "${p.name}" needs a value.` });
    if (p.type === 'list' && !p.options?.length)
      ctx.addIssue({
        code: 'custom',
        message: `Parameter "${p.name}" needs at least one list value.`,
      });
    if (p.defaultValue !== null) {
      const r = coerce(p as ParameterDef, p.defaultValue);
      if (!r.ok)
        ctx.addIssue({ code: 'custom', message: `Default for "${p.label}": ${r.message}` });
    }
  });
export type ParameterDef = {
  name: string;
  label: string;
  type: ParameterType;
  required: boolean;
  defaultValue: string | null;
  options?: { value: string; label?: string }[];
  fixed?: boolean;
  match?: LikeMatch;
};
export type LikeMatch = 'contains' | 'startsWith' | 'endsWith';

/** Escape LIKE wildcards with `\` (paired with `ESCAPE '\'`) and add the match wildcards. */
export function likePattern(value: string, match: LikeMatch): string {
  const v = value.replace(/[\\%_]/g, (c) => `\\${c}`);
  return match === 'contains' ? `%${v}%` : match === 'startsWith' ? `${v}%` : `%${v}`;
}

export const parameterListSchema = z
  .array(parameterDefSchema)
  .max(MAX_TOTAL_PARAMS, `At most ${MAX_TOTAL_PARAMS} parameter markers are allowed.`)
  .default([])
  .superRefine((list, ctx) => {
    if (list.filter((p) => !p.fixed).length > MAX_PARAMS)
      ctx.addIssue({ code: 'custom', message: `At most ${MAX_PARAMS} parameters are allowed.` });
    const seen = new Set<string>();
    for (const p of list) {
      const k = p.name.toUpperCase();
      if (seen.has(k))
        ctx.addIssue({ code: 'custom', message: `Duplicate parameter name "${p.name}".` });
      seen.add(k);
    }
  });

/** Raw values as sent by the client: keyed by parameter name. */
export const parameterValuesSchema = z
  .record(z.union([z.string().max(MAX_STRING), z.number(), z.null()]))
  .optional()
  .default({});
export type RawValues = z.infer<typeof parameterValuesSchema>;

type Coerced = { ok: true; value: BoundValue } | { ok: false; message: string };

function isRealDate(s: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return (
    d.getUTCFullYear() === +m[1] &&
    d.getUTCMonth() === +m[2] - 1 &&
    d.getUTCDate() === +m[3] &&
    +m[1] >= 1
  );
}

/** Convert one raw value to the value bound to the marker. Never produces SQL text. */
export function coerce(def: ParameterDef, raw: string | number): Coerced {
  const s = String(raw).trim();
  switch (def.type) {
    case 'string':
      return s.length > MAX_STRING
        ? { ok: false, message: 'is too long' }
        : { ok: true, value: String(raw) };
    case 'integer': {
      if (!/^[-+]?\d{1,18}$/.test(s)) return { ok: false, message: 'must be a whole number' };
      const n = Number(s);
      if (!Number.isSafeInteger(n)) return { ok: false, message: 'is out of range' };
      return { ok: true, value: n };
    }
    case 'decimal': {
      if (!/^[-+]?(\d{1,31}(\.\d{0,31})?|\.\d{1,31})$/.test(s))
        return { ok: false, message: 'must be a decimal number' };
      // bound as a string so precision is preserved; Db2 for i converts it to the column's DECIMAL type
      return { ok: true, value: s.replace(/^\+/, '') };
    }
    case 'date':
      return isRealDate(s)
        ? { ok: true, value: s }
        : { ok: false, message: 'must be a date (YYYY-MM-DD)' };
    case 'list':
      return def.options?.some((o) => o.value === String(raw))
        ? { ok: true, value: String(raw) }
        : { ok: false, message: 'must be one of the listed values' };
  }
}

/** Count `?` parameter markers outside strings, comments and delimited identifiers. */
export function countMarkers(sql: string): number {
  try {
    return tokenize(sql).filter((t) => t.type === 'symbol' && t.value === '?').length;
  } catch {
    return 0; // the SQL validator reports lexical errors
  }
}

export interface ResolvedParameters {
  /** Values in marker order, passed to Mapepire as `parameters`. */
  bound: BoundValue[];
  /** Name -> value actually used (for history and the XLSX metadata sheet). */
  used: Record<string, BoundValue>;
}

/**
 * Server-side validation: checks marker count, required values, types and list
 * membership, applying defaults. Throws a 400 AppError listing every problem.
 */
export function resolveParameters(
  sql: string,
  defs: ParameterDef[],
  raw: RawValues = {},
): ResolvedParameters {
  const markers = countMarkers(sql);
  if (markers > 0 && defs.length === 0)
    throw new AppError(
      400,
      'PARAMETERS_NOT_DEFINED',
      `The SQL contains ${markers} parameter marker(s) (?) but no parameters are defined. Add a parameter definition for each ? (in order), or replace the ? with a literal value.`,
    );
  if (markers !== defs.length)
    throw new AppError(
      400,
      'PARAMETER_MISMATCH',
      `The SQL has ${markers} parameter marker(s) (?) but ${defs.length} parameter(s) are defined. Define one parameter per marker, in order.`,
    );
  const known = new Set(defs.map((d) => d.name));
  const unknown = Object.keys(raw).filter((k) => !known.has(k));
  const errors: Record<string, string> = {};
  for (const k of unknown) errors[k] = 'Unknown parameter';
  const bound: BoundValue[] = [];
  const used: Record<string, BoundValue> = {};
  for (const d of defs) {
    let v = d.fixed ? d.defaultValue : raw[d.name];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))
      v = d.defaultValue;
    if (v === null || v === undefined) {
      if (d.required) errors[d.name] = `${d.label} is required`;
      bound.push(null);
      used[d.name] = null;
      continue;
    }
    const c = coerce(d, v);
    if (!c.ok) {
      errors[d.name] = `${d.label} ${c.message}`;
      continue;
    }
    bound.push(d.match ? likePattern(String(c.value), d.match) : c.value);
    used[d.name] = c.value;
  }
  if (Object.keys(errors).length)
    throw new AppError(400, 'INVALID_PARAMETERS', Object.values(errors).join('; '), {
      fields: errors,
    });
  return { bound, used };
}

export function parseStoredParameters(json: unknown): ParameterDef[] {
  if (json === null || json === undefined || json === '') return [];
  try {
    const r = parameterListSchema.safeParse(JSON.parse(String(json)));
    return r.success ? (r.data as ParameterDef[]) : [];
  } catch {
    return [];
  }
}
