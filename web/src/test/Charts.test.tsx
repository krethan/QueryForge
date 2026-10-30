import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../api/client';
import type { Cell, Report, ResultColumn, RunResponse } from '../api/types';
import { ChartPanel } from '../components/charts/ChartPanel';
import { DashboardPage } from '../pages/DashboardPage';
import {
  chartProblem,
  cleanChartDef,
  prepareChart,
  suggestChart,
  type ChartDef,
  type ChartView,
} from '../utils/chartData';

// Carbon Charts needs real SVG layout; jsdom gets a stand-in that shows what would be plotted.
vi.mock('../components/charts/ChartView', () => ({
  default: (p: { type: string; points: { group: string; key: string; value: number }[] }) => (
    <ul data-testid="chart-view" data-type={p.type}>
      {p.points.map((x) => (
        <li key={`${x.group}/${x.key}`}>{`${x.group}|${x.key}=${x.value}`}</li>
      ))}
    </ul>
  ),
}));

const column = (name: string, kind: ResultColumn['kind'], label = name): ResultColumn => ({
  key: name,
  name,
  label,
  type: kind === 'decimal' ? 'DECIMAL' : 'VARCHAR',
  kind,
  precision: 11,
  scale: kind === 'decimal' ? 2 : 0,
  nullable: true,
});
const COLS = [column('REGION', 'text', 'Region'), column('REVENUE', 'decimal', 'Revenue')];
const ROWS: Cell[][] = [
  ['East', '1200.50'],
  ['West', '900.25'],
  ['East', '99.50'],
];

function Harness(props: {
  def?: ChartDef | null;
  view?: ChartView;
  rows?: Cell[][];
  hasMore?: boolean;
  onSave?(d: ChartDef | null): Promise<void>;
  saved?: ChartDef | null;
  columns?: ResultColumn[];
}) {
  const [def, setDef] = useState<ChartDef | null>(props.def ?? null);
  const [view, setView] = useState<ChartView>(props.view ?? 'table');
  return (
    <ChartPanel
      columns={props.columns ?? COLS}
      rows={props.rows ?? ROWS}
      hasMore={!!props.hasMore}
      def={def}
      onChange={setDef}
      view={view}
      onViewChange={setView}
      saved={props.saved}
      onSave={props.onSave}
      table={<table data-testid="results-table" />}
    />
  );
}
const bar: ChartDef = { version: 1, type: 'bar', x: 'REGION', y: ['REVENUE'] };

describe('chart data helpers', () => {
  it('suggests a bar chart for one text and one numeric column', () => {
    expect(suggestChart(COLS)).toEqual(bar);
    expect(suggestChart([column('D', 'date'), column('N', 'integer')])?.type).toBe('line');
    expect(suggestChart([column('A', 'text')])).toBeNull();
  });
  it('mirrors the server rules and strips empty options', () => {
    expect(chartProblem({ ...bar, type: 'pie', y: ['A', 'B'] })).toMatch(/Pie/);
    expect(chartProblem({ ...bar, topN: null })).toBeNull();
    expect(chartProblem({ ...bar, topN: 0 })).toMatch(/Top N/);
    expect(chartProblem({ ...bar, topN: 500 })).toMatch(/Top N/);
    expect(
      cleanChartDef({ ...bar, title: ' ', sort: 'none', series: null, dashboardAutoLoad: true }),
    ).toEqual(bar);
  });
  it('sums duplicate categories and converts decimal strings', () => {
    const p = prepareChart(bar, COLS, ROWS);
    expect(p.ok && p.points.map((x) => [x.key, x.value])).toEqual([
      ['East', 1300],
      ['West', 900.25],
    ]);
  });
});

describe('ChartPanel', () => {
  it('starts on the table with a suggestion and shows the chart on request', async () => {
    render(<Harness />);
    expect(screen.getByTestId('results-table')).toBeVisible();
    expect(screen.getByText(/Suggested: bar chart of REVENUE by REGION/)).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
    const chart = await screen.findByTestId('chart-view');
    expect(chart).toHaveAttribute('data-type', 'bar');
    expect(screen.getByText('Revenue|East=1300')).toBeInTheDocument();
    expect(screen.getByTestId('results-table')).toBeInTheDocument();
  });

  it('hides the table (but keeps it mounted) in Chart view', async () => {
    render(<Harness def={bar} view="chart" />);
    await screen.findByTestId('chart-view');
    expect(screen.getByTestId('results-table')).not.toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.getByTestId('results-table')).toBeVisible();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
  });

  it('switches chart type and applies top-N', async () => {
    render(<Harness def={bar} view="both" />);
    fireEvent.change(screen.getByLabelText('Chart type'), { target: { value: 'pie' } });
    expect(await screen.findByTestId('chart-view')).toHaveAttribute('data-type', 'pie');
    fireEvent.change(screen.getByLabelText(/Top N/), { target: { value: '1' } });
    await waitFor(() => expect(screen.queryByText(/West=/)).not.toBeInTheDocument());
    expect(screen.getByText(/Showing the top 1 of 2 categories/)).toBeInTheDocument();
  });

  it('notes partial results and lost decimal precision', async () => {
    render(<Harness def={bar} view="both" hasMore rows={[['East', '12345678901234567.89']]} />);
    await screen.findByTestId('chart-view');
    expect(screen.getByText(/rows loaded so far; more rows exist/)).toBeInTheDocument();
    expect(screen.getByText(/more than 15 significant digits/)).toBeInTheDocument();
  });

  it('disables the chart with a message when a saved field no longer exists', () => {
    render(<Harness def={{ ...bar, x: 'GONE' }} view="both" />);
    expect(screen.getByText(/column "GONE" is not in the results/)).toBeInTheDocument();
    expect(screen.queryByTestId('chart-view')).not.toBeInTheDocument();
  });

  it('explains when there is nothing numeric to chart', () => {
    render(<Harness view="both" columns={[column('A', 'text')]} rows={[['x']]} />);
    expect(screen.getByText(/no numeric column/)).toBeInTheDocument();
  });

  it('saves the chart with the dashboard opt-in', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<Harness def={bar} view="both" onSave={onSave} saved={null} />);
    const auto = screen.getByLabelText(/Run automatically/);
    expect(auto).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Show chart on dashboard'));
    expect(auto).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Revenue by region' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save chart' }));
    await screen.findByText('Chart saved with the report.');
    expect(onSave).toHaveBeenCalledWith({
      ...bar,
      title: 'Revenue by region',
      showOnDashboard: true,
    });
  });
});

const report = (over: Partial<Report>): Report => ({
  id: 'r1',
  name: 'Revenue by region',
  description: null,
  category: null,
  sql: 'SELECT REGION, REVENUE FROM T',
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastExecutedAt: null,
  lastStatus: 'NEVER',
  lastRowCount: null,
  lastDurationMs: null,
  ...over,
});
const run: RunResponse = {
  executionId: 'e1',
  columns: COLS,
  rows: ROWS,
  rowCount: 3,
  truncated: false,
  durationMs: 5,
} as unknown as RunResponse;

describe('dashboard chart tiles', () => {
  afterEach(() => vi.restoreAllMocks());
  const show = (reports: Report[]) => {
    vi.spyOn(api, 'listAllReports').mockResolvedValue({ owned: reports, shared: [] });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>,
    );
  };

  it('shows no chart unless the report opted in', async () => {
    const exec = vi.spyOn(api, 'executeReport').mockResolvedValue(run);
    show([report({ chartDef: bar })]);
    await screen.findByText('Revenue by region');
    expect(screen.queryByTestId('tile-chart')).not.toBeInTheDocument();
    expect(exec).not.toHaveBeenCalled();
  });

  it('waits for a click by default, then runs the report fresh with its defaults', async () => {
    const exec = vi.spyOn(api, 'executeReport').mockResolvedValue(run);
    show([report({ chartDef: { ...bar, showOnDashboard: true } })]);
    const btn = await screen.findByRole('button', { name: 'Load chart' });
    expect(exec).not.toHaveBeenCalled();
    fireEvent.click(btn);
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe('r1');
    expect(exec.mock.calls[0][3]).toBeUndefined(); // server applies parameter defaults
  });

  it('auto-runs only when the user enabled it', async () => {
    const exec = vi.spyOn(api, 'executeReport').mockResolvedValue(run);
    show([report({ chartDef: { ...bar, showOnDashboard: true, dashboardAutoLoad: true } })]);
    expect(await screen.findByTestId('chart-view')).toBeInTheDocument();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Load chart' })).not.toBeInTheDocument();
  });

  it('shows a message instead of crashing when the run fails or fields are gone', async () => {
    vi.spyOn(api, 'executeReport')
      .mockRejectedValueOnce(new Error('Missing required parameter "since".'))
      .mockResolvedValueOnce(run);
    show([
      report({ chartDef: { ...bar, showOnDashboard: true, dashboardAutoLoad: true } }),
      report({
        id: 'r2',
        name: 'Other',
        chartDef: { ...bar, x: 'GONE', showOnDashboard: true, dashboardAutoLoad: true },
      }),
    ]);
    expect(await screen.findByText(/needs parameter values/)).toBeInTheDocument();
    expect(await screen.findByText(/column "GONE" is not in the results/)).toBeInTheDocument();
  });
});
