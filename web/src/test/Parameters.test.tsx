import { fireEvent, render, screen } from '@testing-library/react';
import type { ParameterDef } from '../api/types';
import { countMarkers } from '../components/ParameterEditor';
import { RunParamsModal, initialValues, validateValues } from '../components/RunParamsModal';

const defs: ParameterDef[] = [
  {
    name: 'region',
    label: 'Region',
    type: 'list',
    required: true,
    defaultValue: null,
    options: [{ value: 'East' }, { value: 'West' }],
  },
  { name: 'since', label: 'Since', type: 'date', required: true, defaultValue: '2026-10-01' },
  {
    name: 'minAmount',
    label: 'Minimum amount',
    type: 'decimal',
    required: false,
    defaultValue: null,
  },
];

describe('countMarkers', () => {
  it('ignores ? inside literals, quoted identifiers and comments', () => {
    expect(
      countMarkers('SELECT * FROM T WHERE A = ? AND B = \'?\' -- ?\n AND "C?" = ? /* ? */'),
    ).toBe(2);
  });
});

describe('validateValues', () => {
  it('flags required, type and list errors', () => {
    const e = validateValues(defs, { region: 'North', since: 'nope', minAmount: 'abc' });
    expect(Object.keys(e).sort()).toEqual(['minAmount', 'region', 'since']);
    expect(validateValues(defs, { region: 'West', since: '2026-10-01', minAmount: '' })).toEqual(
      {},
    );
  });
  it('fills defaults', () => {
    expect(initialValues(defs).since).toBe('2026-10-01');
  });
});

describe('RunParamsModal', () => {
  it('blocks submit until required values are valid', () => {
    const onSubmit = vi.fn();
    render(
      <RunParamsModal
        open
        title="Run"
        parameters={defs}
        primaryText="Run"
        onClose={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Region/), { target: { value: 'West' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'West', since: '2026-10-01' }),
    );
  });
});
