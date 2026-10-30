/**
 * Carbon Charts wrapper. Only ever imported through React.lazy (see LazyChart.tsx) so
 * @carbon/charts, d3 and their CSS live in a separate "charts" chunk that is downloaded
 * the first time a chart is shown.
 */
import * as Carbon from '@carbon/charts-react';
import { ScaleTypes, type ChartTabularData } from '@carbon/charts-react';
import type { ComponentType } from 'react';
import '@carbon/charts-react/styles.css';
import type { ChartPoint, ChartType } from '../../utils/chartData';

export interface ChartViewProps {
  type: ChartType;
  points: ChartPoint[];
  keys: string[];
  groups: string[];
  title?: string;
  xLabel: string;
  yLabel: string;
  height?: string;
  /** Compact rendering for dashboard tiles (no toolbar, legend only when needed). */
  compact?: boolean;
}

// The class components' bundled typings do not line up with this project's @types/react.
type CC = ComponentType<{ data: ChartTabularData; options: never }>;
const AreaChart = Carbon.AreaChart as unknown as CC;
const DonutChart = Carbon.DonutChart as unknown as CC;
const GroupedBarChart = Carbon.GroupedBarChart as unknown as CC;
const LineChart = Carbon.LineChart as unknown as CC;
const PieChart = Carbon.PieChart as unknown as CC;
const SimpleBarChart = Carbon.SimpleBarChart as unknown as CC;
const StackedBarChart = Carbon.StackedBarChart as unknown as CC;

export default function ChartView(p: ChartViewProps) {
  const data = p.points as unknown as ChartTabularData;
  const height = p.height ?? '400px';
  const common = {
    title: p.title ?? '',
    height,
    theme: 'white',
    animations: false,
    toolbar: { enabled: !p.compact },
    legend: { enabled: p.groups.length > 1 || p.type === 'pie' || p.type === 'donut' },
    data: { loading: false },
    accessibility: { svgAriaLabel: p.title || `${p.yLabel} by ${p.xLabel}` },
  };
  const labels = { mapsTo: 'key', scaleType: ScaleTypes.LABELS, domain: p.keys, title: p.xLabel };
  const values = { mapsTo: 'value', title: p.yLabel };
  const vertical = { ...common, axes: { bottom: labels, left: values } };
  const props = { data };
  switch (p.type) {
    case 'barHorizontal':
      return p.groups.length > 1 ? (
        <GroupedBarChart
          {...props}
          options={{ ...common, axes: { left: labels, bottom: values } } as never}
        />
      ) : (
        <SimpleBarChart
          {...props}
          options={{ ...common, axes: { left: labels, bottom: values } } as never}
        />
      );
    case 'groupedBar':
      return <GroupedBarChart {...props} options={vertical as never} />;
    case 'stackedBar':
      return (
        <StackedBarChart
          {...props}
          options={
            { ...vertical, axes: { ...vertical.axes, left: { ...values, stacked: true } } } as never
          }
        />
      );
    case 'line':
      return <LineChart {...props} options={vertical as never} />;
    case 'area':
      return <AreaChart {...props} options={vertical as never} />;
    case 'pie':
      return <PieChart {...props} options={{ ...common, resizable: true } as never} />;
    case 'donut':
      return (
        <DonutChart
          {...props}
          options={{ ...common, resizable: true, donut: { center: { label: p.yLabel } } } as never}
        />
      );
    default:
      return p.groups.length > 1 ? (
        <GroupedBarChart {...props} options={vertical as never} />
      ) : (
        <SimpleBarChart {...props} options={vertical as never} />
      );
  }
}
