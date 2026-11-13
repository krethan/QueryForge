import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import type { UserRepository } from '../auth/users.js';
import type { MailAttachment, Mailer } from '../mail/mailer.js';
import { checkRecipients } from '../mail/mailer.js';
import type { AccessService } from '../sharing/access.js';
import type { ExecutionService } from '../sql/execution-service.js';
import { sanitizeErrorMessage } from '../util/errors.js';
import { nextRun } from './cron.js';
import type { RecipientService } from './recipients.js';
import type { DeliveryTrigger, Schedule, ScheduleRepository } from './schedules.js';

export const SCHEDULER_LOCK = 'SCHEDULER';
const CHART_CID = 'chart@uncle-bob';
const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface RunResult {
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  rowCount?: number;
  disabled: boolean;
  /** Addresses the e-mail went to. */
  deliveredTo: string[];
  /** Recipients left out because they can no longer open the report. */
  skipped: string[];
  /** The part of `skipped` left out because their share expired (migration 014). */
  expired?: string[];
}

/** Why recipients were left out, as recorded with the delivery (LAST_ERROR / ERROR_MESSAGE). */
export function skipNote(skipped: string[], expired: string[]): string | null {
  const lost = skipped.filter((e) => !expired.includes(e));
  const parts: string[] = [];
  if (expired.length) parts.push(`Not sent to ${expired.join(', ')}: their access has expired.`);
  if (lost.length)
    parts.push(`Not sent to ${lost.join(', ')}: they can no longer open this report.`);
  return parts.length ? parts.join(' ') : null;
}

export interface RunOptions {
  trigger?: DeliveryTrigger;
  /** The person who pressed "Run now" (MANUAL runs). */
  requestedBy?: string | null;
  /** The tick time the run was claimed at (recorded as the last run); defaults to now. */
  ranAt?: Date;
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
    private readonly recipients: RecipientService,
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
        await this.run(s, { trigger: 'SCHEDULE', ranAt: now });
      }
    } catch (e) {
      console.error('scheduler tick failed:', sanitizeErrorMessage(e));
    } finally {
      this.ticking = false;
    }
    return ran;
  }

  /** Execute one schedule now (the scheduler tick, and "Run now"). Never throws. */
  async run(s: Schedule, opts: RunOptions = {}): Promise<RunResult> {
    const startedAt = new Date();
    const ranAt = opts.ranAt ?? startedAt;
    let rowCount: number | undefined;
    let deliveredTo: string[] = [];
    let skipped: string[] = [];
    let expired: string[] = [];
    let result: RunResult;
    try {
      const { runAs, report } = await this.ownerFor(s);
      const rc = checkRecipients(s.recipients, this.cfg.scheduler);
      if (!rc.ok) throw new Error(rc.message);
      if (!this.mailer)
        throw new Error('Email delivery is not configured on the server (SMTP_HOST).');
      // Access is re-checked at every delivery: anyone who lost access to the report is left
      // out, including anyone whose share has expired since the last run (migration 014).
      const checked = await this.recipients.check(report, rc.recipients);
      skipped = checked.blocked;
      expired = checked.expired;
      if (!checked.allowed.length)
        throw new Error(
          `Not sent: none of the recipients can open this report any more (${skipped.join(', ')}).${
            expired.length ? ` Access has expired for ${expired.join(', ')}.` : ''
          }`,
        );
      const file = await this.execution.exportXlsx(
        runAs,
        { reportId: s.reportId, values: s.parameters },
        { scheduleId: s.id },
      );
      try {
        rowCount = file.rowCount;
        const name = s.reportName ?? report.name ?? s.reportId;
        const lines = [
          `Attached is the scheduled report "${name}".`,
          `Rows: ${file.rowCount}${file.truncated ? ' (limited by the export row limit)' : ''}`,
          `Schedule: ${s.description} (${s.timezone})`,
          ...(file.chart
            ? ['The chart is shown below and on the Chart sheet of the workbook.']
            : []),
          ...(file.chartNote && !file.chart ? [file.chartNote] : []),
          `Generated by Uncle Bob at ${new Date().toISOString()} (UTC).`,
          'To change or stop these e-mails, open the report in Uncle Bob and choose Schedule.',
        ];
        const attachments: MailAttachment[] = [{ filename: file.filename, path: file.path }];
        if (file.chart)
          attachments.push({
            filename: 'chart.png',
            content: file.chart.png,
            contentType: 'image/png',
            cid: CHART_CID,
          });
        await this.mailer.send({
          to: checked.allowed,
          subject: `Uncle Bob: ${s.reportName ?? report.name ?? 'Scheduled report'}`,
          text: `${lines.join('\n')}\n`,
          ...(file.chart
            ? {
                html:
                  lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
                  `<p><img src="cid:${CHART_CID}" alt="${escapeHtml(`Chart: ${name}`)}" width="720"></p>`,
              }
            : {}),
          attachments,
        });
        deliveredTo = checked.allowed;
      } finally {
        await file.cleanup();
      }
      const note = skipNote(skipped, expired);
      await this.schedules.recordResult(s.id, {
        status: 'SUCCEEDED',
        error: note,
        failures: 0,
        disable: false,
        ranAt,
      });
      result = {
        status: 'SUCCEEDED',
        error: note,
        rowCount,
        disabled: false,
        deliveredTo,
        skipped,
        expired,
      };
    } catch (e) {
      const error = sanitizeErrorMessage(e);
      const failures = s.failureCount + 1;
      const disable = failures >= this.cfg.scheduler.maxFailures;
      await this.schedules
        .recordResult(s.id, { status: 'FAILED', error, failures, disable, ranAt })
        .catch((x) => console.error('schedule result not recorded:', sanitizeErrorMessage(x)));
      result = {
        status: 'FAILED',
        error,
        rowCount,
        disabled: disable,
        deliveredTo: [],
        skipped,
        expired,
      };
    }
    await this.schedules
      .recordDelivery({
        scheduleId: s.id,
        reportId: s.reportId,
        trigger: opts.trigger ?? 'MANUAL',
        requestedBy: opts.requestedBy ?? null,
        startedAt,
        finishedAt: new Date(),
        status: result.status,
        rowCount: rowCount ?? null,
        deliveredTo: result.deliveredTo,
        skipped: result.skipped,
        error: result.error,
      })
      .catch((x) => console.error('delivery history not recorded:', sanitizeErrorMessage(x)));
    return result;
  }

  /** The owner must still be active, and the schedule creator must still have edit rights. */
  private async ownerFor(s: Schedule) {
    const creator = await this.users.findById(s.createdBy);
    if (!creator)
      throw new Error('The user who created this schedule is disabled or no longer exists.');
    const { report, access: role } = await this.access.require(creator, s.reportId, 'EDIT');
    if (role === 'OWNER') return { runAs: creator, report };
    const owner = await this.users.findById(report.ownerId);
    if (!owner) throw new Error('The report owner is disabled or no longer exists.');
    return { runAs: owner, report };
  }
}
