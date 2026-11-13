import type React from 'react';
import {
  Button,
  Checkbox,
  ComboBox,
  InlineLoading,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  TextInput,
  Toggle,
} from '@carbon/react';
import {
  Close,
  Folder as FolderIcon,
  Group,
  RecentlyViewed,
  User as UserIcon,
} from '@carbon/icons-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type {
  Folder,
  FolderReportGrant,
  FolderShareReports,
  FolderSharing,
  Report,
  Share,
  UserSummary,
} from '../api/types';
import { ErrorNotice } from './ErrorNotice';
import { browserTimeZone, endOfDayIso, isExpired, lastDayOf, todayLocal } from '../utils/expiry';

type Option = { key: string; type: 'USER' | 'GROUP'; id: string; label: string };

/**
 * Owner-only dialog: share a report with users or groups as VIEWER or EDITOR (enforced by the
 * server), each optionally until a chosen day (migration 014).
 */
export function ShareModal({ report, onClose }: { report: Report | null; onClose(): void }) {
  const [grants, setGrants] = useState<FolderReportGrant[]>([]);
  const [mailConfigured, setMailConfigured] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    setGrants([]);
    setMailConfigured(undefined);
  }, [report?.id]);
  return (
    <ShareDialog
      target={report ? { id: report.id, name: report.name } : null}
      load={async (id) => {
        const r = await api.getReportSharing(id);
        setGrants(r.folderGrants);
        setMailConfigured(r.mailConfigured);
        return r.shares;
      }}
      save={(id, shares, notify) => api.putShares(id, shares, notify)}
      mailConfigured={mailConfigured}
      note="Viewers can run and export the report. Editors can also change its SQL, parameters and schedules. Only you (the owner) can share or delete it."
      onClose={onClose}
    >
      <FolderGrantList grants={grants} />
    </ShareDialog>
  );
}

const roleText = (r: 'VIEWER' | 'EDITOR') => (r === 'EDITOR' ? 'Editor' : 'Viewer');

/** Read-only: who reaches a report through one of your folders shared with its reports. */
export function FolderGrantList({ grants }: { grants: FolderReportGrant[] }) {
  if (!grants.length) return null;
  return (
    <div className="qf-share-folders">
      <h3 className="cds--label">Also shared through your folders</h3>
      <StructuredListWrapper aria-label="Access through folders" isCondensed>
        <StructuredListHead>
          <StructuredListRow head>
            <StructuredListCell head>Shared with</StructuredListCell>
            <StructuredListCell head>Access</StructuredListCell>
            <StructuredListCell head>Through folder</StructuredListCell>
          </StructuredListRow>
        </StructuredListHead>
        <StructuredListBody>
          {grants.map((g) => (
            <StructuredListRow key={`${g.folderId}:${g.type}:${g.id}`}>
              <StructuredListCell>
                <span className="qf-share-who">
                  {g.type === 'GROUP' ? <Group /> : <UserIcon />}
                  {g.type === 'GROUP' ? `Group: ${g.id}` : (g.displayName ?? g.id)}
                </span>
              </StructuredListCell>
              <StructuredListCell>{roleText(g.role)}</StructuredListCell>
              <StructuredListCell>
                <span className="qf-share-who">
                  <FolderIcon />
                  {g.folderName}
                </span>
              </StructuredListCell>
            </StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      <p className="qf-muted">
        Change these from the folder&apos;s sharing, or by taking the report out of the folder. They
        never change the shares above.
      </p>
    </div>
  );
}

/**
 * Owner-only dialog: share a folder with users or groups (migration 009). Viewers see the
 * folder; editors can also add, remove and reorder its reports. By default nobody gains
 * access to a report this way; the owner can opt in to also sharing their own reports in the
 * folder (migration 011), capped at view-only or at each person's folder role. The server
 * decides which reports that covers and enforces it.
 */
export function FolderShareModal({
  folder,
  onClose,
  onAudit,
}: {
  folder: Folder | null;
  onClose(saved?: boolean): void;
  /** Open the folder's Access and audit panel instead (unsaved changes are discarded). */
  onAudit?(f: Folder): void;
}) {
  const [info, setInfo] = useState<FolderSharing | null>(null);
  const [shareReports, setShareReports] = useState<FolderShareReports>(null);
  useEffect(() => {
    setInfo(null);
    setShareReports(null);
  }, [folder?.id]);
  return (
    <ShareDialog
      target={folder ? { id: folder.id, name: folder.name } : null}
      load={async (id) => {
        const r = await api.getFolderSharing(id);
        setInfo(r);
        setShareReports(r.shareReports);
        return r.shares;
      }}
      save={(id, shares, notify) => api.putFolderSharing(id, shares, shareReports, notify)}
      mailConfigured={info?.mailConfigured}
      heading="Share folder"
      headerAction={
        onAudit && folder ? (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={RecentlyViewed}
            className="qf-share-audit-link"
            onClick={() => onAudit(folder)}
          >
            View access and audit history
          </Button>
        ) : undefined
      }
      note={`Viewers can see the folder. Editors can also add, remove and reorder its reports. ${
        shareReports
          ? 'The reports listed below are shared with them too.'
          : 'Sharing a folder does not share the reports in it: each person sees only the reports they already have access to.'
      } Only you (the owner) can share, rename or delete it.`}
      onClose={onClose}
    >
      <FolderReportSharing info={info} value={shareReports} onChange={setShareReports} />
    </ShareDialog>
  );
}

const skipText: Record<FolderSharing['reports']['skipped'][number]['reason'], string> = {
  NOT_OWNER: 'only its owner can share it',
  ADDED_BY_OTHER: 'added by someone else; add it to the folder yourself to share it',
};

/** The folder owner's "also share the reports in this folder" option and what it covers. */
export function FolderReportSharing({
  info,
  value,
  onChange,
}: {
  info: FolderSharing | null;
  value: FolderShareReports;
  onChange(v: FolderShareReports): void;
}) {
  if (!info) return null;
  const { included, skipped } = info.reports;
  const n = included.length;
  return (
    <fieldset className="qf-share-reports">
      <legend className="cds--label">Reports in this folder</legend>
      <Toggle
        id="share-folder-reports"
        labelText="Also share the reports in this folder"
        labelA="Off"
        labelB="On"
        toggled={value !== null}
        onToggle={(on: boolean) => onChange(on ? 'VIEWER' : null)}
      />
      {value !== null && (
        <>
          <RadioButtonGroup
            legendText="Access to the reports"
            name="share-folder-reports-role"
            orientation="vertical"
            valueSelected={value}
            onChange={(v: string | number | undefined) =>
              onChange(v === 'EDITOR' ? 'EDITOR' : 'VIEWER')
            }
          >
            <RadioButton
              id="share-reports-viewer"
              value="VIEWER"
              labelText="View only, for everyone"
            />
            <RadioButton
              id="share-reports-editor"
              value="EDITOR"
              labelText="Match their folder access (folder editors can also edit the reports)"
            />
          </RadioButtonGroup>
          <p className="qf-muted">
            {n === 0
              ? 'None of your reports are in this folder yet.'
              : `${n} of your report${n === 1 ? '' : 's'} in this folder will be shared with the people above.`}{' '}
            Reports you add later are shared too; taking a report out of the folder, removing a
            person or turning this off ends only the access that came through the folder. Shares you
            made on a report itself are never changed, and stronger ones are kept.
          </p>
          {skipped.length > 0 && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title={`${skipped.length} report${skipped.length === 1 ? '' : 's'} won't be shared`}
              subtitle="Everything else in the folder is shared as described above."
            >
              <ul aria-label="Reports not shared through this folder">
                {skipped.map((x) => (
                  <li key={x.id}>
                    {x.name}
                    {x.reason === 'NOT_OWNER' && x.ownerName
                      ? ` (owned by ${x.ownerName})`
                      : ''}: {skipText[x.reason]}
                  </li>
                ))}
              </ul>
            </InlineNotification>
          )}
        </>
      )}
    </fieldset>
  );
}

function ShareDialog({
  target,
  load,
  save: saveShares,
  heading,
  note,
  headerAction,
  mailConfigured,
  onClose,
  children,
}: {
  target: { id: string; name: string } | null;
  load(id: string): Promise<Share[]>;
  /** `notify`: e-mail people who gain access or change role ("Notify people", migration 015). */
  save(id: string, shares: Share[], notify: boolean): Promise<unknown>;
  /** Whether the server can send e-mail; undefined while not known. Never any SMTP setting. */
  mailConfigured?: boolean;
  heading?: string;
  note: string;
  /** Shown under the note, e.g. a link to the folder's access and audit panel. */
  headerAction?: ReactNode;
  onClose(saved?: boolean): void;
  /** Extra sections under the list (folder report sharing, access through folders). */
  children?: ReactNode;
}) {
  const report = target;
  const [shares, setShares] = useState<Share[] | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [term, setTerm] = useState('');
  const [pick, setPick] = useState<Option | null>(null);
  const [role, setRole] = useState<Share['role']>('VIEWER');
  const [until, setUntil] = useState('');
  /** Expiry of each share as loaded, so an unchanged (even expired) one is never flagged. */
  const [loaded, setLoaded] = useState<Map<string, string | null>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** "Notify people": on by default each time the dialog opens. */
  const [notify, setNotify] = useState(true);

  useEffect(() => {
    if (!report) return;
    setNotify(true);
    setShares(null);
    setError(null);
    setPick(null);
    setUntil('');
    Promise.all([load(report.id), api.groups()])
      .then(([s, g]) => {
        setShares(s);
        setLoaded(new Map(s.map((x) => [`${x.type}:${x.id}`, x.expiresAt ?? null])));
        setGroups(g);
      })
      .catch((e) => {
        setError(e);
        setShares([]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report?.id]);

  useEffect(() => {
    if (!term.trim()) return setUsers([]);
    const t = setTimeout(() => {
      api
        .searchUsers(term)
        .then(setUsers)
        .catch(() => setUsers([]));
    }, 200);
    return () => clearTimeout(t);
  }, [term]);

  const options: Option[] = [
    ...users.map((u) => ({
      key: `USER:${u.id}`,
      type: 'USER' as const,
      id: u.id,
      label: `${u.displayName} (${u.username})`,
    })),
    ...groups
      .filter((g) => !term || g.includes(term.toLowerCase()))
      .map((g) => ({ key: `GROUP:${g}`, type: 'GROUP' as const, id: g, label: `Group: ${g}` })),
  ].filter((o) => !shares?.some((s) => s.type === o.type && s.id === o.id));

  const today = todayLocal();
  const untilBad = until !== '' && (until < today || !endOfDayIso(until));
  const add = () => {
    if (!pick || !shares || untilBad) return;
    setShares([
      ...shares,
      {
        type: pick.type,
        id: pick.id,
        role,
        displayName: pick.label,
        expiresAt: until ? endOfDayIso(until) : null,
      },
    ]);
    setPick(null);
    setTerm('');
    setUntil('');
  };
  const setExpiry = (i: number, expiresAt: string | null) =>
    setShares((cur) => cur && cur.map((x, j) => (j === i ? { ...x, expiresAt } : x)));
  /** A new or changed expiry that has already passed: the server would refuse it. */
  const badExpiry = (s: Share) =>
    Boolean(s.expiresAt) &&
    s.expiresAt !== loaded.get(`${s.type}:${s.id}`) &&
    isExpired(s.expiresAt);
  const expiredCount = shares?.filter((s) => isExpired(s.expiresAt)).length ?? 0;
  const invalid = Boolean(shares?.some(badExpiry));

  const save = async () => {
    if (!report || !shares || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await saveShares(report.id, shares, notify && mailConfigured !== false);
      onClose(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(report)}
      modalHeading={`${heading ?? 'Share'} "${report?.name ?? ''}"`}
      modalLabel="Sharing"
      primaryButtonText={busy ? 'Saving…' : 'Save sharing'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || !shares || invalid}
      onRequestClose={() => onClose()}
      onRequestSubmit={save}
      size="lg"
    >
      <Stack gap={5}>
        <p className="qf-muted">{note}</p>
        {headerAction && <div>{headerAction}</div>}
        <ErrorNotice error={error} />
        <div className="qf-share-add">
          <ComboBox
            id="share-target"
            titleText="Add a user or group"
            placeholder="Search by name or username"
            items={options}
            itemToString={(o: Option | null) => o?.label ?? ''}
            selectedItem={pick}
            onInputChange={(v: string) => setTerm(v ?? '')}
            onChange={({ selectedItem }: { selectedItem: Option | null }) => setPick(selectedItem)}
          />
          <Select
            id="share-role"
            labelText="Access"
            value={role}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
              setRole(e.target.value as Share['role'])
            }
          >
            <SelectItem value="VIEWER" text="Viewer" />
            <SelectItem value="EDITOR" text="Editor" />
          </Select>
          <TextInput
            id="share-until"
            type="date"
            labelText="Until (optional)"
            value={until}
            min={today}
            invalid={untilBad}
            invalidText="Pick today or a later day."
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setUntil(e.target.value)}
          />
          <Button kind="tertiary" onClick={add} disabled={!pick || untilBad}>
            Add
          </Button>
        </div>
        <p className="qf-muted qf-share-expiry-hint">
          A share with an end date works until the end of that day ({browserTimeZone()}), then stops
          on its own. Leave it empty for no end date.
        </p>
        {expiredCount > 0 && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title={`${expiredCount} share${expiredCount === 1 ? ' has' : 's have'} expired`}
            subtitle="Expired shares give no access. Pick a new end date or choose No end date to renew one, or remove it."
          />
        )}
        {shares === null ? (
          <InlineLoading description="Loading shares…" />
        ) : shares.length === 0 ? (
          <p className="qf-muted">Not shared with anyone yet.</p>
        ) : (
          <StructuredListWrapper aria-label="Current shares" isCondensed>
            <StructuredListHead>
              <StructuredListRow head>
                <StructuredListCell head>Shared with</StructuredListCell>
                <StructuredListCell head>Access</StructuredListCell>
                <StructuredListCell head>Until</StructuredListCell>
                <StructuredListCell head> </StructuredListCell>
              </StructuredListRow>
            </StructuredListHead>
            <StructuredListBody>
              {shares.map((s, i) => (
                <StructuredListRow key={`${s.type}:${s.id}`}>
                  <StructuredListCell>
                    <span className="qf-share-who">
                      {s.type === 'GROUP' ? <Group /> : <UserIcon />}
                      {s.type === 'GROUP' ? `Group: ${s.id}` : (s.displayName ?? s.id)}
                      {isExpired(s.expiresAt) && (
                        <Tag size="sm" type="red">
                          Expired
                        </Tag>
                      )}
                    </span>
                  </StructuredListCell>
                  <StructuredListCell>
                    <Select
                      id={`role-${i}`}
                      labelText=""
                      hideLabel
                      size="sm"
                      value={s.role}
                      onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                        setShares(
                          shares.map((x, j) =>
                            j === i ? { ...x, role: e.target.value as Share['role'] } : x,
                          ),
                        )
                      }
                    >
                      <SelectItem value="VIEWER" text="Viewer" />
                      <SelectItem value="EDITOR" text="Editor" />
                    </Select>
                  </StructuredListCell>
                  <StructuredListCell>
                    <div className="qf-share-expiry">
                      <TextInput
                        id={`expiry-${i}`}
                        type="date"
                        size="sm"
                        labelText={`Access until, ${s.type === 'GROUP' ? `group ${s.id}` : (s.displayName ?? s.id)}`}
                        hideLabel
                        value={lastDayOf(s.expiresAt)}
                        min={today}
                        invalid={badExpiry(s)}
                        invalidText="Pick today or a later day."
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                          setExpiry(i, e.target.value ? endOfDayIso(e.target.value) : null)
                        }
                      />
                      {s.expiresAt ? (
                        <Button kind="ghost" size="sm" onClick={() => setExpiry(i, null)}>
                          No end date
                        </Button>
                      ) : (
                        <span className="qf-muted">No end date</span>
                      )}
                    </div>
                  </StructuredListCell>
                  <StructuredListCell>
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={Close}
                      iconDescription="Remove access"
                      onClick={() => setShares(shares.filter((_, j) => j !== i))}
                    />
                  </StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
        )}
        {children}
        <div className="qf-share-notify">
          <Checkbox
            id="share-notify"
            labelText="Notify people by e-mail"
            checked={notify && mailConfigured !== false}
            disabled={mailConfigured === false}
            onChange={(_e: unknown, { checked }: { checked: boolean }) => setNotify(checked)}
          />
          <p className="qf-muted">
            {mailConfigured === false
              ? "E-mail isn't set up on this server, so nobody will be notified. Sharing still works."
              : 'People who gain access or whose role changes get an e-mail saying who shared what, the access and any end date. Anyone who turned off share e-mails in Account is skipped.'}
          </p>
        </div>
        <p className="qf-muted">Changes take effect when you save.</p>
      </Stack>
    </Modal>
  );
}
