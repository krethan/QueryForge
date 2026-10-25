import type React from 'react';
import {
  ComboBox,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api/client';
import type { Report, Schedule, ScheduleInput, ScheduleSettings } from '../api/types';
import { ErrorNotice } from './ErrorNotice';
import { ParameterFields, initialValues, validateValues } from './RunParamsModal';

const PRESETS = [
  { cron: '0 7 * * *', text: 'Every day at 07:00' },
  { cron: '0 7 * * 1-5', text: 'Weekdays at 07:00' },
  { cron: '0 7 * * 1', text: 'Every Monday at 07:00' },
  { cron: '0 7 1 * *', text: 'First day of the month at 07:00' },
];

function timeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return f ? f('timeZone') : ['UTC', 'America/Edmonton', 'America/New_York', 'Europe/London'];
}

interface Props {
  open: boolean;
  /** Existing schedule to edit, or null to create one. */
  schedule: Schedule | null;
  /** Fixed report (from the report editor); otherwise the user chooses one of `reports`. */
  report?: Report | null;
  reports?: Report[];
  settings: ScheduleSettings | null;
  onClose(): void;
  onSaved(s: Schedule): void;
}

export function ScheduleEditorModal({
  open,
  schedule,
  report,
  reports = [],
  settings,
  onClose,
  onSaved,
}: Props) {
  const [reportId, setReportId] = useState('');
  const [cron, setCron] = useState(PRESETS[2].cron);
  const [tz, setTz] = useState('UTC');
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [upcoming, setUpcoming] = useState<string[] | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(timeZones, []);

  const target = report ?? reports.find((r) => r.id === reportId) ?? null;
  const defs = useMemo(() => target?.parameters ?? [], [target]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldErrors({});
    setReportId(schedule?.reportId ?? report?.id ?? reports[0]?.id ?? '');
    setCron(schedule?.cron ?? PRESETS[2].cron);
    setTz(schedule?.timezone ?? settings?.defaultTimezone ?? 'UTC');
    setRecipients((schedule?.recipients ?? []).join('\n'));
    setEnabled(schedule?.enabled ?? true);
  }, [open, schedule, report, reports, settings]);

  useEffect(() => {
    if (open) setValues(initialValues(defs, schedule?.parameters));
  }, [open, defs, schedule]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      api
        .previewSchedule(cron, tz)
        .then((u) => {
          setUpcoming(u);
          setCronError(null);
        })
        .catch((e) => {
          setUpcoming(null);
          setCronError(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [open, cron, tz]);

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date(iso));

  const save = async () => {
    if (!target) return;
    const fe = validateValues(defs, values);
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    const input: ScheduleInput = {
      cron: cron.trim(),
      timezone: tz,
      recipients: recipients.split(/[\s,;]+/).filter(Boolean),
      parameters: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? null : v]),
      ),
      enabled,
    };
    setBusy(true);
    setError(null);
    try {
      const s = schedule
        ? await api.updateSchedule(schedule.id, { ...input, version: schedule.version })
        : await api.createSchedule(target.id, input);
      onSaved(s);
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFieldErrors(e.fields);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const domains = settings?.recipientDomains ?? [];
  const preset = PRESETS.find((p) => p.cron === cron)?.cron ?? 'custom';

  return (
    <Modal
      open={open}
      modalHeading={schedule ? 'Edit schedule' : 'New schedule'}
      modalLabel={target?.name ?? 'Scheduled run'}
      primaryButtonText={busy ? 'Saving…' : 'Save schedule'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || !target || Boolean(cronError)}
      onRequestClose={onClose}
      onRequestSubmit={save}
      size="md"
    >
      <Stack gap={5}>
        {settings && (!settings.enabled || !settings.mailConfigured || domains.length === 0) && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Scheduled e-mail is not fully configured."
            subtitle={[
              !settings.enabled && 'The scheduler is disabled (SCHEDULER_ENABLED).',
              !settings.mailConfigured && 'SMTP is not configured.',
              domains.length === 0 &&
                'No recipient domains are allowed (SCHEDULE_RECIPIENT_DOMAINS).',
            ]
              .filter(Boolean)
              .join(' ')}
          />
        )}
        <ErrorNotice error={error} />
        {!report && !schedule && (
          <Select
            id="sched-report"
            labelText="Report"
            value={reportId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setReportId(e.target.value)}
          >
            {reports.map((r) => (
              <SelectItem key={r.id} value={r.id} text={r.name} />
            ))}
          </Select>
        )}
        <div className="qf-two-col">
          <Select
            id="sched-preset"
            labelText="Frequency"
            value={preset}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              if (e.target.value !== 'custom') setCron(e.target.value);
            }}
          >
            {PRESETS.map((p) => (
              <SelectItem key={p.cron} value={p.cron} text={p.text} />
            ))}
            <SelectItem value="custom" text="Custom (cron)" />
          </Select>
          <TextInput
            id="sched-cron"
            labelText="Cron expression (minute hour day month weekday)"
            value={cron}
            invalid={Boolean(cronError)}
            invalidText={cronError ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCron(e.target.value)}
          />
        </div>
        <ComboBox
          id="sched-tz"
          titleText="Time zone"
          items={zones}
          selectedItem={tz}
          shouldFilterItem={({ item, inputValue }: { item: string; inputValue: string | null }) =>
            !inputValue || item.toLowerCase().includes(inputValue.toLowerCase())
          }
          onChange={({ selectedItem }: { selectedItem: string | null }) =>
            selectedItem && setTz(selectedItem)
          }
        />
        {upcoming && (
          <div className="qf-upcoming" aria-label="Next runs">
            <strong>Next runs ({tz}):</strong> {upcoming.slice(0, 3).map(fmt).join(' · ')}
          </div>
        )}
        <TextArea
          id="sched-recipients"
          labelText="E-mail recipients"
          helperText={
            domains.length
              ? `One per line. Allowed domains (exact match, subdomains are not included): ${domains.join(', ')}. Max ${settings?.maxRecipients}.`
              : 'One per line.'
          }
          rows={3}
          value={recipients}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setRecipients(e.target.value)}
        />
        {defs.length > 0 && (
          <fieldset className="qf-fieldset">
            <legend>Parameter values for each run</legend>
            <Stack gap={4}>
              <ParameterFields
                idPrefix="sched"
                parameters={defs}
                values={values}
                errors={fieldErrors}
                onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))}
              />
            </Stack>
          </fieldset>
        )}
        <Toggle
          id="sched-enabled"
          labelText="Status"
          labelA="Paused"
          labelB="Enabled"
          toggled={enabled}
          onToggle={(v: boolean) => setEnabled(v)}
        />
        <p className="qf-muted">
          Runs use the report owner&apos;s access, are recorded in history, and the XLSX is e-mailed
          over TLS. After {settings?.maxFailures ?? 3} consecutive failures the schedule is paused
          automatically.
        </p>
      </Stack>
    </Modal>
  );
}
