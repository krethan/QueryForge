import type React from 'react';
import { Button, Checkbox, Modal, Select, SelectItem, Tag, TextInput } from '@carbon/react';
import {
  Checkmark,
  Close,
  Edit,
  FolderAdd,
  RecentlyViewed,
  Share,
  TrashCan,
} from '@carbon/icons-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { Folder, Report } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

export const UNFILED = '__unfiled__';

/** Folders without an `access` field (older responses) are the caller's own. */
export const ownsFolder = (f: Folder) => !f.access || f.access === 'OWNER';
/** Owners, editors and admins may add, remove and reorder a folder's reports. */
export const canEditFolder = (f: Folder) => !f.access || f.access !== 'VIEWER';
export const roleLabel = (a?: string) =>
  a === 'ADMIN' ? 'Admin' : a === 'EDITOR' ? 'Editor' : a === 'VIEWER' ? 'Viewer' : 'Owner';
/** How a folder is named in lists: other people's folders carry their owner's name. */
export const folderLabel = (f: Folder) =>
  ownsFolder(f) ? f.name : `${f.name} (${f.ownerName || 'another user'})`;

/**
 * Create, rename, share and delete the signed-in user's own folders, and list the folders
 * other people share with them (read-only here).
 */
export function ManageFoldersModal({
  open,
  folders,
  counts,
  onClose,
  onChanged,
  onShare,
  onAudit,
}: {
  open: boolean;
  folders: Folder[];
  /** Open the share dialog for one of your folders (rendered by the page, not nested here). */
  onShare?(f: Folder): void;
  /**
   * Open a folder's Access and audit panel (rendered by the page). Offered for your own folders
   * and, for admins, folders shared with anyone; the server enforces the same rule.
   */
  onAudit?(f: Folder): void;
  /** Number of the user's visible reports in each folder. */
  counts: Map<string, number>;
  onClose(): void;
  onChanged(): void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = folders.filter(ownsFolder);
  const others = folders.filter((f) => !ownsFolder(f));
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
        Folders are yours alone until you share one. Sharing a folder does not share the reports in
        it unless you turn that on when you share it: otherwise each person sees only the reports
        they already have access to.
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
      {mine.length === 0 ? (
        <p className="qf-folders__empty">You have no folders yet.</p>
      ) : (
        <ul className="qf-folders__list" aria-label="Your folders">
          {mine.map((f) => (
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
                    {f.shared && ' People it is shared with lose access to the folder.'}
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
                  <span className="qf-folders__name">
                    {f.name}
                    {f.shared && (
                      <Tag size="sm" type="purple">
                        Shared
                      </Tag>
                    )}
                    {f.shared && f.shareReports && (
                      <Tag size="sm" type="teal">
                        Reports shared
                      </Tag>
                    )}
                  </span>
                  <span className="qf-folders__count">{counts.get(f.id) ?? 0} reports</span>
                  {onShare && (
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={Share}
                      iconDescription={`Share ${f.name}`}
                      onClick={() => onShare(f)}
                    />
                  )}
                  {onAudit && (
                    <Button
                      size="sm"
                      kind="ghost"
                      hasIconOnly
                      renderIcon={RecentlyViewed}
                      iconDescription={`Access and audit for ${f.name}`}
                      onClick={() => onAudit(f)}
                    />
                  )}
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
      {others.length > 0 && (
        <>
          <h3 className="qf-folders__heading">Shared with you</h3>
          <ul className="qf-folders__list" aria-label="Folders shared with you">
            {others.map((f) => (
              <li key={f.id} className="qf-folders__item">
                <span className="qf-folders__name">
                  {f.name}
                  {f.shareReports && (
                    <Tag size="sm" type="teal">
                      Reports shared
                    </Tag>
                  )}
                </span>
                <span className="qf-folders__count">
                  {f.ownerName || 'Another user'} · {roleLabel(f.access)} · {counts.get(f.id) ?? 0}{' '}
                  reports
                </span>
                {onAudit && f.access === 'ADMIN' && (
                  <Button
                    size="sm"
                    kind="ghost"
                    hasIconOnly
                    renderIcon={RecentlyViewed}
                    iconDescription={`Access and audit for ${f.name}`}
                    onClick={() => onAudit(f)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/**
 * Put one report into one of the user's own folders (or back into Unfiled), and into or out of
 * shared folders the user can edit. Only folders the server listed for the user are offered,
 * and the server checks the user can see the report and edit the folder.
 */
export function MoveToFolderModal({
  report,
  folders,
  onClose,
  onMoved,
}: {
  report: Report | null;
  folders: Folder[];
  onClose(): void;
  onMoved(folderId: string | null, sharedChanged?: boolean): void;
}) {
  const mine = folders.filter(ownsFolder);
  const sharedEditable = folders.filter((f) => !ownsFolder(f) && canEditFolder(f));
  const inShared = (f: Folder) => !!report && !!f.reportIds?.includes(report.id);
  // A report placed in one of your own (shared) folders by someone else counts as filed there.
  const current =
    report?.folderId ?? mine.find((f) => report && f.reportIds?.includes(report.id))?.id ?? UNFILED;
  const [target, setTarget] = useState<string | null>(null);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = target ?? current;
  const sharedChanges = sharedEditable.filter(
    (f) => toggled[f.id] !== undefined && toggled[f.id] !== inShared(f),
  );
  const reset = () => {
    setTarget(null);
    setToggled({});
    setError(null);
  };
  return (
    <Modal
      open={Boolean(report)}
      modalHeading={`Move "${report?.name ?? ''}"`}
      primaryButtonText={busy ? 'Moving…' : 'Move'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || (value === current && sharedChanges.length === 0)}
      onRequestClose={() => {
        reset();
        onClose();
      }}
      onRequestSubmit={async () => {
        if (!report) return;
        setBusy(true);
        try {
          const folderId = value === UNFILED ? null : value;
          if (value !== current) await api.setReportPrefs(report.id, { folderId });
          for (const f of sharedChanges)
            await (toggled[f.id]
              ? api.addToFolder(f.id, report.id)
              : api.removeFromFolder(f.id, report.id));
          reset();
          onMoved(
            value === current ? (report.folderId ?? null) : folderId,
            sharedChanges.length > 0,
          );
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
        {mine.map((f) => (
          <SelectItem key={f.id} value={f.id} text={f.shared ? `${f.name} (shared)` : f.name} />
        ))}
      </Select>
      {mine.length === 0 && (
        <p className="qf-folders__note">Create folders with “Manage folders” on the dashboard.</p>
      )}
      {sharedEditable.length > 0 && (
        <fieldset className="qf-folders__shared">
          <legend className="cds--label">Shared folders you can edit</legend>
          {sharedEditable.map((f) => (
            <Checkbox
              key={f.id}
              id={`shared-folder-${f.id}`}
              labelText={folderLabel(f)}
              checked={toggled[f.id] ?? inShared(f)}
              onChange={(_e: unknown, { checked }: { checked: boolean }) =>
                setToggled((t) => ({ ...t, [f.id]: checked }))
              }
            />
          ))}
          <p className="qf-folders__note">
            Adding a report to a shared folder does not share the report: people in the folder see
            it only if it is shared with them, or if it is your own report and you chose to share
            the folder&apos;s reports.
          </p>
        </fieldset>
      )}
    </Modal>
  );
}
