import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SaveReportModal } from '../components/SaveReportModal';

describe('SaveReportModal', () => {
  it('requires a report name before saving', async () => {
    const onSave = vi.fn();
    render(
      <SaveReportModal
        open
        title="Save"
        initial={{ name: '', description: '', category: '' }}
        saving={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Report name is required.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Report name'), 'Sales');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledWith({ name: 'Sales', description: '', category: '' });
  });
});
