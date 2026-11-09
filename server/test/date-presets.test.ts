import { describe, expect, it } from 'vitest';
import { DATE_PRESETS, datePresetRange, datePresetValue } from '../src/reports/date-presets.js';
import { parameterListSchema, resolveParameters } from '../src/reports/parameters.js';
import { buildJoinedReportSql } from '../src/catalog/join-builder.js';

const now = new Date('2026-11-05T18:00:00Z');
const expected = {
  TODAY: ['2026-11-05', '2026-11-05'],
  YESTERDAY: ['2026-11-04', '2026-11-04'],
  THIS_WEEK: ['2026-11-02', '2026-11-08'],
  LAST_WEEK: ['2026-10-26', '2026-11-01'],
  THIS_MONTH: ['2026-11-01', '2026-11-30'],
  LAST_MONTH: ['2026-10-01', '2026-10-31'],
  THIS_QUARTER: ['2026-10-01', '2026-12-31'],
  LAST_QUARTER: ['2026-07-01', '2026-09-30'],
  YTD: ['2026-01-01', '2026-11-05'],
  LAST_YEAR: ['2025-01-01', '2025-12-31'],
};

describe('rolling date presets', () => {
  it('resolves every preset and its calendar year boundaries', () => {
    for (const preset of DATE_PRESETS.filter((p) => p !== 'LAST_N_DAYS'))
      expect(datePresetRange({ preset }, now), preset).toEqual({
        from: expected[preset][0],
        to: expected[preset][1],
      });
    expect(datePresetRange({ preset: 'THIS_WEEK' }, new Date('2026-01-01T00:00:00Z'))).toEqual({
      from: '2025-12-29',
      to: '2026-01-04',
    });
    expect(datePresetRange({ preset: 'LAST_QUARTER' }, new Date('2026-01-15T00:00:00Z'))).toEqual({
      from: '2025-10-01',
      to: '2025-12-31',
    });
    expect(datePresetRange({ preset: 'LAST_MONTH' }, new Date('2024-03-01T00:00:00Z'))).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  it('supports Last N days, resolves in the documented zone, and validates N', () => {
    expect(datePresetRange({ preset: 'LAST_N_DAYS', n: 7 }, now)).toEqual({
      from: '2026-10-30',
      to: '2026-11-05',
    });
    expect(
      datePresetRange({ preset: 'TODAY' }, new Date('2026-11-06T02:00:00Z'), 'America/Regina'),
    ).toEqual({ from: '2026-11-05', to: '2026-11-05' });
    expect(datePresetRange({ preset: 'TODAY' }, new Date('2026-11-06T02:00:00Z'), 'UTC')).toEqual({
      from: '2026-11-06',
      to: '2026-11-06',
    });
    expect(() => datePresetRange({ preset: 'LAST_N_DAYS' }, now)).toThrow(/whole number/);
    expect(() => datePresetRange({ preset: 'LAST_N_DAYS', n: 3651 }, now)).toThrow(/whole number/);
  });

  it('binds presets server-side, never client SQL, and keeps legacy dates unchanged', () => {
    const spec = { preset: 'THIS_MONTH' as const };
    const b = buildJoinedReportSql(
      {
        schema: 'DEMOLIB',
        table: 'ORDERS',
        columns: ['ORDER_ID'],
        filters: [{ column: 'ORDER_DATE', op: 'BETWEEN', preset: spec }],
      } as never,
      [
        {
          table: { schema: 'DEMOLIB', name: 'ORDERS', type: 'T', text: null },
          columns: [
            {
              name: 'ORDER_ID',
              type: 'INTEGER',
              length: 10,
              precision: 10,
              scale: 0,
              nullable: false,
              text: null,
              ordinal: 1,
            },
            {
              name: 'ORDER_DATE',
              type: 'DATE',
              length: null,
              precision: null,
              scale: null,
              nullable: true,
              text: null,
              ordinal: 2,
            },
          ],
        },
      ],
    );
    expect(b.sql).not.toContain(`2026-`);
    expect(b.sql).toContain('"ORDER_DATE" BETWEEN ? AND ?');
    expect(b.sql).not.toContain('$preset');
    const p = resolveParameters(b.sql, b.parameters, {}, { now });
    expect(p.bound).toEqual(['2026-11-01', '2026-11-30']);
    expect(b.parameters.map((x) => x.defaultValue)).toEqual([
      datePresetValue(spec),
      datePresetValue(spec),
    ]);
    // Two days later the same stored definition resolves afresh.
    expect(
      resolveParameters(b.sql, b.parameters, {}, { now: new Date('2026-12-01T00:00:00Z') }).bound,
    ).toEqual(['2026-12-01', '2026-12-31']);
    // Old reports with literal defaults, and old SQL-only reports, behave exactly as before.
    expect(
      resolveParameters(
        'SELECT * FROM T WHERE D = ?',
        [{ name: 'D', label: 'Date', type: 'date', required: true, defaultValue: '2020-02-29' }],
        {},
      ).bound,
    ).toEqual(['2020-02-29']);
    // Tampered encoded presets never turn into an arbitrary string or SQL.
    expect(
      parameterListSchema.safeParse([
        { name: 'D', label: 'D', type: 'date', required: true, defaultValue: '$preset:bad' },
      ]).success,
    ).toBe(false);
  });

  it('expands a single-column preset into a BETWEEN and prompts both bounds when asked', () => {
    const b = buildJoinedReportSql(
      {
        schema: 'D',
        table: 'ORDERS',
        columns: ['ORDER_DATE'],
        filters: [
          {
            column: 'ORDER_DATE',
            op: '=',
            preset: { preset: 'LAST_N_DAYS', n: 30 },
            ask: { name: 'WHEN', label: 'When' },
          },
        ],
      } as never,
      [
        {
          table: { schema: 'D', name: 'ORDERS', type: 'T', text: null },
          columns: [
            {
              name: 'ORDER_DATE',
              type: 'DATE',
              length: null,
              precision: null,
              scale: null,
              nullable: true,
              text: null,
              ordinal: 1,
            },
          ],
        },
      ],
    );
    expect(b.parameters.map((p) => p.name)).toEqual(['WHEN', 'WHEN_TO']);
    expect(
      resolveParameters(b.sql, b.parameters, { WHEN: '2020-01-01', WHEN_TO: '2020-01-02' }, { now })
        .bound,
    ).toEqual(['2026-10-07', '2026-11-05']);
  });
});

describe('date preset schedules', () => {
  it('stores a preset name instead of today and revalidates as rolling days pass', () => {
    const defs = parameterListSchema.parse([
      {
        name: 'FROM_DAY',
        label: 'From',
        type: 'date',
        required: true,
        defaultValue: datePresetValue({ preset: 'THIS_MONTH' }),
        datePreset: { preset: 'THIS_MONTH' },
      },
      {
        name: 'FROM_DAY_TO',
        label: 'To',
        type: 'date',
        required: true,
        defaultValue: datePresetValue({ preset: 'THIS_MONTH' }),
        datePreset: { preset: 'THIS_MONTH' },
      },
    ]);
    // The schedule JSON stores the preset and N, not a resolved day.
    const scheduleValues = JSON.parse(
      JSON.stringify({
        FROM_DAY: datePresetValue({ preset: 'THIS_MONTH' }),
        FROM_DAY_TO: datePresetValue({ preset: 'THIS_MONTH' }),
      }),
    );
    expect(resolveParameters('? AND ?', defs, scheduleValues, { now }).bound).toEqual([
      '2026-11-01',
      '2026-11-30',
    ]);
    // Even stale literal schedule values cannot freeze a rolling definition.
    expect(
      resolveParameters(
        '? AND ?',
        defs,
        { FROM_DAY: '2026-01-01', FROM_DAY_TO: '2026-01-02' },
        { now },
      ).bound,
    ).toEqual(['2026-11-01', '2026-11-30']);
  });
});
