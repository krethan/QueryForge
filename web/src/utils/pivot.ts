import type { PivotResult } from '../api/types';
import { CHART_DEF_VERSION, type ChartDef } from './chartData';

/**
 * Default chart for a pivot: one bar per value of the first row field, one series per
 * column value, drawn from the grouped (long) rows the server returns with the pivot.
 * Stacked for SUM/COUNT (the stack adds up to the row total); grouped otherwise.
 */
export function pivotChartDefault(p: PivotResult): ChartDef {
  const additive = p.value.fn === 'SUM' || p.value.fn === 'COUNT';
  return {
    version: CHART_DEF_VERSION,
    type: additive ? 'stackedBar' : 'groupedBar',
    x: p.rowFields[0].name,
    y: ['PIVOT_VALUE'],
    series: p.columnField.name,
    title: `${p.value.label} by ${p.rowFields[0].label} and ${p.columnField.label}`,
  };
}

/** True when the long rows chart cleanly (one row field, so each bar is one pivot row). */
export const pivotChartable = (p: PivotResult) => p.rowFields.length === 1;
