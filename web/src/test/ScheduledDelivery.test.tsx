import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, api } from '../api/client';
import type {
  Report,
  Schedule,
  ScheduleDelivery,
  ScheduleRecipientOption,
  ScheduleSettings,
} from '../api/types';
import { ScheduleEditorModal } from '../components/ScheduleEditorModal';
import { ScheduleList } from '../components/ScheduleList';
import { ReportSchedulesModal } from '../components/ReportSchedulesModal';
import { describeCadence } from '../utils/schedule';

const report: Report = {
  id: 'r1',
  name: 'Weekly orders',
  description: null,
  category: null,
  sql: 'SELECT 1 FROM T',
  version: 1,
  createdAt: null,
  updatedAt: null,
  lastExecutedAt: null,
  lastStatus: 'NEVER',
  lastRowCount: null,
  lastDurationMs: null,
  folderId: null,
  favorite: false,
  tilePos: null,
};
const settings = (over: Partial<ScheduleSettings> = {}): ScheduleSettings => ({
  enabled: true,
  mailConfigured: true,
  recipientDomains: ['example.com'],
  maxRecipients: 20,
  minIntervalMinutes: 15,
  defaultTimezone: 'America/Edmonton',
  datePresetTimezone: 'UTC',
  maxFailures: 3,
  ...over,
});
const options: ScheduleRecipientOption[] = [
  {
    userId: 'u-alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    owner: true,
    allowedDomain: true,
  },
  {
    userId: 'u-bob',
    displayName: 'Bob',
    email: 'bob@example.com',
    owner: false,
    allowedDomain: true,
  },
  {
    userId: 'u-carl',
    displayName: 'Carl',
    email: 'carl@elsewhere.test',
    owner: false,
    allowedDomain: false,
  },
];
const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  reportId: 'r1',
  reportName: 'Weekly orders',
  createdBy: 'u-alice',
  cron: '0 7 * * 1',
  cadence: { frequency: 'WEEKLY', time: '07:00', weekday: 1 },
  description: 'Every Monday at 07:00',
  timezone: 'America/Edmonton',
  recipients: ['alice@example.com'],
  parameters: {},
  enabled: true,
  nextRunAt: '2026-11-16T13:00:00.000Z',
  lastRunAt: null,
  lastStatus: 'NEVER',
  lastError: null,
  failureCount: 0,
  version: 3,
  ...over,
});

function mockApi() {
  vi.spyOn(api, 'scheduleRecipients').mockResolvedValue(options);
  const preview = vi.spyOn(api, 'previewSchedule').mockImplementation(async (when) => ({
    upcoming: ['2026-11-16T13:00:00.000Z', '2026-11-23T13:00:00.000Z'],
    cron: when.cron ?? '0 7 * * 1',
    description: when.cadence ? describeCadence(when.cadence) : `Custom (cron ${when.cron})`,
  }));
  const create = vi.spyOn(api, 'createSchedule').mockImplementation(async () => schedule());
  const update = vi.spyOn(api, 'updateSchedule').mockImplementation(async () => schedule());
  return { preview, create, update };
}

function renderEditor(props: Partial<Parameters<typeof ScheduleEditorModal>[0]> = {}) {
  const onSaved = vi.fn();
  render(
    <ScheduleEditorModal
      open
      schedule={null}
      report={report}
      settings={settings()}
      onClose={() => {}}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onSaved };
}
const dialog = (name: string) => screen.getByRole('dialog', { name: new RegExp(name) });

describe('schedule editor', () => {
  it('builds a monthly cadence with recipients chosen from people who can open the report', async () => {
    const { preview, create } = mockApi();
    const { onSaved } = renderEditor();
    // owner is preselected; an address outside the allowed domains can't be chosen
    const alice = await screen.findByLabelText(/Alice \(alice@example.com\) · owner/);
    expect(alice).toBeChecked();
    expect(screen.getByLabelText(/Carl .* domain not allowed/)).toBeDisabled();
    expect(screen.getByText(/Only people who can already open this report/)).toBeInTheDocument();
    // default is weekly on Monday at 07:00
    expect(screen.getByLabelText('Repeat')).toHaveValue('WEEKLY');
    expect(screen.getByLabelText('Day of the week')).toHaveValue('1');
    await waitFor(() =>
      expect(preview).toHaveBeenCalledWith(
        { cadence: { frequency: 'WEEKLY', time: '07:00', weekday: 1 } },
        'America/Edmonton',
      ),
    );
    expect(await screen.findByText('Every Monday at 07:00')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'MONTHLY' } });
    fireEvent.change(screen.getByLabelText('Day of the month'), { target: { value: 'LAST' } });
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '06:30' } });
    fireEvent.click(screen.getByLabelText(/Bob \(bob@example.com\)/));
    fireEvent.change(screen.getByLabelText('Other addresses (optional)'), {
      target: { value: 'Admin@Example.com; bob@example.com' },
    });
    expect(await screen.findByText('Monthly on the last day at 06:30')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith('r1', {
      cadence: { frequency: 'MONTHLY', time: '06:30', dayOfMonth: 'LAST' },
      timezone: 'America/Edmonton',
      recipients: ['alice@example.com', 'bob@example.com', 'admin@example.com'],
      parameters: {},
      enabled: true,
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('edits an existing custom-cron schedule and keeps unknown recipients visible', async () => {
    const { update } = mockApi();
    renderEditor({
      schedule: schedule({
        cron: '0 7 1,15 * *',
        cadence: null,
        description: 'Custom (cron 0 7 1,15 * *)',
        recipients: ['alice@example.com', 'old-list@example.com'],
      }),
    });
    expect(screen.getByRole('heading', { name: 'Edit schedule' })).toBeInTheDocument();
    expect(screen.getByLabelText('Repeat')).toHaveValue('CUSTOM');
    expect(screen.getByLabelText(/Cron expression/)).toHaveValue('0 7 1,15 * *');
    await waitFor(() =>
      expect(screen.getByLabelText('Other addresses (optional)')).toHaveValue(
        'old-list@example.com',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toMatchObject({
      cron: '0 7 1,15 * *',
      recipients: ['alice@example.com', 'old-list@example.com'],
      version: 3,
    });
    expect(update.mock.calls[0][1]).not.toHaveProperty('cadence');
  });

  it('requires at least one recipient and shows server-side recipient errors', async () => {
    const { create } = mockApi();
    renderEditor();
    const alice = await screen.findByLabelText(/Alice/);
    fireEvent.click(alice);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Choose at least one recipient.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    create.mockRejectedValueOnce(
      new ApiError(
        400,
        'RECIPIENT_NO_ACCESS',
        'eve@example.com is not an Uncle Bob user who can open this report. Share the report with them first, or remove them.',
      ),
    );
    fireEvent.change(screen.getByLabelText('Other addresses (optional)'), {
      target: { value: 'eve@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Some recipients can’t open this report.')).toBeInTheDocument();
    expect(screen.getByText(/Share the report with them first/)).toBeInTheDocument();
  });

  it('when e-mail is not set up, warns and only allows saving the schedule paused', async () => {
    const { create } = mockApi();
    renderEditor({ settings: settings({ mailConfigured: false }) });
    expect(screen.getByText(/E-mail delivery isn.t set up on this server/)).toBeInTheDocument();
    const toggle = screen.getByRole('switch');
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    await screen.findByLabelText(/Alice/);
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][1]).toMatchObject({ enabled: false });
  });

  it('rejects an invalid time before calling the server', async () => {
    const { create } = mockApi();
    renderEditor();
    await screen.findByLabelText(/Alice/);
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'DAILY' } });
    fireEvent.change(screen.getByLabelText('Time of day'), { target: { value: '' } });
    expect(screen.getByText('Use a 24-hour time such as 07:30.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save schedule' })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('schedule list', () => {
  const renderList = (
    list: Schedule[],
    over: Partial<ScheduleSettings> = {},
    openHistoryFor: string | null = null,
  ) => {
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <ScheduleList
          schedules={list}
          settings={settings(over)}
          reports={[report]}
          showReport
          emptyText="Nothing here."
          onChanged={onChanged}
          openHistoryFor={openHistoryFor}
        />
      </MemoryRouter>,
    );
    return { onChanged };
  };

  it('shows cadence, time zone, recipients, next run and last result', () => {
    renderList([
      schedule({
        lastStatus: 'SUCCEEDED',
        lastRunAt: '2026-11-09T14:00:00.000Z',
        lastError: 'Not sent to bob@example.com: they can no longer open this report.',
      }),
      schedule({ id: 's2', enabled: false, nextRunAt: null, description: 'Every day at 06:00' }),
    ]);
    const rows = screen.getAllByTestId('schedule-row');
    expect(within(rows[0]).getByText('Every Monday at 07:00')).toBeInTheDocument();
    expect(within(rows[0]).getByText('America/Edmonton')).toBeInTheDocument();
    expect(within(rows[0]).getByText('alice@example.com')).toBeInTheDocument();
    expect(within(rows[0]).getByText('succeeded')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Not sent to bob@example.com/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Paused')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('button', { name: 'Resume schedule' })).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: 'Pause schedule' })).toBeInTheDocument();
  });

  it('pauses and resumes with the current version', async () => {
    const pause = vi.spyOn(api, 'pauseSchedule').mockResolvedValue(schedule({ enabled: false }));
    const resume = vi.spyOn(api, 'resumeSchedule').mockResolvedValue(schedule());
    const { onChanged } = renderList([
      schedule(),
      schedule({ id: 's2', enabled: false, version: 7 }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Pause schedule' }));
    await waitFor(() => expect(pause).toHaveBeenCalledWith('s1', 3));
    fireEvent.click(screen.getByRole('button', { name: 'Resume schedule' }));
    await waitFor(() => expect(resume).toHaveBeenCalledWith('s2', 7));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it('runs now and reports who got the e-mail and who was left out', async () => {
    vi.spyOn(api, 'runScheduleNow').mockResolvedValue({
      result: {
        status: 'SUCCEEDED',
        deliveredTo: ['alice@example.com'],
        skipped: ['bob@example.com'],
      },
      schedule: schedule(),
    });
    renderList([schedule()]);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(
      await screen.findByText(
        '“Weekly orders” was e-mailed to alice@example.com. Left out (no access): bob@example.com.',
      ),
    ).toBeInTheDocument();
  });

  it('disables run now and resume when e-mail is not set up', () => {
    renderList([schedule(), schedule({ id: 's2', enabled: false })], { mailConfigured: false });
    for (const b of screen.getAllByRole('button', { name: 'Run now' })) expect(b).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume schedule' })).toBeDisabled();
  });

  it('shows delivery history', async () => {
    const rows: ScheduleDelivery[] = [
      {
        id: 'd2',
        scheduleId: 's1',
        reportId: 'r1',
        trigger: 'MANUAL',
        requestedBy: 'u-alice',
        requestedByName: 'Alice',
        startedAt: '2026-11-10T15:00:00.000Z',
        finishedAt: '2026-11-10T15:00:02.000Z',
        status: 'SUCCEEDED',
        rowCount: 42,
        deliveredTo: ['alice@example.com'],
        skipped: ['bob@example.com'],
        error: null,
      },
      {
        id: 'd1',
        scheduleId: 's1',
        reportId: 'r1',
        trigger: 'SCHEDULE',
        requestedBy: null,
        startedAt: '2026-11-09T14:00:00.000Z',
        finishedAt: '2026-11-09T14:00:01.000Z',
        status: 'FAILED',
        rowCount: null,
        deliveredTo: [],
        skipped: [],
        error: 'SMTP 554 rejected',
      },
    ];
    const list = vi.spyOn(api, 'scheduleDeliveries').mockResolvedValue(rows);
    renderList([schedule()]);
    fireEvent.click(screen.getByRole('button', { name: 'Delivery history' }));
    const d = screen
      .getByRole('heading', { name: 'Delivery history' })
      .closest<HTMLElement>('[role="dialog"]')!;
    expect(await within(d).findByText('Run now by Alice')).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('s1');
    expect(within(d).getByText('Delivered')).toBeInTheDocument();
    expect(within(d).getByText('42 row(s)')).toBeInTheDocument();
    expect(within(d).getByText('Left out (no access): bob@example.com')).toBeInTheDocument();
    expect(within(d).getByText('On schedule')).toBeInTheDocument();
    expect(within(d).getByText('Failed')).toBeInTheDocument();
    expect(within(d).getByText('SMTP 554 rejected')).toBeInTheDocument();
  });

  it('opens a schedule’s delivery history from a notification link', async () => {
    const list = vi.spyOn(api, 'scheduleDeliveries').mockResolvedValue([]);
    renderList([schedule()], {}, 's1');
    expect(await screen.findByRole('heading', { name: 'Delivery history' })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith('s1');
  });

  it('ignores a history link for a schedule it does not list', () => {
    const list = vi.spyOn(api, 'scheduleDeliveries').mockResolvedValue([]);
    renderList([schedule()], {}, 'other');
    expect(list).not.toHaveBeenCalled();
  });

  it('deletes after confirmation', async () => {
    const del = vi.spyOn(api, 'deleteSchedule').mockResolvedValue(undefined);
    const { onChanged } = renderList([schedule()]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete schedule' }));
    const d = dialog('Delete this schedule');
    expect(
      within(d).getByText(/No more e-mails of “Weekly orders” will be sent/),
    ).toBeInTheDocument();
    fireEvent.click(within(d).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('s1'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});

describe('report schedules dialog', () => {
  it('lists the report’s schedules and opens the editor for a new one', async () => {
    mockApi();
    const load = vi
      .spyOn(api, 'reportSchedules')
      .mockResolvedValue({ schedules: [schedule()], settings: settings() });
    render(
      <MemoryRouter>
        <ReportSchedulesModal report={report} onClose={() => {}} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Every Monday at 07:00')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith('r1');
    expect(screen.getByRole('heading', { name: 'Scheduled delivery' })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    });
    expect(await screen.findByRole('heading', { name: 'New schedule' })).toBeInTheDocument();
    expect(await screen.findByLabelText(/Alice \(alice@example.com\) · owner/)).toBeChecked();
  });
});
