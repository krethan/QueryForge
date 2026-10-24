import type React from 'react';
import {
  Button,
  ComboBox,
  InlineLoading,
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import { Close, Group, User as UserIcon } from '@carbon/icons-react';
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Report, Share, UserSummary } from '../api/types';
import { ErrorNotice } from './ErrorNotice';

type Option = { key: string; type: 'USER' | 'GROUP'; id: string; label: string };

/** Owner-only dialog: share a report with users or groups as VIEWER or EDITOR (enforced by the server). */
export function ShareModal({ report, onClose }: { report: Report | null; onClose(): void }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [term, setTerm] = useState('');
  const [pick, setPick] = useState<Option | null>(null);
  const [role, setRole] = useState<Share['role']>('VIEWER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!report) return;
    setShares(null);
    setError(null);
    setPick(null);
    Promise.all([api.getShares(report.id), api.groups()])
      .then(([s, g]) => {
        setShares(s);
        setGroups(g);
      })
      .catch((e) => {
        setError(e);
        setShares([]);
      });
  }, [report]);

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

  const add = () => {
    if (!pick || !shares) return;
    setShares([...shares, { type: pick.type, id: pick.id, role, displayName: pick.label }]);
    setPick(null);
    setTerm('');
  };

  const save = async () => {
    if (!report || !shares) return;
    setBusy(true);
    setError(null);
    try {
      await api.putShares(report.id, shares);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(report)}
      modalHeading={`Share "${report?.name ?? ''}"`}
      modalLabel="Sharing"
      primaryButtonText={busy ? 'Saving…' : 'Save sharing'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || !shares}
      onRequestClose={onClose}
      onRequestSubmit={save}
      size="md"
    >
      <Stack gap={5}>
        <p className="qf-muted">
          Viewers can run and export the report. Editors can also change its SQL, parameters and
          schedules. Only you (the owner) can share or delete it.
        </p>
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
          <Button kind="tertiary" onClick={add} disabled={!pick}>
            Add
          </Button>
        </div>
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
        <p className="qf-muted">Changes take effect when you save.</p>
      </Stack>
    </Modal>
  );
}
