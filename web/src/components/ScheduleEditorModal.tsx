import type React from 'react';
import {
  Checkbox,
  ComboBox,
  InlineLoading,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api/client';
import type {
  ParameterDef,
  Report,
  Schedule,
  ScheduleCadence,
  ScheduleFrequency,
  ScheduleInput,
  ScheduleRecipientOption,
  ScheduleSettings,
} from '../api/types';
import { ErrorNotice } from './ErrorNotice';
import { ParameterFields, initialValues, validateValues } from './RunParamsModal';
import { setPreset } from './datePresetState';
import { DEFAULT_CADENCE, FREQUENCY_OPTIONS, WEEKDAYS, splitAddresses } from '../utils/schedule';

function timeZones(): string[] {
  const f = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  return f ? f('timeZone') : ['UTC', 'America/Edmonton', 'America/New_York', 'Europe/London'];
}

const DAYS = [
  ...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), text: String(i + 1) })),
  { value: 'LAST', text: 'Last day of the month' },
];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NO_REPORTS: Report[] = [];

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
  reports = NO_REPORTS,
  settings,
  onClose,
  onSaved,
}: Props) {
  const [reportId, setReportId] = useState('');
  const [mode, setMode] = useState<ScheduleFrequency | 'CUSTOM'>(DEFAULT_CADENCE.frequency);
  const [time, setTime] = useState(DEFAULT_CADENCE.time);
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState('1');
  const [cron, setCron] = useState('0 7 * * 1');
  const [tz, setTz] = useState('UTC');
  const [options, setOptions] = useState<ScheduleRecipientOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [presetDefs, setPresetDefs] = useState<ParameterDef[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [upcoming, setUpcoming] = useState<string[] | null>(null);
  const [description, setDescription] = useState('');
  const [whenError, setWhenError] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const zones = useMemo(timeZones, []);

  const target = report ?? reports.find((r) => r.id === reportId) ?? null;
  const defs = useMemo(() => target?.parameters ?? [], [target]);
  const mailReady = settings ? settings.mailConfigured : true;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFieldErrors({});
    setRecipientError(null);
    setReportId(schedule?.reportId ?? report?.id ?? reports[0]?.id ?? '');
    const c = schedule ? schedule.cadence : DEFAULT_CADENCE;
    setMode(c ? c.frequency : 'CUSTOM');
    setTime(c?.time ?? DEFAULT_CADENCE.time);
    setWeekday(c?.weekday ?? 1);
    setDay(c?.dayOfMonth !== undefined ? String(c.dayOfMonth) : '1');
    setCron(schedule?.cron ?? '0 7 * * 1');
    setTz(schedule?.timezone ?? settings?.defaultTimezone ?? 'UTC');
    // without e-mail delivery a schedule can only be saved paused
    setEnabled((schedule?.enabled ?? true) && (settings ? settings.mailConfigured : true));
  }, [open, schedule, report, reports, settings]);

  useEffect(() => {
    if (open) {
      setValues(initialValues(defs, schedule?.parameters));
      setPresetDefs(defs);
    }
  }, [open, defs, schedule]);

  // People who can open the report: only they can be recipients.
  const targetId = target?.id;
  useEffect(() => {
    if (!open || !targetId) return;
    let live = true;
    setOptions(null);
    api
      .scheduleRecipients(targetId)
      .then((opts) => {
        if (!live) return;
        setOptions(opts);
        const known = new Set(opts.map((o) => o.email));
        if (schedule) {
          setSelected(schedule.recipients.filter((r) => known.has(r)));
          setOther(schedule.recipients.filter((r) => !known.has(r)).join(', '));
        } else {
          setSelected(opts.filter((o) => o.owner && o.allowedDomain).map((o) => o.email));
          setOther('');
        }
      })
      .catch((e) => {
        if (!live) return;
        setOptions([]);
        setError(e);
      });
    return () => {
      live = false;
    };
  }, [open, targetId, schedule]);

  const cadence: ScheduleCadence | null =
    mode === 'CUSTOM'
      ? null
      : {
          frequency: mode,
          time,
          ...(mode === 'WEEKLY' ? { weekday } : {}),
          ...(mode === 'MONTHLY' ? { dayOfMonth: day === 'LAST' ? 'LAST' : Number(day) } : {}),
        };
  const timeOk = mode === 'CUSTOM' || TIME_RE.test(time);
  const whenKey = JSON.stringify(cadence ?? { cron });

  useEffect(() => {
    if (!open || !timeOk) return;
    const when = JSON.parse(whenKey) as { cron?: string } & Partial<ScheduleCadence>;
    const t = setTimeout(() => {
      api
        .previewSchedule(
          when.cron !== undefined ? { cron: when.cron } : { cadence: when as ScheduleCadence },
          tz,
        )
        .then((p) => {
          setUpcoming(p.upcoming);
          setDescription(p.description);
          setWhenError(null);
        })
        .catch((e) => {
          setUpcoming(null);
          setWhenError(e instanceof Error ? e.message : String(e));
        });
    }, 300);
    return () => clearTimeout(t);
  }, [open, whenKey, tz, timeOk]);

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: tz,
    }).format(new Date(iso));

  const recipients = [...new Set([...selected, ...splitAddresses(other)])];

  const save = async () => {
    if (!target) return;
    const fe = validateValues(presetDefs, values);
    setFieldErrors(fe);
    if (!recipients.length) {
      setRecipientError('Choose at least one recipient.');
      return;
    }
    setRecipientError(null);
    if (Object.keys(fe).length || !timeOk) return;
    const presetParams = Object.fromEntries(
      presetDefs
        .filter((d) => d.defaultValue?.startsWith('$preset:'))
        .map((d) => [d.name, d.defaultValue]),
    );
    const input: ScheduleInput = {
      ...(cadence ? { cadence } : { cron: cron.trim() }),
      timezone: tz,
      recipients,
      parameters: {
        ...presetParams,
        ...Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? null : v]),
        ),
      },
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
  const toggle = (email: string, on: boolean) =>
    setSelected((cur) => (on ? [...new Set([...cur, email])] : cur.filter((x) => x !== email)));

  return (
    <Modal
      open={open}
      modalHeading={schedule ? 'Edit schedule' : 'New schedule'}
      modalLabel={target?.name ?? 'Scheduled delivery'}
      primaryButtonText={busy ? 'Saving…' : 'Save schedule'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || !target || Boolean(whenError) || !timeOk}
      onRequestClose={onClose}
      onRequestSubmit={save}
      size="md"
    >
      <Stack gap={5}>
        {settings && !settings.mailConfigured && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="E-mail delivery isn't set up on this server."
            subtitle="You can save this schedule as paused. An administrator needs to configure SMTP before it can be turned on or run."
          />
        )}
        {settings && settings.mailConfigured && (!settings.enabled || domains.length === 0) && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Scheduled e-mail is not fully configured."
            subtitle={[
              !settings.enabled && 'The scheduler is disabled on this server (SCHEDULER_ENABLED).',
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
            id="sched-frequency"
            labelText="Repeat"
            value={mode}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setMode(e.target.value as ScheduleFrequency | 'CUSTOM')
            }
          >
            {FREQUENCY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value} text={o.text} />
            ))}
          </Select>
          {mode === 'CUSTOM' ? (
            <TextInput
              id="sched-cron"
              labelText="Cron expression (minute hour day month weekday)"
              value={cron}
              invalid={Boolean(whenError)}
              invalidText={whenError ?? ''}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCron(e.target.value)}
            />
          ) : (
            <TextInput
              id="sched-time"
              type="time"
              labelText="Time of day"
              value={time}
              invalid={!timeOk || Boolean(whenError)}
              invalidText={!timeOk ? 'Use a 24-hour time such as 07:30.' : (whenError ?? '')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTime(e.target.value)}
            />
          )}
        </div>
        {mode === 'WEEKLY' && (
          <Select
            id="sched-weekday"
            labelText="Day of the week"
            value={String(weekday)}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setWeekday(Number(e.target.value))
            }
          >
            {WEEKDAYS.map((d, i) => (
              <SelectItem key={d} value={String(i)} text={d} />
            ))}
          </Select>
        )}
        {mode === 'MONTHLY' && (
          <Select
            id="sched-day"
            labelText="Day of the month"
            helperText="Days 29-31 aren't offered because some months don't have them; choose the last day instead."
            value={day}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDay(e.target.value)}
          >
            {DAYS.map((d) => (
              <SelectItem key={d.value} value={d.value} text={d.text} />
            ))}
          </Select>
        )}
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
        {upcoming && !whenError && (
          <div className="qf-upcoming" aria-label="Next runs">
            <strong>{description}</strong> ({tz}). Next runs:{' '}
            {upcoming.slice(0, 3).map(fmt).join(' · ')}
          </div>
        )}
        <fieldset className="qf-fieldset" aria-describedby="sched-recipients-help">
          <legend>Send the Excel file to</legend>
          <p id="sched-recipients-help" className="qf-muted">
            Only people who can already open this report can receive it. To add someone else, share
            the report with them first.
            {domains.length > 0 && ` Allowed e-mail domains: ${domains.join(', ')}.`}
          </p>
          {options === null ? (
            <InlineLoading description="Loading people who can open this report…" />
          ) : options.length === 0 ? (
            <p className="qf-muted">
              Nobody who can open this report has an e-mail address on file.
            </p>
          ) : (
            options.map((o) => (
              <Checkbox
                key={o.email}
                id={`sched-rcpt-${o.userId}`}
                labelText={`${o.displayName} (${o.email})${o.owner ? ' · owner' : ''}${o.allowedDomain ? '' : ' · domain not allowed'}`}
                checked={selected.includes(o.email)}
                disabled={!o.allowedDomain && !selected.includes(o.email)}
                onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                  toggle(o.email, checked)
                }
              />
            ))
          )}
          <TextInput
            id="sched-other"
            labelText="Other addresses (optional)"
            helperText="For example an administrator's address. They must already be able to open this report."
            value={other}
            invalid={Boolean(recipientError)}
            invalidText={recipientError ?? ''}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setOther(e.target.value)}
          />
        </fieldset>
        {defs.length > 0 && (
          <fieldset className="qf-fieldset">
            <legend>Parameter values for each run</legend>
            <Stack gap={4}>
              <ParameterFields
                idPrefix="sched"
                parameters={presetDefs}
                onChangePreset={(n, v) => {
                  setPresetDefs((current) => setPreset(current, n, v));
                  setValues((old) => ({ ...old, [n]: v ?? '' }));
                }}
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
          labelB="On"
          toggled={enabled}
          disabled={!mailReady}
          onToggle={(v: boolean) => setEnabled(v)}
        />
        <p className="qf-muted">
          Each run uses the report owner&apos;s access, is recorded in history, and the Excel file
          is e-mailed over TLS. Recipients who can no longer open the report are left out. After{' '}
          {settings?.maxFailures ?? 3} failures in a row the schedule is paused automatically.
        </p>
      </Stack>
    </Modal>
  );
}
