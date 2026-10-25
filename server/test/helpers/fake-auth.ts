/**
 * In-memory OIDC / LDAP fakes used by tests and DEV-ONLY demo mode. They never open a
 * network connection. The OIDC fake still exercises the real state-cookie round trip:
 * start() returns a callback URL carrying a random state that finish() checks.
 */
import { randomBytes } from 'node:crypto';
import type { OidcChecks, OidcProvider } from '../../src/auth/oidc.js';
import type { LdapAuthenticator } from '../../src/auth/ldap.js';
import type { ExternalIdentity } from '../../src/auth/users.js';
import { AppError } from '../../src/util/errors.js';

export class FakeOidc implements OidcProvider {
  next: Partial<ExternalIdentity> = {};
  constructor(
    public label = 'Contoso SSO (fake)',
    private readonly identity: ExternalIdentity = {
      source: 'OIDC',
      externalId: 'https://idp.example.test|sub-carol',
      username: 'carol@example.com',
      displayName: 'Carol',
      email: 'carol@example.com',
      groups: ['Finance-Readers', 'Unmapped'],
    },
  ) {}
  async start() {
    const checks: OidcChecks = {
      state: randomBytes(12).toString('base64url'),
      nonce: 'n',
      codeVerifier: 'v',
    };
    return { url: `/api/auth/oidc/callback?code=fake-code&state=${checks.state}`, checks };
  }
  async finish(url: URL, checks: OidcChecks): Promise<ExternalIdentity> {
    if (url.searchParams.get('state') !== checks.state)
      throw new AppError(401, 'SSO_STATE_MISMATCH', 'state mismatch');
    return { ...this.identity, ...this.next };
  }
}

export class FakeLdap implements LdapAuthenticator {
  constructor(
    public label = 'Corporate directory (fake)',
    private readonly users: Record<string, { password: string; identity: ExternalIdentity }> = {
      dave: {
        password: 'directory-pass',
        identity: {
          source: 'LDAP',
          externalId: 'CN=Dave,OU=Users,DC=example,DC=test',
          username: 'dave',
          displayName: 'Dave',
          groups: ['QF Admins'],
        },
      },
    },
  ) {}
  async authenticate(u: string, p: string): Promise<ExternalIdentity | null> {
    const e = this.users[u];
    return e && e.password === p ? e.identity : null;
  }
}
