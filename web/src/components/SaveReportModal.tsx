import type React from 'react';
import { InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { useEffect, useState } from 'react';

export interface SaveValues {
  name: string;
  description: string;
  category: string;
}

interface Props {
  open: boolean;
  initial: SaveValues;
  saving: boolean;
  error?: string | null;
  title: string;
  onClose(): void;
  onSave(v: SaveValues): void;
}

export function SaveReportModal({ open, initial, saving, error, title, onClose, onSave }: Props) {
  const [v, setV] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (open) {
      setV(initial);
      setTouched(false);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameError = !v.name.trim()
    ? 'Report name is required.'
    : v.name.trim().length > 128
      ? 'Use 128 characters or fewer.'
      : '';
  const submit = () => {
    setTouched(true);
    if (!nameError) onSave(v);
  };

  return (
    <Modal
      open={open}
      modalHeading={title}
      primaryButtonText={saving ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={saving}
      onRequestClose={onClose}
      onRequestSubmit={submit}
      shouldSubmitOnEnter={false}
      size="md"
    >
      <div className="qf-form">
        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not save."
            subtitle={error}
          />
        )}
        <TextInput
          id="report-name"
          labelText="Report name"
          value={v.name}
          maxLength={128}
          invalid={touched && Boolean(nameError)}
          invalidText={nameError}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setV({ ...v, name: e.target.value })
          }
          data-modal-primary-focus
        />
        <TextArea
          id="report-description"
          labelText="Description (optional)"
          value={v.description}
          maxCount={2000}
          enableCounter
          rows={3}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setV({ ...v, description: e.target.value })
          }
        />
        <TextInput
          id="report-category"
          labelText="Category (optional)"
          value={v.category}
          maxLength={128}
          onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            setV({ ...v, category: e.target.value })
          }
        />
      </div>
    </Modal>
  );
}
