import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ParameterEditor } from '../components/ParameterEditor';
import { RunParamsModal } from '../components/RunParamsModal';
import { DatePresetSelect, presetChoice } from '../components/DatePresetFields';
import type { ParameterDef } from '../api/types';
import { useState } from 'react';

function EditorHarness({ initial }: { initial: ParameterDef[] }) {
  const [defs, setDefs] = useState(initial);
  return (
    <>
      <ParameterEditor sql="SELECT * FROM T WHERE D = ?" value={defs} onChange={setDefs} />
      <output aria-label="Saved value">{defs[0].defaultValue}</output>
    </>
  );
}
const date = (): ParameterDef[] => [
  { name: 'DAY', label: 'Day', type: 'date', required: true, defaultValue: null },
];

describe('date preset editors', () => {
  it('stores Last N days rather than today and supports a custom date', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    render(<EditorHarness initial={date()} />);
    await user.selectOptions(screen.getByLabelText('Rolling default'), 'LAST_N_DAYS');
    const n = screen.getByLabelText(/Number of days/);
    n.focus();
    await user.keyboard('{Control>}a{/Control}7');
    // number inputs accept successive values; verify 7 explicitly
    expect(screen.getByLabelText('Saved value')).toHaveTextContent(
      '{"preset":"LAST_N_DAYS","n":7}',
    );
    await user.selectOptions(screen.getByLabelText('Rolling default'), '');
    await user.type(screen.getByLabelText('Default'), '2026-01-01');
    expect(screen.getByLabelText('Saved value')).toHaveTextContent('2026-01-01');
  });

  it('shows a rolling preset in the run form and disables frozen input', () => {
    const defs: ParameterDef[] = [
      {
        ...date()[0],
        defaultValue: '$preset:{"preset":"THIS_MONTH"}',
        datePreset: { preset: 'THIS_MONTH' },
      },
    ];
    render(
      <ParameterEditor
        sql="SELECT * FROM T WHERE D = ?"
        value={defs}
        onChange={() => {}}
        readOnly
      />,
    );
    expect(screen.getByLabelText('Rolling default')).toHaveValue('THIS_MONTH');
    expect(screen.getByLabelText('Default')).toHaveAttribute('readonly');
    expect(screen.getByText(/server in the configured zone/)).toBeInTheDocument();
  });

  it('round-trips a schedule preset and offers the shared range selector', async () => {
    expect(presetChoice({ defaultValue: '$preset:{"preset":"LAST_N_DAYS","n":14}' })).toEqual({
      choice: 'LAST_N_DAYS',
      n: 14,
    });
    const user = userEvent.setup();
    const changed = vi.fn();
    render(<DatePresetSelect id="schedule-date" value={{ choice: '' }} onChange={changed} />);
    await user.selectOptions(screen.getByLabelText('Date range'), 'YESTERDAY');
    expect(changed).toHaveBeenCalledWith({ choice: 'YESTERDAY' });
  });

  it('allows a prompted preset and does not resurrect its original default', async () => {
    const value = '$preset:{"preset":"LAST_N_DAYS","n":30}';
    const initial = [
      {
        ...date()[0],
        name: 'WHEN',
        label: 'When',
        defaultValue: value,
        datePreset: { preset: 'LAST_N_DAYS' as const, n: 30 },
      },
      {
        ...date()[0],
        name: 'WHEN_TO',
        label: 'When to',
        defaultValue: value,
        datePreset: { preset: 'LAST_N_DAYS' as const, n: 30 },
      },
    ];
    const changed = vi.fn();
    render(
      <RunParamsModal
        open
        title="Run"
        parameters={initial}
        onClose={() => {}}
        onSubmit={() => {}}
        onPresetChange={changed}
      />,
    );
    const select = screen.getByLabelText('When rolling range');
    await userEvent.setup().selectOptions(select, 'YESTERDAY');
    expect(changed).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'WHEN',
        defaultValue: '$preset:{"preset":"YESTERDAY"}',
        datePreset: { preset: 'YESTERDAY' },
      }),
      expect.objectContaining({
        name: 'WHEN_TO',
        defaultValue: '$preset:{"preset":"YESTERDAY"}',
        datePreset: { preset: 'YESTERDAY' },
      }),
    ]);
    expect(screen.getByLabelText('When rolling range')).toHaveValue('YESTERDAY');
  });

  it('does not clear an open prompt during a transient builder preview', () => {
    const initial = [{ ...date()[0], name: 'REGION', label: 'Region', type: 'string' as const }];
    const { rerender } = render(
      <RunParamsModal
        open
        title="Run"
        parameters={initial}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
    rerender(
      <RunParamsModal open title="Run" parameters={[]} onClose={() => {}} onSubmit={() => {}} />,
    );
    expect(screen.getByLabelText('Region')).toBeInTheDocument();
  });

  it('retains the same definitions through validation', async () => {
    const defs: ParameterDef[] = [
      { ...date()[0], defaultValue: '$preset:{"preset":"YTD"}', datePreset: { preset: 'YTD' } },
    ];
    render(
      <ParameterEditor
        sql="SELECT * FROM T WHERE D = ?"
        value={defs}
        onChange={() => {}}
        readOnly
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Rolling default')).toHaveValue('YTD'));
  });
});
