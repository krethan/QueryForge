import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import type { UserRepository } from '../auth/users.js';
import type { Mailer } from '../mail/mailer.js';
import { checkRecipients } from '../mail/mailer.js';
import type { AccessService } from '../sharing/access.js';
import type { ExecutionService } from '../sql/execution-service.js';
import { sanitizeErrorMessage } from '../util/errors.js';
import { nextRun } from './cron.js';
import type { Schedule, ScheduleRepository } from './schedules.js';

export const SCHEDULER_LOCK = 'SCHEDULER';

export interface RunResult {
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  rowCount?: number;
  disabled: boolean;
}

/**
 * In-process scheduler. Every poll it acquires/renews a Db2 for i lease row (QF_LOCKS) so only
 * one app instance acts as leader, then claims each due schedule with a conditional UPDATE on
 * NEXT_RUN_AT so a run can't execute twice even if two leaders briefly overlap.
 * Runs execute with the report owner's authority and are recorded in QF_EXECUTIONS.
 */
export class Scheduler {
  readonly instanceId = `qf-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;

  constructor(
    private readonly cfg: AppConfig,
    private readonly schedules: ScheduleRepository,
    private readonly users: UserRepository,
    private readonly access: AccessService,
    private readonly execution: ExecutionService,
    private readonly mailer: Mailer | undefined,
  ) {}

  start() {
    this.stopped = false;
    const loop = () => {
      void this.tick().finally(() => {
        if (!this.stopped) this.timer = setTimeout(loop, this.cfg.scheduler.pollMs).unref();
      });
    };
    this.timer = setTimeout(loop, 1000).unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.schedules.releaseLease(SCHEDULER_LOCK, this.instanceId).catch(() => undefined);
  }

  /** One poll. Returns the ids of schedules this instance ran. */
  async tick(now: Date = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const ran: string[] = [];
    try {
      const leader = await this.schedules.acquireLease(
        SCHEDULER_LOCK,
        this.instanceId,
        now,
        this.cfg.scheduler.leaseMs,
      );
      if (!leader) return ran;
      for (const s of await this.schedules.due(now)) {
        let next: Date | null = null;
        try {
          next = nextRun(s.cron, s.timezone, now);
        } catch {
          next = null;
        }
        if (!(await this.schedules.claim(s, next, now))) continue;
        ran.push(s.id);
        await this.run(s);
      }
    } catch (e) {
      console.error('scheduler tick failed:', sanitizeErrorMessage(e));
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  /** Execute one schedule now (also used by "Run now"). Never throws. */
  async run(s: Schedule): Promise<RunResult> {
    let rowCount: number | undefined;
    try {
      const ownerRole = await this.ownerFor(s);
      const rc = checkRecipients(s.recipients, this.cfg.scheduler);
      if (!rc.ok) throw new Error(rc.message);
      if (!this.mailer) throw new Error('Email delivery is not configured (SMTP_HOST).');
      const file = await this.execution.exportXlsx(
        ownerRole,
        { reportId: s.reportId, values: s.parameters },
        { scheduleId: s.id },
      );
      try {
        rowCount = file.rowCount;
        await this.mailer.send({
          to: rc.recipients,
          subject: `QueryForge: ${s.reportName ?? 'Scheduled report'}`,
          text:
            `Attached is the scheduled report "${s.reportName ?? s.reportId}".\n` +
            `Rows: ${file.rowCount}${file.truncated ? ' (limited by the export row limit)' : ''}\n` +
            `Generated at ${new Date().toISOString()} (UTC).\n`,
          attachments: [{ filename: file.filename, path: file.path }],
        });
      } finally {
        await file.cleanup();
      }
      await this.schedules.recordResult(s.id, {
        status: 'SUCCEEDED',
        error: null,
        failures: 0,
        disable: false,
      });
      return { status: 'SUCCEEDED', error: null, rowCount, disabled: false };
    } catch (e) {
      const error = sanitizeErrorMessage(e);
      const failures = s.failureCount + 1;
      const disable = failures >= this.cfg.scheduler.maxFailures;
      await this.schedules
        .recordResult(s.id, { status: 'FAILED', error, failures, disable })
        .catch((x) => console.error('schedule result not recorded:', sanitizeErrorMessage(x)));
      return { status: 'FAILED', error, rowCount, disabled: disable };
    }
  }

  /** The owner must still be active, and the schedule creator must still have edit rights. */
  private async ownerFor(s: Schedule) {
    const creator = await this.users.findById(s.createdBy);
    if (!creator)
      throw new Error('The user who created this schedule is disabled or no longer exists.');
    const { report, access: role } = await this.access.require(creator, s.reportId, 'EDIT');
    if (role === 'OWNER') return creator;
    const owner = await this.users.findById(report.ownerId);
    if (!owner) throw new Error('The report owner is disabled or no longer exists.');
    return owner;
  }
}
