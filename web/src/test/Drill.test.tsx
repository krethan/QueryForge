import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
  createMemoryRouter,
  useLocation,
} from 'react-router-dom';
import { api } from '../api/client';
import type { DrillInfo, DrillMeta, Report, ResultColumn, RunResponse } from '../api/types';
import { DashboardPage } from '../pages/DashboardPage';
import { ReportEditorPage } from '../pages/ReportEditorPage';
import { decodeDrill, encodeDrill, keysForPoint, keysForRow } from '../utils/drill';

// Stand-in chart: one button per plotted point that fires the click handler.
vi.mock('../components/charts/ChartView', () => ({
  default: (p: {
    points: { group: string; key: string }[];
    onSelect?: (x: { key: string; group: string }) => void;
  }) => (
    <div data-testid="chart-view">
      {p.points.map((x) => (
        <button key={`${x.group}/${x.key}`} onClick={() => p.onSelect?.(x)}>
          {`bar ${x.key}`}
        </button>
      ))}
    </div>
  ),
}));

const col = (name: string, kind: ResultColumn['kind'] = 'text'): ResultColumn =>
  ({ key: name, name, label: name, kind, type: 'VARCHAR', nullable: true }) as ResultColumn;
const grouped: RunResponse = {
  executionId: 'e1',
  columns: [col('REGION'), col('REVENUE', 'decimal')],
  rows: [
    ['West', '120.00'],
    [null, '5.00'],
  ],
  rowCount: 2,
  truncated: false,
  durationMs: 3,
  completedAt: '2026-10-29T00:00:00Z',
  dataSource: 'demo',
} as unknown as RunResponse;
const detail = (rows: (string | null)[][], cols = ['ORDER_ID', 'REGION']): RunResponse =>
  ({
    ...grouped,
    executionId: 'e2',
    columns: cols.map((c) => col(c)),
    rows,
    rowCount: rows.length,
  }) as unknown as RunResponse;
const builderInfo: DrillInfo = {
  builder: { fields: ['REGION'] },
  target: null,
  targetUnavailable: false,
};
const report = (over: Partial<Report> = {}): Report => ({
  id: 'r1',
  name: 'Revenue by Region',
  description: null,
  category: null,
  sql: 'SELECT REGION, SUM(AMOUNT) AS REVENUE FROM ORDERS GROUP BY REGION',
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastExecutedAt: null,
  lastStatus: 'NEVER',
  lastRowCount: null,
  lastDurationMs: null,
  access: 'VIEWER',
  chartDef: { version: 1, type: 'bar', x: 'REGION', y: ['REVENUE'], view: 'both' },
  drill: builderInfo,
  ...over,
});
const builderMeta = (value: string | null): DrillMeta => ({
  mode: 'builder',
  sourceId: 'r1',
  sourceName: 'Revenue by Region',
  label: value === null ? '(empty)' : value,
  applied: [{ field: 'REGION', value }],
  columns: [{ table: 'T1', column: 'ORDER_ID', label: 'T1.ORDER_ID' }],
  available: [
    { table: 'T1', column: 'ORDER_ID', label: 'T1.ORDER_ID' },
    { table: 'T1', column: 'AMOUNT', label: 'T1.AMOUNT' },
  ],
});

const openEditor = (r: Report, query = '?run=1') => {
  vi.spyOn(api, 'getReport').mockResolvedValue(r);
  vi.spyOn(api, 'executeReport').mockResolvedValue(grouped);
  const router = createMemoryRouter([{ path: '/reports/:id', element: <ReportEditorPage /> }], {
    initialEntries: [`/reports/${r.id}${query}`],
  });
  render(<RouterProvider router={router} />);
  return router;
};
const crumbs = () =>
  within(screen.getByRole('navigation', { name: 'Drill path' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('drill helpers', () => {
  const cols = [col('REGION'), col('REVENUE', 'decimal')];
  it('maps a clicked chart label back to the raw value, including NULL', () => {
    const def = { version: 1 as const, type: 'bar' as const, x: 'REGION', y: ['REVENUE'] };
    expect(keysForPoint(def, ['REGION'], cols, grouped.rows, { key: 'West' })).toEqual({
      REGION: 'West',
    });
    expect(keysForPoint(def, ['REGION'], cols, grouped.rows, { key: '(null)' })).toEqual({
      REGION: null,
    });
    expect(keysForPoint(def, ['OTHER'], cols, grouped.rows, { key: 'West' })).toBeNull();
    expect(keysForRow(['REGION'], cols, ['East', 1])).toEqual({ REGION: 'East' });
    expect(decodeDrill(encodeDrill({ REGION: null, N: 2 }))).toEqual({ REGION: null, N: 2 });
    expect(decodeDrill('{"a":{"b":1}}')).toBeNull();
  });
});

describe('click to drill', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the detail rows for a clicked bar with a breadcrumb, Back closes it', async () => {
    const drill = vi
      .spyOn(api, 'drill')
      .mockResolvedValue({ ...detail([['1001', 'West']]), drill: builderMeta('West') });
    openEditor(report());
    fireEvent.click(await screen.findByRole('button', { name: 'bar West' }));
    const panel = await screen.findByTestId('drill-panel');
    await within(panel).findByText('1001');
    expect(drill).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ keys: { REGION: 'West' }, mode: 'builder' }),
      expect.anything(),
    );
    expect(crumbs()).toEqual(['Revenue by Region', 'West']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Back' }));
    expect(screen.queryByTestId('drill-panel')).not.toBeInTheDocument();
  });

  it('drills from a grouped table row (NULL group -> IS NULL) and can change columns', async () => {
    const drill = vi
      .spyOn(api, 'drill')
      .mockResolvedValue({ ...detail([['1002', null]]), drill: builderMeta(null) });
    openEditor(report());
    const rows = await screen.findAllByTestId('drill-row');
    fireEvent.click(rows[1]);
    const panel = await screen.findByTestId('drill-panel');
    await within(panel).findByText('1002');
    expect(drill.mock.calls[0][1].keys).toEqual({ REGION: null });
    expect(crumbs()).toEqual(['Revenue by Region', '(empty)']);
    expect(within(panel).getByText('Detail columns')).toBeInTheDocument();
  });

  it('nests: target report -> its own detail rows, breadcrumb and Back walk the stack', async () => {
    const targetMeta: DrillMeta = {
      mode: 'target',
      sourceId: 'r1',
      sourceName: 'Region Totals',
      label: 'West',
      applied: [{ field: 'REGION', value: 'West' }],
      target: { id: 'r2', name: 'Orders by Region and Date' },
      values: { region: 'West' },
      next: { builder: { fields: ['ORDER_DATE'] }, target: null, targetUnavailable: false },
    };
    const drill = vi
      .spyOn(api, 'drill')
      .mockResolvedValueOnce({
        ...detail([['2026-01-02', 'West']], ['ORDER_DATE', 'REGION']),
        drill: targetMeta,
      })
      .mockResolvedValueOnce({
        ...detail([['1003', 'West']]),
        drill: {
          ...builderMeta('2026-01-02'),
          sourceId: 'r2',
          sourceName: 'Orders by Region and Date',
        },
      });
    openEditor(
      report({
        name: 'Region Totals',
        drill: {
          builder: null,
          target: { id: 'r2', name: 'Orders by Region and Date', fields: ['REGION'] },
          targetUnavailable: false,
        },
      }),
    );
    fireEvent.click((await screen.findAllByTestId('drill-row'))[0]);
    const panel = await screen.findByTestId('drill-panel');
    await within(panel).findByText('2026-01-02');
    expect(drill.mock.calls[0][1].mode).toBe('target');
    fireEvent.click(within(panel).getAllByTestId('drill-row')[0]);
    await within(panel).findByText('1003');
    expect(drill.mock.calls[1][0]).toBe('r2');
    expect(drill.mock.calls[1][1]).toMatchObject({
      keys: { ORDER_DATE: '2026-01-02' },
      mode: 'builder',
      values: { region: 'West' },
    });
    expect(crumbs()).toEqual(['Region Totals', 'West', '2026-01-02']);
    fireEvent.click(within(panel).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(crumbs()).toEqual(['Region Totals', 'West']));
    expect(within(panel).getByText('2026-01-02')).toBeInTheDocument();
  });

  it('hides the drill affordance when the report has no drill', async () => {
    const drill = vi.spyOn(api, 'drill');
    openEditor(report({ drill: { builder: null, target: null, targetUnavailable: false } }));
    fireEvent.click(await screen.findByRole('button', { name: 'bar West' }));
    expect(screen.queryAllByTestId('drill-row')).toHaveLength(0);
    expect(screen.queryByTestId('drill-panel')).not.toBeInTheDocument();
    expect(drill).not.toHaveBeenCalled();
  });

  it('opens a report from the dashboard with the drill applied', async () => {
    vi.spyOn(api, 'drill').mockResolvedValue({
      ...detail([['1001', 'West']]),
      drill: builderMeta('West'),
    });
    openEditor(report(), `?drill=${encodeURIComponent(encodeDrill({ REGION: 'West' }))}`);
    const panel = await screen.findByTestId('drill-panel');
    await within(panel).findByText('1001');
    expect(crumbs()).toEqual(['Revenue by Region', 'West']);
  });

  it('dashboard mini chart click navigates to the report with ?drill=', async () => {
    vi.spyOn(api, 'executeReport').mockResolvedValue(grouped);
    vi.spyOn(api, 'listAllReports').mockResolvedValue({
      owned: [
        report({
          access: 'OWNER',
          drill: undefined,
          builderDef: { version: 1, spec: { groupBy: [{ column: 'REGION' }] } as never },
          chartDef: {
            version: 1,
            type: 'bar',
            x: 'REGION',
            y: ['REVENUE'],
            showOnDashboard: true,
            dashboardAutoLoad: true,
          },
        }),
      ],
      shared: [],
    });
    const Probe = () => {
      const l = useLocation();
      return <div data-testid="at">{l.pathname + l.search}</div>;
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/reports/:id" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'bar West' }));
    const at = (await screen.findByTestId('at')).textContent!;
    expect(at.startsWith('/reports/r1?drill=')).toBe(true);
    expect(decodeDrill(new URLSearchParams(at.split('?')[1]).get('drill'))).toEqual({
      REGION: 'West',
    });
  });
});
