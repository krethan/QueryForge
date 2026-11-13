import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.js';
import type { MetadataDb } from '../db/types.js';
import { NOW_UTC, T, q, toDbTimestamp } from '../db/schema.js';
import type { Mailer } from '../mail/mailer.js';
import type { ShareChange, ShareRole } from '../sharing/access.js';
import { expiryIso, expiryParam, systemClock, type Clock } from '../sharing/expiry.js';
import { DbError, sanitizeErrorMessage } from '../util/errors.js';
import { appLink, formatWhen, plain, render, safeAddress, type Para } from './email.js';

/**
 * Share notifications (migration 015).
 *
 * 1. When the owner saves a report's or folder's shares with "Notify people" on, everyone who
 *    gained a share or whose role changed gets one e-mail (group shares are expanded to the
 *    group's members). It says who shared what, the role, the end date and links to the app.
 *    It never contains report data. Sent after the shares are committed, in the background, so a
 *    slow mail server never holds up or undoes the save.
 * 2. Expiry reminders: on each scheduler poll (leader only) shares ending within
 *    QF_SHARE_REMINDER_DAYS get one e-mail to the owner (and, with
 *    QF_SHARE_REMINDER_TO_RECIPIENT, to the people losing access). QF_SHARE_REMINDERS records each
 *    reminder before it is sent; its unique key is the claim, so restarts and several instances
 *    never send one twice. A new end date can be reminded about again.
 *
 * People who turned share e-mails off (QF_USER_SETTINGS.SHARE_EMAILS = 0) get none of these.
 * Without SMTP nothing is sent and nothing is claimed; sharing works as before.
 */

export type ShareKind = 'REPORT' | 'FOLDER';
/** The configuration the notifier reads (a full AppConfig satisfies it). */
export type NotifierConfig = Pick<AppConfig, 'notifications'> & {
  scheduler: Pick<AppConfig['scheduler'], 'recipientDomains'>;
};
export interface ShareTarget {
  kind: ShareKind;
  id: string;
  name: string;
  ownerId: string;
}
/** What happened to the "Notify people" request, as the share endpoints report it. */
export type NotifyOutcome = 'QUEUED' | 'NONE' | 'OFF' | 'MAIL_NOT_CONFIGURED';

interface Person {
  id: string;
  name: string;
  email: string;
}

/** A reminder attempt is retried on later polls until this many tries. */
export const MAX_REMINDER_ATTEMPTS = 3;
/** Shares looked at per kind per poll. */
export const REMINDER_BATCH = 200;
/** Group members e-mailed per save, at most. */
export const MAX_NOTIFY_PEOPLE = 500;

const roleName = (r: ShareRole | null) => (r === 'EDITOR' ? 'Editor' : 'Viewer');
const RANK: Record<ShareRole, number> = { VIEWER: 1, EDITOR: 2 };
const isDuplicate = (e: unknown) =>
  e instanceof DbError && (e.sqlState === '23505' || e.sqlCode === -803);

export interface ReminderRunResult {
  /** Reminders this instance claimed and sent (one per share and end date). */
  sent: number;
  /** Claimed, but nobody could be e-mailed (opted out, no address, disabled). */
  skipped: number;
  failed: number;
}

export class ShareNotifier {
  private readonly users: string;
  private readonly groups: string;
  private readonly settings: string;
  private readonly reminders: string;
  private readonly shares: string;
  private readonly folderShares: string;
  private readonly reports: string;
  private readonly folders: string;
  private readonly pending = new Set<Promise<void>>();
  private warnedNoMail = false;

  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly cfg: NotifierConfig,
    private readonly mailer?: Mailer,
    private readonly clock: Clock = systemClock,
  ) {
    this.users = q(schema, T.users);
    this.groups = q(schema, T.userGroups);
    this.settings = q(schema, T.userSettings);
    this.reminders = q(schema, T.shareReminders);
    this.shares = q(schema, T.shares);
    this.folderShares = q(schema, T.folderShares);
    this.reports = q(schema, T.reports);
    this.folders = q(schema, T.folders);
  }

  get mailConfigured(): boolean {
    return Boolean(this.mailer);
  }

  /** Resolves once every e-mail queued so far has been sent or has failed (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /**
   * After a share change has committed: e-mail the people who gained a share or whose role
   * changed. Never throws; failures are logged. Changes of end date alone and removals send
   * nothing.
   */
  notifyChanges(
    target: ShareTarget,
    actor: { id: string; displayName: string },
    changes: ShareChange[],
    notify: boolean,
  ): NotifyOutcome {
    if (!notify) return 'OFF';
    const now = this.clock().getTime();
    const relevant = changes.filter(
      (c) =>
        (c.action === 'GRANT' || c.action === 'CHANGE') &&
        c.newRole !== null &&
        // a share saved unchanged but already expired gives nothing, so say nothing about it
        (c.newExpiresAt === null || Date.parse(c.newExpiresAt) > now),
    );
    if (!relevant.length) return 'NONE';
    if (!this.mailer) {
      console.log(
        `share notification skipped: e-mail (SMTP) is not configured (${target.kind.toLowerCase()} ${target.id}, ${relevant.length} change(s))`,
      );
      return 'MAIL_NOT_CONFIGURED';
    }
    const job = this.sendChanges(target, actor, relevant).catch((e) =>
      console.error('share notification failed:', sanitizeErrorMessage(e)),
    );
    this.pending.add(job);
    void job.finally(() => this.pending.delete(job));
    return 'QUEUED';
  }

  private async sendChanges(
    target: ShareTarget,
    actor: { id: string; displayName: string },
    changes: ShareChange[],
  ) {
    const people = await this.resolve(
      changes.map((c) => ({ type: c.type, id: c.id })),
      new Set([actor.id, target.ownerId]),
    );
    // One e-mail per person: a direct share wins over a group, then the stronger role.
    const best = new Map<string, { person: Person; change: ShareChange }>();
    for (const c of changes) {
      for (const p of people.get(`${c.type}:${c.id}`) ?? []) {
        const cur = best.get(p.id);
        const better =
          !cur ||
          (c.type === 'USER' && cur.change.type === 'GROUP') ||
          (c.type === cur.change.type && RANK[c.newRole!] > RANK[cur.change.newRole!]);
        if (better) best.set(p.id, { person: p, change: c });
      }
    }
    let failed = 0;
    for (const { person, change } of best.values()) {
      const mail = this.changeEmail(target, actor, change);
      try {
        await this.mailer!.send({ to: [person.email], ...mail, attachments: [] });
      } catch (e) {
        failed++;
        console.error(`share notification to user ${person.id} failed:`, sanitizeErrorMessage(e));
      }
    }
    if (best.size)
      console.log(
        `share notification: ${best.size - failed} e-mail(s) sent for ${target.kind.toLowerCase()} ${target.id}${failed ? `, ${failed} failed` : ''}`,
      );
  }

  private what(target: ShareTarget): string {
    return target.kind === 'REPORT' ? 'the report' : 'the folder';
  }

  private link(target: ShareTarget) {
    const href = appLink(
      this.cfg.notifications.publicBaseUrl,
      target.kind === 'REPORT' ? `/reports/${encodeURIComponent(target.id)}` : '/',
    );
    return href
      ? {
          href,
          label: target.kind === 'REPORT' ? 'Open the report in Uncle Bob' : 'Open Uncle Bob',
        }
      : undefined;
  }

  private roleMeaning(target: ShareTarget, role: ShareRole): string {
    if (target.kind === 'REPORT')
      return role === 'EDITOR'
        ? 'Editors can run and export the report and change its SQL, parameters and schedules.'
        : 'Viewers can run and export the report.';
    return role === 'EDITOR'
      ? 'Editors can see the folder and add, remove and reorder its reports.'
      : 'Viewers can see the folder.';
  }

  private footer =
    'You get this e-mail because of a share in Uncle Bob. To stop e-mails about shares, open Account in Uncle Bob and turn off share e-mails.';

  /** The e-mail for one person and one change. Exposed for tests. */
  changeEmail(target: ShareTarget, actor: { displayName: string }, c: ShareChange) {
    const who = plain(actor.displayName, 100) || 'Someone';
    const name = plain(target.name, 128);
    const role = roleName(c.newRole);
    const what = this.what(target);
    const viaGroup =
      c.type === 'GROUP'
        ? [' with the group ', { strong: plain(c.id, 128) }, ', which you are in,']
        : [' with you'];
    const lead: Para =
      c.action === 'GRANT'
        ? [who, ` shared ${what} `, { strong: name }, ...viaGroup, ' as ', { strong: role }, '.']
        : [
            who,
            ` changed ${c.type === 'GROUP' ? 'the access of the group ' : 'your access to '}`,
            ...(c.type === 'GROUP'
              ? [{ strong: plain(c.id, 128) }, ` (which you are in) to ${what} `]
              : [`${what} `]),
            { strong: name },
            ` from ${roleName(c.oldRole)} to `,
            { strong: role },
            '.',
          ];
    const paras: Para[] = [lead, [this.roleMeaning(target, c.newRole!)]];
    paras.push(
      c.newExpiresAt
        ? [
            'This access ends on ',
            { strong: formatWhen(c.newExpiresAt, this.cfg.notifications.timezone) },
            '.',
          ]
        : ['This access has no end date.'],
    );
    const subject =
      c.action === 'GRANT'
        ? `Uncle Bob: ${who} shared "${name}" with you`
        : `Uncle Bob: your access to "${name}" changed`;
    return render(subject, paras, this.link(target), this.footer);
  }

  /**
   * Active people with an e-mail address who have not turned share e-mails off, for each
   * principal (`USER:id` / `GROUP:name`), leaving out `exclude` (the sharer and the owner) and
   * addresses outside SCHEDULE_RECIPIENT_DOMAINS when that allowlist is set.
   */
  private async resolve(
    principals: { type: 'USER' | 'GROUP'; id: string }[],
    exclude: Set<string>,
  ): Promise<Map<string, Person[]>> {
    const out = new Map<string, Person[]>();
    const add = (key: string, r: Record<string, unknown>) => {
      const id = String(r.USER_ID);
      const email = safeAddress(r.EMAIL);
      if (exclude.has(id) || !email || !this.domainAllowed(email)) return;
      const list = out.get(key) ?? [];
      if (!list.some((p) => p.id === id))
        list.push({ id, name: String(r.DISPLAY_NAME ?? ''), email });
      out.set(key, list);
    };
    const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    const optedIn = `NOT EXISTS (SELECT 1 FROM ${this.settings} X WHERE X.USER_ID = U.USER_ID AND X.SHARE_EMAILS = 0)`;
    const userIds = [...new Set(principals.filter((p) => p.type === 'USER').map((p) => p.id))];
    const groupNames = [...new Set(principals.filter((p) => p.type === 'GROUP').map((p) => p.id))];
    if (userIds.length)
      for (const r of await this.db.query<Record<string, unknown>>(
        `SELECT U.USER_ID, U.DISPLAY_NAME, U.EMAIL FROM ${this.users} U
          WHERE U.IS_ACTIVE = 1 AND U.EMAIL IS NOT NULL AND U.USER_ID IN (${ph(userIds.length)}) AND ${optedIn}`,
        userIds,
      ))
        add(`USER:${r.USER_ID}`, r);
    if (groupNames.length)
      for (const r of await this.db.query<Record<string, unknown>>(
        `SELECT G.GROUP_NAME, U.USER_ID, U.DISPLAY_NAME, U.EMAIL FROM ${this.groups} G JOIN ${this.users} U ON U.USER_ID = G.USER_ID
          WHERE G.GROUP_NAME IN (${ph(groupNames.length)}) AND U.IS_ACTIVE = 1 AND U.EMAIL IS NOT NULL AND ${optedIn}
          ORDER BY G.GROUP_NAME, U.USER_ID FETCH FIRST ${MAX_NOTIFY_PEOPLE} ROWS ONLY`,
        groupNames,
      ))
        add(`GROUP:${r.GROUP_NAME}`, r);
    return out;
  }

  private domainAllowed(email: string) {
    const allow = this.cfg.scheduler.recipientDomains;
    return !allow.length || allow.includes(email.slice(email.lastIndexOf('@') + 1));
  }

  // ---------------------------------------------------------------------------------------
  // Expiry reminders
  // ---------------------------------------------------------------------------------------

  /**
   * Send the reminders that are due at `now`. Call it only from the scheduler leader; the
   * QF_SHARE_REMINDERS claim keeps it safe even if two instances run it at once. Never throws.
   */
  async runReminders(now: Date, instanceId: string): Promise<ReminderRunResult> {
    const result: ReminderRunResult = { sent: 0, skipped: 0, failed: 0 };
    const days = this.cfg.notifications.reminderDays;
    if (days <= 0) return result;
    if (!this.mailer) {
      if (!this.warnedNoMail)
        console.log('share expiry reminders skipped: e-mail (SMTP) is not configured');
      this.warnedNoMail = true;
      return result;
    }
    try {
      const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
      for (const kind of ['REPORT', 'FOLDER'] as const)
        for (const row of await this.pendingReminders(kind, now, until)) {
          const r = await this.remindOne(kind, row, instanceId).catch((e) => {
            console.error('share reminder failed:', sanitizeErrorMessage(e));
            return 'failed' as const;
          });
          if (r) result[r]++;
        }
    } catch (e) {
      console.error('share reminders failed:', sanitizeErrorMessage(e));
    }
    return result;
  }

  /**
   * Shares ending in (now, until] with no reminder yet for that end date (or one to retry).
   * Read-only; the verification kit runs it to check the SQL on Db2 for i.
   */
  pendingReminders(kind: ShareKind, now: Date, until: Date) {
    const [shares, key, targets, nameCol, targetKey] =
      kind === 'REPORT'
        ? [this.shares, 'REPORT_ID', this.reports, 'REPORT_NAME', 'REPORT_ID']
        : [this.folderShares, 'FOLDER_ID', this.folders, 'FOLDER_NAME', 'FOLDER_ID'];
    return this.db.query<Record<string, unknown>>(
      `SELECT S.${key} AS TARGET_ID, S.PRINCIPAL_TYPE, S.PRINCIPAL_ID, S.SHARE_ROLE, S.EXPIRES_AT, T.${nameCol} AS TARGET_NAME, T.OWNER_ID
         FROM ${shares} S JOIN ${targets} T ON T.${targetKey} = S.${key}
        WHERE S.EXPIRES_AT > CAST(? AS TIMESTAMP) AND S.EXPIRES_AT <= CAST(? AS TIMESTAMP)
          AND NOT EXISTS (SELECT 1 FROM ${this.reminders} M
                           WHERE M.SHARE_KIND = '${kind}' AND M.TARGET_ID = S.${key} AND M.PRINCIPAL_TYPE = S.PRINCIPAL_TYPE
                             AND M.PRINCIPAL_ID = S.PRINCIPAL_ID AND M.EXPIRES_AT = S.EXPIRES_AT
                             AND (M.STATUS <> 'FAILED' OR M.ATTEMPTS >= ${MAX_REMINDER_ATTEMPTS}))
        ORDER BY S.EXPIRES_AT FETCH FIRST ${REMINDER_BATCH} ROWS ONLY`,
      [toDbTimestamp(now), toDbTimestamp(until)],
    );
  }

  /** Claim the reminder for one share and end date: a new row, or a retry of a FAILED one. */
  private async claim(kind: ShareKind, k: (string | null)[], instanceId: string): Promise<boolean> {
    try {
      await this.db.update(
        `INSERT INTO ${this.reminders} (REMINDER_ID, SHARE_KIND, TARGET_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, EXPIRES_AT, STATUS, ATTEMPTS, RECIPIENT_COUNT, CLAIMED_BY, CREATED_AT, UPDATED_AT)
         VALUES (?, ?, ?, ?, ?, ?, 'CLAIMED', 1, 0, ?, ${NOW_UTC}, ${NOW_UTC})`,
        [randomUUID(), kind, ...k, instanceId],
      );
      return true;
    } catch (e) {
      if (!isDuplicate(e)) throw e;
    }
    const n = await this.db.update(
      `UPDATE ${this.reminders} SET STATUS = 'CLAIMED', ATTEMPTS = ATTEMPTS + 1, CLAIMED_BY = ?, UPDATED_AT = ${NOW_UTC}
        WHERE SHARE_KIND = ? AND TARGET_ID = ? AND PRINCIPAL_TYPE = ? AND PRINCIPAL_ID = ? AND EXPIRES_AT = ?
          AND STATUS = 'FAILED' AND ATTEMPTS < ${MAX_REMINDER_ATTEMPTS}`,
      [instanceId, kind, ...k],
    );
    return n === 1;
  }

  private finish(
    kind: ShareKind,
    k: (string | null)[],
    instanceId: string,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    count: number,
    error: string | null,
  ) {
    return this.db.update(
      `UPDATE ${this.reminders} SET STATUS = ?, RECIPIENT_COUNT = ?, LAST_ERROR = ?, UPDATED_AT = ${NOW_UTC}
        WHERE SHARE_KIND = ? AND TARGET_ID = ? AND PRINCIPAL_TYPE = ? AND PRINCIPAL_ID = ? AND EXPIRES_AT = ? AND CLAIMED_BY = ?`,
      [status, count, error, kind, ...k, instanceId],
    );
  }

  private async remindOne(
    kind: ShareKind,
    row: Record<string, unknown>,
    instanceId: string,
  ): Promise<'sent' | 'skipped' | 'failed' | null> {
    const expiresAt = expiryIso(row.EXPIRES_AT);
    if (!expiresAt) return null;
    const type = row.PRINCIPAL_TYPE === 'GROUP' ? 'GROUP' : 'USER';
    const principalId = String(row.PRINCIPAL_ID);
    const k = [String(row.TARGET_ID), type, principalId, expiryParam(expiresAt)];
    if (!(await this.claim(kind, k, instanceId))) return null;

    const target: ShareTarget = {
      kind,
      id: String(row.TARGET_ID),
      name: String(row.TARGET_NAME ?? ''),
      ownerId: String(row.OWNER_ID),
    };
    const role: ShareRole = row.SHARE_ROLE === 'EDITOR' ? 'EDITOR' : 'VIEWER';
    const ownerMap = await this.resolve([{ type: 'USER', id: target.ownerId }], new Set());
    const owner = ownerMap.get(`USER:${target.ownerId}`)?.[0];
    const ownerName = owner?.name ?? (await this.displayName(target.ownerId)) ?? 'the owner';
    const principalName =
      type === 'GROUP'
        ? `the group ${principalId}`
        : ((await this.displayName(principalId)) ?? principalId);

    const messages: { to: string; mail: ReturnType<typeof render> }[] = [];
    if (owner)
      messages.push({
        to: owner.email,
        mail: this.ownerReminder(target, principalName, role, expiresAt),
      });
    if (this.cfg.notifications.reminderToRecipient) {
      const people = await this.resolve([{ type, id: principalId }], new Set([target.ownerId]));
      for (const p of people.get(`${type}:${principalId}`) ?? [])
        messages.push({
          to: p.email,
          mail: this.recipientReminder(
            target,
            ownerName,
            type === 'GROUP' ? principalId : null,
            role,
            expiresAt,
          ),
        });
    }
    if (!messages.length) {
      await this.finish(kind, k, instanceId, 'SKIPPED', 0, null);
      return 'skipped';
    }
    let sent = 0;
    let lastError: string | null = null;
    for (const m of messages) {
      try {
        await this.mailer!.send({ to: [m.to], ...m.mail, attachments: [] });
        sent++;
      } catch (e) {
        lastError = sanitizeErrorMessage(e);
      }
    }
    // Once anyone got it, it counts as sent: retrying would send the others' copies twice.
    await this.finish(kind, k, instanceId, sent ? 'SENT' : 'FAILED', sent, lastError);
    if (lastError)
      console.error(`share reminder for ${kind.toLowerCase()} ${target.id}: ${lastError}`);
    return sent ? 'sent' : 'failed';
  }

  private async displayName(userId: string): Promise<string | null> {
    const rows = await this.db.query<{ DISPLAY_NAME: unknown }>(
      `SELECT DISPLAY_NAME FROM ${this.users} WHERE USER_ID = ?`,
      [userId],
    );
    return rows[0] ? String(rows[0].DISPLAY_NAME) : null;
  }

  /** The reminder to the owner. Exposed for tests. */
  ownerReminder(target: ShareTarget, principalName: string, role: ShareRole, expiresAt: string) {
    const name = plain(target.name, 128);
    const when = formatWhen(expiresAt, this.cfg.notifications.timezone);
    return render(
      `Uncle Bob: sharing of "${name}" ends soon`,
      [
        [
          `Your share of ${this.what(target)} `,
          { strong: name },
          ' with ',
          { strong: plain(principalName, 128) },
          ` (${roleName(role)}) ends on `,
          { strong: when },
          '.',
        ],
        [
          'After that this share gives no access. To keep it, open the Share dialog and pick a later end date or choose No end date.',
        ],
      ],
      this.link(target),
      this.footer,
    );
  }

  /** The reminder to someone losing access (QF_SHARE_REMINDER_TO_RECIPIENT). Exposed for tests. */
  recipientReminder(
    target: ShareTarget,
    ownerName: string,
    group: string | null,
    role: ShareRole,
    expiresAt: string,
  ) {
    const name = plain(target.name, 128);
    const owner = plain(ownerName, 100);
    const when = formatWhen(expiresAt, this.cfg.notifications.timezone);
    return render(
      `Uncle Bob: your access to "${name}" ends soon`,
      [
        [
          group ? 'Access for the group ' : 'Your access to ',
          ...(group
            ? [{ strong: plain(group, 128) }, ` (which you are in) to ${this.what(target)} `]
            : [`${this.what(target)} `]),
          { strong: name },
          ` (${roleName(role)}), shared by `,
          { strong: owner },
          ', ends on ',
          { strong: when },
          '.',
        ],
        [`If you still need it, ask ${owner} to extend the share.`],
      ],
      this.link(target),
      this.footer,
    );
  }
}
