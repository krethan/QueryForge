import type React from 'react';
import { Button, Modal, Select, SelectItem, TextInput } from '@carbon/react';
import { Checkmark, Close, Edit, FolderAdd, TrashCan } from '@carbon/icons-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

export const UNFILED = '__unfiled__';

/** Create, rename and delete the signed-in user's own folders. */
export function ManageFoldersModal({
  open,
  folders,
  counts,
  onClose,
  onChanged,
}: {
  open: boolean;
  folders: Folder[];
  /** Number of the user's visible reports in each folder. */
  counts: Map<string, number>;
  onClose(): void;
  onChanged(): void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const create = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return;
    if (await run(() => api.createFolder(name.trim()))) setName('');
  };
  return (
    <Modal
      open={open}
      passiveModal
      modalHeading="Manage folders"
      onRequestClose={() => {
        setEditing(null);
        setConfirmDelete(null);
        setError(null);
        onClose();
      }}
    >
      <p className="qf-folders__note">
        Folders are yours alone: other people see their own folders, even for reports you share.
      </p>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      <form className="qf-folders__new" onSubmit={create}>
        <TextInput
          id="new-folder"
          labelText="New folder name"
          value={name}
          maxLength={128}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
        />
        <Button type="submit" size="md" renderIcon={FolderAdd} disabled={busy || !name.trim()}>
          Create folder
        </Button>
      </form>
      {folders.length === 0 ? (
        <p className="qf-folders__empty">You have no folders yet.</p>
      ) : (
        <ul className="qf-folders__list" aria-label="Your folders">
          {folders.map((f) => (
            <li key={f.id} className="qf-folders__item">
              {editing?.id === f.id ? (
                <form
                  className="qf-folders__rename"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(() => api.renameFolder(f.id, editing.name.trim())))
                      setEditing(null);
                  }}
                >
                  <TextInput
                    id={`rename-${f.id}`}
                    labelText={`Rename ${f.name}`}
                    hideLabel
                    size="sm"
                    maxLength={128}
                    value={editing.name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setEditing({ id: f.id, name: e.target.value })
                    }
                  />
                  <Button
                    type="submit"
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={Checkmark}
                    iconDescription="Save name"
                    disabled={busy || !editing.name.trim()}
                  />
                  <Button
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={Close}
                    iconDescription="Cancel rename"
                    onClick={() => setEditing(null)}
                  />
                </form>
              ) : confirmDelete?.id === f.id ? (
                <div className="qf-folders__confirm" role="alert">
                  <span>
                    Delete “{f.name}”? Its {counts.get(f.id) ?? 0} report(s) move to Unfiled. No
                    report is deleted.
                  </span>
                  <Button
                    size="sm"
                    kind="danger"
                    disabled={busy}
                    onClick={async () => {
                      if (await run(() => api.deleteFolder(f.id))) setConfirmDelete(null);
                    }}
                  >
                    Delete folder
                  </Button>
                  <Button size="sm" kind="ghost" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <>
                  <span className="qf-folders__name">{f.name}</span>
                  <span className="qf-folders__count">{counts.get(f.id) ?? 0} reports</span>
                  <Button
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={Edit}
                    iconDescription={`Rename ${f.name}`}
                    onClick={() => setEditing({ id: f.id, name: f.name })}
                  />
                  <Button
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={TrashCan}
                    iconDescription={`Delete ${f.name}`}
                    onClick={() => setConfirmDelete(f)}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Put one report into one of the user's folders, or back into Unfiled. */
export function MoveToFolderModal({
  report,
  folders,
  onClose,
  onMoved,
}: {
  report: Report | null;
  folders: Folder[];
  onClose(): void;
  onMoved(folderId: string | null): void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = target ?? report?.folderId ?? UNFILED;
  return (
    <Modal
      open={Boolean(report)}
      modalHeading={`Move "${report?.name ?? ''}"`}
      primaryButtonText={busy ? 'Moving…' : 'Move'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || value === (report?.folderId ?? UNFILED)}
      onRequestClose={() => {
        setTarget(null);
        setError(null);
        onClose();
      }}
      onRequestSubmit={async () => {
        if (!report) return;
        setBusy(true);
        try {
          const folderId = value === UNFILED ? null : value;
          await api.setReportPrefs(report.id, { folderId });
          setTarget(null);
          setError(null);
          onMoved(folderId);
        } catch (e) {
          setError(e);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ErrorNotice error={error} />
      <Select
        id="move-folder"
        labelText="Folder"
        value={value}
        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setTarget(e.target.value)}
      >
        <SelectItem value={UNFILED} text="Unfiled" />
        {folders.map((f) => (
          <SelectItem key={f.id} value={f.id} text={f.name} />
        ))}
      </Select>
      {folders.length === 0 && (
        <p className="qf-folders__note">Create folders with “Manage folders” on the dashboard.</p>
      )}
    </Modal>
  );
}
