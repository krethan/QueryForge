import { readFileSync } from 'node:fs';
import { Client } from 'ldapts';
import type { AppConfig } from '../config/config.js';
import { AppError } from '../util/errors.js';
import type { ExternalIdentity } from './users.js';

export interface LdapAuthenticator {
  readonly label: string;
  /** Returns the identity on a successful bind, or null when the credentials are wrong. */
  authenticate(username: string, password: string): Promise<ExternalIdentity | null>;
}

/** RFC 4515 escaping for a value placed inside an LDAP search filter. */
export function escapeLdapFilter(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Extract the leading CN from a DN, e.g. "CN=Finance,OU=Groups,DC=corp" -> "Finance". */
export function cnOf(dn: string): string {
  const m = /^\s*cn=((?:\\.|[^,])+)/i.exec(dn);
  return m ? m[1].replace(/\\(.)/g, '$1') : dn;
}

const str = (v: unknown): string | undefined =>
  Array.isArray(v)
    ? str(v[0])
    : Buffer.isBuffer(v)
      ? v.toString('utf8')
      : typeof v === 'string'
        ? v
        : undefined;

/**
 * LDAP / Active Directory bind authentication with ldapts: (optional) service
 * bind, search for the user's DN with an escaped filter, then bind as the user.
 * TLS is via ldaps:// or StartTLS with certificate verification on by default.
 */
export class LdaptsAuthenticator implements LdapAuthenticator {
  readonly label: string;
  constructor(private readonly cfg: NonNullable<AppConfig['auth']['ldap']>) {
    this.label = cfg.label;
  }

  private tls() {
    return {
      rejectUnauthorized: this.cfg.rejectUnauthorized,
      ca: this.cfg.caFile ? readFileSync(this.cfg.caFile) : undefined,
      minVersion: 'TLSv1.2' as const,
    };
  }

  private async client() {
    const c = new Client({
      url: this.cfg.url,
      timeout: this.cfg.timeoutMs,
      connectTimeout: this.cfg.timeoutMs,
      tlsOptions: this.cfg.url.startsWith('ldaps://') ? this.tls() : undefined,
    });
    if (this.cfg.startTls) await c.startTLS(this.tls());
    return c;
  }

  async authenticate(username: string, password: string): Promise<ExternalIdentity | null> {
    // Empty passwords would be an "unauthenticated bind" that many servers accept.
    if (!password) return null;
    const uname = username.trim();
    if (!uname || uname.length > 256) return null;
    let svc: Client | undefined;
    let usr: Client | undefined;
    try {
      svc = await this.client();
      if (this.cfg.bindDn) await svc.bind(this.cfg.bindDn, this.cfg.bindPassword ?? '');
      const filter = this.cfg.userFilter.split('{{username}}').join(escapeLdapFilter(uname));
      const { searchEntries } = await svc.search(this.cfg.searchBase, {
        scope: 'sub',
        filter,
        sizeLimit: 2,
        attributes: [
          'dn',
          'cn',
          'displayName',
          'mail',
          'sAMAccountName',
          'uid',
          'objectGUID',
          this.cfg.groupAttribute,
        ],
      });
      if (searchEntries.length !== 1) return null;
      const e = searchEntries[0];
      usr = await this.client();
      try {
        await usr.bind(e.dn, password);
      } catch {
        return null;
      }
      const groupsRaw = e[this.cfg.groupAttribute];
      const groups = (Array.isArray(groupsRaw) ? groupsRaw : groupsRaw ? [groupsRaw] : [])
        .map((g) => str(g))
        .filter((g): g is string => Boolean(g))
        .flatMap((dn) => [dn, cnOf(dn)]);
      const guid = e.objectGUID;
      return {
        source: 'LDAP',
        externalId: (Buffer.isBuffer(guid) ? guid.toString('hex') : e.dn).slice(0, 512),
        username: str(e.sAMAccountName) ?? str(e.uid) ?? uname,
        displayName: str(e.displayName) ?? str(e.cn) ?? uname,
        email: str(e.mail) ?? null,
        groups,
      };
    } catch (err) {
      throw new AppError(
        503,
        'LDAP_UNAVAILABLE',
        `The directory is unavailable: ${(err as Error).message}`,
      );
    } finally {
      await svc?.unbind().catch(() => undefined);
      await usr?.unbind().catch(() => undefined);
    }
  }
}
