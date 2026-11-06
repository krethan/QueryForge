import type React from 'react';
import {
  Form,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from '@carbon/react';
import { useEffect, useState } from 'react';
import { DatePresetSelect, presetChoice } from './DatePresetFields';
import { encodePresetChoice, setPreset } from './datePresetState';
import type { ParameterDef, ParameterValues } from '../api/types';

/** Client-side checks for fast feedback. The server re-validates every value before binding. */
export function validateValues(defs: ParameterDef[], v: Record<string, string>) {
  const errors: Record<string, string> = {};
  for (const d of defs) {
    if (d.fixed || (d.type === 'date' && d.datePreset)) continue;
    const s = (v[d.name] ?? '').trim();
    if (!s) {
      if (d.required && !d.defaultValue) errors[d.name] = `${d.label} is required`;
      continue;
    }
    if (s.startsWith('$preset:')) continue; // opaque preset, resolved and validated on the server
    if (d.type === 'integer' && !/^[-+]?\d{1,18}$/.test(s)) errors[d.name] = 'Enter a whole number';
    if (d.type === 'decimal' && !/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s))
      errors[d.name] = 'Enter a number';
    if (d.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[d.name] = 'Use YYYY-MM-DD';
    if (d.type === 'list' && !d.options?.some((o) => o.value === s))
      errors[d.name] = 'Choose a listed value';
  }
  return errors;
}

export function initialValues(defs: ParameterDef[], prev?: ParameterValues) {
  return Object.fromEntries(
    defs
      .filter((d) => !d.fixed)
      .map((d) => {
        const p = prev?.[d.name];
        return [d.name, p !== undefined && p !== null ? String(p) : (d.defaultValue ?? '')];
      }),
  );
}

interface Props {
  open: boolean;
  onPresetChange?: (defs: ParameterDef[]) => void;
  title: string;
  parameters: ParameterDef[];
  initial?: ParameterValues;
  primaryText?: string;
  serverErrors?: Record<string, string> | null;
  onClose(): void;
  onSubmit(values: ParameterValues): void;
}

export function ParameterFields({
  parameters,
  values,
  errors,
  onChange,
  idPrefix = 'run',
  onChangePreset,
}: {
  parameters: ParameterDef[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange(name: string, v: string): void;
  idPrefix?: string;
  onChangePreset?: (name: string, value: string | null) => void;
}) {
  return (
    <>
      {parameters
        .filter((d) => !d.fixed)
        .map((d) => {
          const id = `${idPrefix}-param-${d.name}`;
          const label = `${d.label}${d.required ? '' : ' (optional)'}`;
          const invalid = Boolean(errors[d.name]);
          if (d.type === 'list')
            return (
              <Select
                key={d.name}
                id={id}
                labelText={label}
                value={values[d.name] ?? ''}
                invalid={invalid}
                invalidText={errors[d.name]}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  onChange(d.name, e.target.value)
                }
              >
                {!d.required && <SelectItem value="" text="(any)" />}
                {(d.options ?? []).map((o) => (
                  <SelectItem key={o.value} value={o.value} text={o.label ?? o.value} />
                ))}
              </Select>
            );
          if (
            d.type === 'date' &&
            (d.datePreset || d.defaultValue?.startsWith('$preset:')) &&
            onChangePreset
          ) {
            const rolling = presetChoice(d);
            const base = d.name.endsWith('_FROM') ? d.name.slice(0, -5) : null;
            if (
              d.name.endsWith('_TO') &&
              parameters.some((p) => p.name === `${d.name.slice(0, -3)}_FROM`)
            )
              return null;
            return (
              <div key={d.name} data-testid={`run-date-range-${idPrefix}`}>
                <DatePresetSelect
                  id={`${id}-preset`}
                  label={`${d.label.replace(/ \(from\)$/, '')} rolling range`}
                  value={rolling}
                  onChange={(v) => onChangePreset(d.name, encodePresetChoice(v))}
                />
                {!rolling.choice && (
                  <TextInput
                    id={id}
                    labelText={label}
                    type="date"
                    value={base ? (values[d.name] ?? '') : (values[d.name] ?? '')}
                    invalid={invalid}
                    invalidText={errors[d.name]}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      onChange(d.name, e.target.value)
                    }
                  />
                )}
                {base && !rolling.choice && (
                  <TextInput
                    id={`${idPrefix}-param-${base}_TO`}
                    labelText={parameters.find((p) => p.name === `${base}_TO`)?.label ?? 'To'}
                    type="date"
                    value={values[`${base}_TO`] ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      onChange(`${base}_TO`, e.target.value)
                    }
                  />
                )}
                {rolling.choice && (
                  <p className="qf-muted">
                    Resolved on the server in its configured time zone on every run. The preset, not
                    a resolved date, is saved.
                  </p>
                )}
              </div>
            );
          }
          return (
            <TextInput
              key={d.name}
              id={id}
              labelText={label}
              type={d.type === 'date' ? 'date' : 'text'}
              inputMode={
                d.type === 'integer' ? 'numeric' : d.type === 'decimal' ? 'decimal' : undefined
              }
              placeholder={d.type === 'date' ? 'YYYY-MM-DD' : (d.defaultValue ?? '')}
              helperText={d.defaultValue ? `Default: ${d.defaultValue}` : undefined}
              value={values[d.name] ?? ''}
              invalid={invalid}
              invalidText={errors[d.name]}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange(d.name, e.target.value)
              }
            />
          );
        })}
    </>
  );
}

/** Local state keeps a prompt choice stable while a builder's background preview refreshes. */
export function RunParamsModal(props: Props) {
  const [parameters, setParameters] = useState(props.parameters);
  useEffect(() => {
    if (!props.open || props.parameters.length === 0) return;
    setParameters((current) =>
      current.length > 0 && current.every((d, i) => d.name === props.parameters[i]?.name)
        ? current
        : props.parameters,
    );
  }, [props.open, props.parameters]);

  return (
    <RunParamsModalForm
      {...props}
      parameters={parameters}
      onPresetChange={(next) => {
        setParameters(next);
        props.onPresetChange?.(next);
      }}
    />
  );
}

function RunParamsModalForm({
  open,
  title,
  parameters,
  initial,
  primaryText = 'Run',
  serverErrors,
  onClose,
  onSubmit,
  onPresetChange,
}: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setValues(initialValues(parameters, initial));
      setErrors({});
    }
  }, [open, parameters, initial]);
  useEffect(() => {
    if (serverErrors) setErrors(serverErrors);
  }, [serverErrors]);
  const submit = () => {
    const e = validateValues(parameters, values);
    setErrors(e);
    if (Object.keys(e).length) return;
    onSubmit(
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim() === '' ? null : v])),
    );
  };
  return (
    <Modal
      open={open}
      modalHeading={title}
      modalLabel="Report parameters"
      primaryButtonText={primaryText}
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={submit}
      size="sm"
    >
      <Form
        onSubmit={(e: React.FormEvent) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack gap={5}>
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Values are sent as bound parameters."
            subtitle="They are validated on the server and never inserted into the SQL text."
          />
          <ParameterFields
            parameters={parameters}
            values={values}
            errors={errors}
            onChange={(n, v) => setValues((p) => ({ ...p, [n]: v }))}
            onChangePreset={(n, v) => {
              const next = setPreset(parameters, n, v);
              onPresetChange?.(next);
              // Once Custom is chosen, old encoded values must not become literal dates.
              const changed = next.filter(
                (d) => d.name === n || (n.endsWith('_FROM') && d.name === `${n.slice(0, -5)}_TO`),
              );
              setValues((p) => ({
                ...p,
                ...Object.fromEntries(changed.map((d) => [d.name, v ?? ''])),
              }));
            }}
          />
        </Stack>
      </Form>
    </Modal>
  );
}
