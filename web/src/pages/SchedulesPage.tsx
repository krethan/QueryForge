import { Button, DataTableSkeleton } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Report, Schedule, ScheduleSettings } from '../api/types';
import { ErrorNotice } from '../components/ErrorNotice';
import { ScheduleList } from '../components/ScheduleList';

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [settings, setSettings] = useState<ScheduleSettings | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [newRequest, setNewRequest] = useState(0);
  // "/schedules?history=<id>" (a failed-delivery notification) opens that delivery history.
  const [params] = useSearchParams();

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.listSchedules(), api.listAllReports()]);
      setSchedules(s.schedules);
      setSettings(s.settings);
      setReports([
        ...r.owned,
        ...r.shared.filter((x) => x.access === 'EDITOR' || x.access === 'ADMIN'),
      ]);
    } catch (e) {
      setError(e);
      setSchedules([]);
    }
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <div className="qf-page-header">
        <div>
          <h1>Schedules</h1>
          <p>Reports that run automatically and are e-mailed as Excel files.</p>
        </div>
        <Button
          renderIcon={Add}
          onClick={() => setNewRequest((n) => n + 1)}
          disabled={!reports.length}
        >
          New schedule
        </Button>
      </div>
      <ErrorNotice error={error} onClose={() => setError(null)} />
      {schedules === null ? (
        <DataTableSkeleton columnCount={6} rowCount={3} showToolbar={false} />
      ) : (
        <ScheduleList
          schedules={schedules}
          settings={settings}
          reports={reports}
          showReport
          newRequest={newRequest}
          emptyText="Open a report you own or can edit and choose “Schedule”, or create one here."
          onChanged={load}
          openHistoryFor={params.get('history')}
        />
      )}
    </>
  );
}
