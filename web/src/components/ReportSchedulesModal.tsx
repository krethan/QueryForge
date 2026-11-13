import { Button, DataTableSkeleton, Modal } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Report, Schedule, ScheduleSettings } from '../api/types';
import { ErrorNotice } from './ErrorNotice';
import { ScheduleList } from './ScheduleList';

interface Props {
  report: Report | null;
  onClose(): void;
}

/** Schedules of one report, opened from the report page's "Schedule" button. */
export function ReportSchedulesModal({ report, onClose }: Props) {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [settings, setSettings] = useState<ScheduleSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [newRequest, setNewRequest] = useState(0);
  const [childOpen, setChildOpen] = useState(false);
  const id = report?.id;

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.reportSchedules(id);
      setSchedules(r.schedules);
      setSettings(r.settings);
    } catch (e) {
      setError(e);
      setSchedules([]);
    }
  }, [id]);

  useEffect(() => {
    setSchedules(null);
    setError(null);
    void load();
  }, [load]);

  return (
    <>
      <Modal
        open={Boolean(report) && !childOpen}
        passiveModal
        size="lg"
        modalHeading="Scheduled delivery"
        modalLabel={report?.name}
        onRequestClose={onClose}
      >
        <div className="qf-page-header">
          <p>Run this report on a schedule and e-mail the Excel file.</p>
          <Button
            size="sm"
            renderIcon={Add}
            disabled={schedules === null}
            onClick={() => setNewRequest((n) => n + 1)}
          >
            New schedule
          </Button>
        </div>
        <ErrorNotice error={error} onClose={() => setError(null)} />
        {schedules === null ? (
          <DataTableSkeleton columnCount={5} rowCount={2} showToolbar={false} />
        ) : (
          report && (
            <ScheduleList
              schedules={schedules}
              settings={settings}
              report={report}
              newRequest={newRequest}
              emptyText="Choose “New schedule” to e-mail this report as an Excel file every day, week or month."
              onChanged={load}
              onDialogChange={setChildOpen}
            />
          )
        )}
      </Modal>
    </>
  );
}
