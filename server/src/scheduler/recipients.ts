import type { AppConfig } from '../config/config.js';
import type { UserRepository } from '../auth/users.js';
import type { MetadataDb } from '../db/types.js';
import { T, q } from '../db/schema.js';
import type { Report } from '../reports/reports.js';
import type { AccessService } from '../sharing/access.js';
import type { FolderReportGrants } from '../sharing/folder-report-grants.js';
import { ACTIVE_SHARE, activeParam, systemClock, type Clock } from '../sharing/expiry.js';

export interface RecipientOption {
  userId: string;
  displayName: string;
  email: string;
  /** True for the report owner. */
  owner: boolean;
  /** False when the address is outside SCHEDULE_RECIPIENT_DOMAINS, so it can't be chosen. */
  allowedDomain: boolean;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/**
 * Who a scheduled report may be e-mailed to. A recipient address must belong to an active
 * Uncle Bob user who can already open the report (owner, a user or group share, a folder the
 * owner shared together with its reports, or an admin),
 * so scheduling never becomes a way to send a report to someone who could not see it.
 * The check runs when a schedule is saved and again at every delivery. A share past its expiry
 * (migration 014) counts for nothing, so a recipient whose only access has expired is refused
 * when saving and skipped (and named in the delivery history) at the next delivery.
 */
export class RecipientService {
  private readonly users: string;
  private readonly shares: string;
  private readonly groups: string;
  constructor(
    private readonly db: MetadataDb,
    schema: string,
    private readonly userRepo: UserRepository,
    private readonly access: AccessService,
    private readonly cfg: Pick<AppConfig['scheduler'], 'recipientDomains'>,
    private readonly folderGrants?: FolderReportGrants,
    private readonly clock: Clock = systemClock,
  ) {
    this.users = q(schema, T.users);
    this.shares = q(schema, T.shares);
    this.groups = q(schema, T.userGroups);
  }

  /** People with an e-mail address who can open the report through ownership or its shares. */
  async options(report: Report): Promise<RecipientOption[]> {
    const now = this.clock();
    const rows = await this.db.query<Record<string, unknown>>(
      `SELECT U.USER_ID, U.DISPLAY_NAME, U.EMAIL FROM ${this.users} U
        WHERE U.IS_ACTIVE = 1 AND U.EMAIL IS NOT NULL AND (U.USER_ID = ?
           OR U.USER_ID IN (SELECT S.PRINCIPAL_ID FROM ${this.shares} S WHERE S.REPORT_ID = ? AND S.PRINCIPAL_TYPE = 'USER' AND ${ACTIVE_SHARE('S')})
           OR U.USER_ID IN (SELECT G.USER_ID FROM ${this.groups} G JOIN ${this.shares} S
                              ON S.PRINCIPAL_TYPE = 'GROUP' AND S.PRINCIPAL_ID = G.GROUP_NAME WHERE S.REPORT_ID = ? AND ${ACTIVE_SHARE('S')}))
        ORDER BY U.DISPLAY_NAME FETCH FIRST 500 ROWS ONLY`,
      [report.ownerId, report.id, activeParam(now), report.id, activeParam(now)],
    );
    const viaFolders = await this.viaFolders(report);
    if (viaFolders.length) {
      rows.push(...viaFolders);
      rows.sort((a, b) => String(a.DISPLAY_NAME).localeCompare(String(b.DISPLAY_NAME)));
    }
    const seen = new Set<string>();
    const out: RecipientOption[] = [];
    for (const r of rows) {
      const email = String(r.EMAIL ?? '')
        .trim()
        .toLowerCase();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({
        userId: String(r.USER_ID),
        displayName: String(r.DISPLAY_NAME),
        email,
        owner: r.USER_ID === report.ownerId,
        allowedDomain: this.cfg.recipientDomains.includes(domainOf(email)),
      });
    }
    return out;
  }

  /** People who can open the report only because its owner shared a folder with its reports. */
  private async viaFolders(report: Report): Promise<Record<string, unknown>[]> {
    if (!this.folderGrants) return [];
    const grants = await this.folderGrants.grantsForReport(report);
    const userIds = [...new Set(grants.filter((g) => g.type === 'USER').map((g) => g.id))];
    const groups = [...new Set(grants.filter((g) => g.type === 'GROUP').map((g) => g.id))];
    if (!userIds.length && !groups.length) return [];
    const ph = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    const who: string[] = [];
    if (userIds.length) who.push(`U.USER_ID IN (${ph(userIds.length)})`);
    if (groups.length)
      who.push(
        `U.USER_ID IN (SELECT G.USER_ID FROM ${this.groups} G WHERE G.GROUP_NAME IN (${ph(groups.length)}))`,
      );
    return this.db.query<Record<string, unknown>>(
      `SELECT U.USER_ID, U.DISPLAY_NAME, U.EMAIL FROM ${this.users} U
        WHERE U.IS_ACTIVE = 1 AND U.EMAIL IS NOT NULL AND (${who.join(' OR ')})
        ORDER BY U.DISPLAY_NAME FETCH FIRST 500 ROWS ONLY`,
      [...userIds, ...groups],
    );
  }

  /**
   * Split addresses into those that belong to someone who can open the report now and those
   * that don't. `expired` is the part of `blocked` whose only access was a share (report or
   * folder) that has expired; it is worked out only to explain the skip, never to send.
   */
  async check(
    report: Report,
    emails: string[],
  ): Promise<{ allowed: string[]; blocked: string[]; expired: string[] }> {
    const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const users = await this.userRepo.findActiveByEmails(list);
    const ok = new Set<string>();
    const lapsed = new Set<string>();
    for (const u of users) {
      const email = String(u.email ?? '').toLowerCase();
      if (ok.has(email)) continue;
      if (await this.access.roleFor(u, report)) {
        ok.add(email);
        lapsed.delete(email);
      } else if (await this.access.roleFor(u, report, { includeExpired: true })) lapsed.add(email);
    }
    return {
      allowed: list.filter((e) => ok.has(e)),
      blocked: list.filter((e) => !ok.has(e)),
      expired: list.filter((e) => !ok.has(e) && lapsed.has(e)),
    };
  }
}
