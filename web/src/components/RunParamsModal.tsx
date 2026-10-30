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
import type { ParameterDef, ParameterValues } from '../api/types';

/** Client-side checks for fast feedback. The server re-validates every value before binding. */
export function validateValues(defs: ParameterDef[], v: Record<string, string>) {
  const errors: Record<string, string> = {};
  for (const d of defs) {
    if (d.fixed) continue;
    const s = (v[d.name] ?? '').trim();
    if (!s) {
      if (d.required && !d.defaultValue) errors[d.name] = `${d.label} is required`;
      continue;
    }
    if (d.type === 'integer' && !/^[-+]?\d{1,18}$/.test(s)) errors[d.name] = 'Enter a whole number';
    if (d.type === 'decimal' && !/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(s))
      errors[d.name] = 'Enter a number';
    if (d.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) errors[d.name] = 'Use YYYY-MM-DD';
    if (d.type === 'list' && !d.options?.some((o) => o.value === s))
      errors[d.name] = 'Choose a listed value';
  }
  return errors;
}

export function initialValues(
  defs: ParameterDef[],
  prev?: ParameterValues,
): Record<string, string> {
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
}: {
  parameters: ParameterDef[];
  values: Record<string, string>;
  errors: Record<string, string>;
  onChange(name: string, v: string): void;
  idPrefix?: string;
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

/** Carbon run form shown before a parameterized report runs. */
export function RunParamsModal({
  open,
  title,
  parameters,
  initial,
  primaryText = 'Run',
  serverErrors,
  onClose,
  onSubmit,
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
          />
        </Stack>
      </Form>
    </Modal>
  );
}
