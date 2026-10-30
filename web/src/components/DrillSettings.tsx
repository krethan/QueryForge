import { Button, InlineNotification, Select, SelectItem } from '@carbon/react';
import { Save } from '@carbon/icons-react';
import { useEffect, useState, type ChangeEvent } from 'react';
import { api } from '../api/client';
import type { DrillDef, DrillTargetOption, Report } from '../api/types';

interface Props {
  report: Report;
  /** Result columns the source can pass on (group fields or SQL result columns). */
  fields: string[];
  onSaved(report: Report): void;
}

/** Owner / editor settings: "Drill to report X", mapping clicked fields to X's parameters. */
export function DrillSettings({ report, fields, onSaved }: Props) {
  const [targets, setTargets] = useState<DrillTargetOption[] | null>(null);
  const [targetId, setTargetId] = useState(report.drillDef?.targetReportId ?? '');
  const [map, setMap] = useState<Record<string, string>>(() =>
    Object.fromEntries((report.drillDef?.mapping ?? []).map((m) => [m.parameter, m.field])),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => {
    api
      .drillTargets(report.id)
      .then(setTargets)
      .catch((e) => setMsg({ kind: 'error', text: (e as Error).message }));
  }, [report.id]);

  const target = targets?.find((t) => t.id === targetId);
  const mapping = target
    ? target.parameters
        .filter((p) => map[p.name])
        .map((p) => ({ field: map[p.name], parameter: p.name }))
    : [];
  const fieldOptions = [...new Set([...fields, ...Object.values(map).filter(Boolean)])];

  const save = async (def: DrillDef | null) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.setReportDrill(report.id, def);
      onSaved(r);
      setMsg({
        kind: 'success',
        text: def ? `Drills to ${target?.name}.` : 'Drill target removed.',
      });
      if (!def) {
        setTargetId('');
        setMap({});
      }
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qf-drill-settings" data-testid="drill-settings">
      <p className="qf-chart-note">
        {report.drill?.builder
          ? `Clicking a chart element or grouped row shows its detail rows (grouped by ${report.drill.builder.fields.join(', ')}). Pick a target report to open that report instead.`
          : 'Pick a report to open when a chart element or row is clicked. Without a target, SQL reports have no drill-down.'}
      </p>
      <Select
        id="qf-drill-target"
        labelText="Drill to report"
        size="sm"
        value={targetId}
        disabled={!targets || busy}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => {
          setTargetId(e.target.value);
          setMap({});
        }}
      >
        <SelectItem value="" text={targets ? 'None' : 'Loading reports…'} />
        {(targets ?? []).map((t) => (
          <SelectItem key={t.id} value={t.id} text={t.name} />
        ))}
      </Select>
      {target && target.parameters.length === 0 && (
        <p className="qf-chart-note" role="alert">
          {target.name} has no parameters to receive the clicked values.
        </p>
      )}
      {target?.parameters.map((p) => (
        <Select
          key={p.name}
          id={`qf-drill-map-${p.name}`}
          labelText={`${p.label ?? p.name} (${p.name}) gets`}
          size="sm"
          value={map[p.name] ?? ''}
          disabled={busy}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            setMap((m) => ({ ...m, [p.name]: e.target.value }))
          }
        >
          <SelectItem value="" text="Its default value" />
          {fieldOptions.map((f) => (
            <SelectItem key={f} value={f} text={`Clicked ${f}`} />
          ))}
        </Select>
      ))}
      <div className="qf-chart-actions">
        <Button
          size="sm"
          renderIcon={Save}
          disabled={busy || !target || mapping.length === 0}
          onClick={() => void save({ version: 1, targetReportId: target!.id, mapping })}
        >
          Save drill target
        </Button>
        {report.drillDef && (
          <Button size="sm" kind="ghost" disabled={busy} onClick={() => void save(null)}>
            Remove drill target
          </Button>
        )}
      </div>
      {report.drill?.targetUnavailable && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="You cannot run the configured drill target, so it is not offered to you."
        />
      )}
      {msg && (
        <InlineNotification
          kind={msg.kind}
          lowContrast
          title={msg.text}
          onClose={() => setMsg(null)}
        />
      )}
    </div>
  );
}
