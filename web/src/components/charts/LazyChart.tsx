import { InlineLoading } from '@carbon/react';
import { Component, Suspense, lazy, type ReactNode } from 'react';
import type { ChartViewProps } from './ChartView';

// separate chunk: @carbon/charts + d3 are only downloaded when a chart is shown
const ChartView = lazy(() => import('./ChartView'));

class ChartBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(e: Error) {
    return { error: e.message || 'The chart could not be drawn.' };
  }
  render() {
    return this.state.error ? (
      <p className="qf-chart-note" role="alert">
        The chart could not be drawn: {this.state.error}
      </p>
    ) : (
      this.props.children
    );
  }
}

export function LazyChart(props: ChartViewProps) {
  return (
    <ChartBoundary>
      <Suspense fallback={<InlineLoading description="Loading chart…" />}>
        <div className="qf-chart" data-testid="qf-chart" data-chart-type={props.type}>
          <ChartView {...props} />
        </div>
      </Suspense>
    </ChartBoundary>
  );
}
