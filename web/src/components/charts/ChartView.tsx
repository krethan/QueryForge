/**
 * Carbon Charts wrapper. Only ever imported through React.lazy (see LazyChart.tsx) so
 * @carbon/charts, d3 and their CSS live in a separate "charts" chunk that is downloaded
 * the first time a chart is shown.
 */
import * as Carbon from '@carbon/charts-react';
import { ScaleTypes, type ChartTabularData } from '@carbon/charts-react';
import { useEffect, useRef, type ComponentType, type Ref } from 'react';
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
  /** Called when a bar, slice or point is clicked (enables the pointer cursor). */
  onSelect?(point: { key: string; group: string }): void;
}

const CLICK_EVENTS = ['bar-click', 'pie-slice-click', 'scatter-click'];
interface ChartHandle {
  chart?: {
    services?: {
      events?: {
        addEventListener(t: string, f: (e: Event) => void): void;
        removeEventListener(t: string, f: (e: Event) => void): void;
      };
    };
  };
}

// The class components' bundled typings do not line up with this project's @types/react.
type CC = ComponentType<{ data: ChartTabularData; options: never; ref?: Ref<ChartHandle> }>;
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
  const ref = useRef<ChartHandle>(null);
  const select = useRef(p.onSelect);
  select.current = p.onSelect;
  const clickable = Boolean(p.onSelect);
  useEffect(() => {
    const events = ref.current?.chart?.services?.events;
    if (!events || !clickable) return;
    const h = (e: Event) => {
      const raw = (e as CustomEvent<{ datum?: Record<string, unknown> }>).detail?.datum;
      // pie slices wrap the data point in a d3 arc
      const d = (raw && 'data' in raw ? raw.data : raw) as { key?: unknown; group?: unknown };
      if (d && d.key !== undefined)
        select.current?.({ key: String(d.key), group: String(d.group ?? '') });
    };
    CLICK_EVENTS.forEach((t) => events.addEventListener(t, h));
    return () => CLICK_EVENTS.forEach((t) => events.removeEventListener(t, h));
  }, [clickable, p.type, p.groups.length]);
  const props = { data, ref };
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
