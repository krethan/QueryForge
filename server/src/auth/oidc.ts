import * as client from 'openid-client';
import type { AppConfig } from '../config/config.js';
import { AppError } from '../util/errors.js';
import type { ExternalIdentity } from './users.js';

export interface OidcChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** Abstraction over the OIDC relying-party flow so tests and demo mode can substitute a fake IdP. */
export interface OidcProvider {
  readonly label: string;
  /** Build the authorisation URL (code flow + PKCE S256) and the checks to keep until the callback. */
  start(): Promise<{ url: string; checks: OidcChecks }>;
  /** Validate the callback (state, PKCE, nonce, ID token) and return the identity. */
  finish(callbackUrl: URL, checks: OidcChecks): Promise<ExternalIdentity>;
}

type Claims = Record<string, unknown>;

export function identityFromClaims(
  claims: Claims,
  opts: { usernameClaim: string; groupsClaim: string },
): ExternalIdentity {
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub)
    throw new AppError(401, 'SSO_FAILED', 'The identity provider did not return a subject.');
  const pick = (...keys: string[]) =>
    keys.map((k) => claims[k]).find((v) => typeof v === 'string' && v) as string | undefined;
  const username = pick(opts.usernameClaim, 'preferred_username', 'email', 'upn') ?? sub;
  const rawGroups = claims[opts.groupsClaim];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : typeof rawGroups === 'string'
      ? [rawGroups]
      : [];
  return {
    source: 'OIDC',
    externalId: `${String(claims.iss ?? '')}|${sub}`.slice(0, 512),
    username,
    displayName: pick('name', 'given_name') ?? username,
    email: pick('email') ?? null,
    groups,
  };
}

/** Generic OpenID Connect provider using openid-client (authorization code + PKCE). */
export class OpenIdClientProvider implements OidcProvider {
  private config?: Promise<client.Configuration>;
  readonly label: string;
  constructor(private readonly cfg: NonNullable<AppConfig['auth']['oidc']>) {
    this.label = cfg.label;
  }

  private conf() {
    // discovery is lazy so the server starts even when the IdP is temporarily unreachable
    this.config ??= client
      .discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        this.cfg.clientSecret ? undefined : { token_endpoint_auth_method: 'none' },
        this.cfg.clientSecret ? client.ClientSecretPost(this.cfg.clientSecret) : client.None(),
      )
      .catch((e) => {
        this.config = undefined;
        throw new AppError(
          503,
          'SSO_UNAVAILABLE',
          `Single sign-on is unavailable: ${(e as Error).message}`,
        );
      });
    return this.config;
  }

  async start() {
    const config = await this.conf();
    const checks: OidcChecks = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scopes,
      response_type: 'code',
      state: checks.state,
      nonce: checks.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(checks.codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, checks };
  }

  async finish(callbackUrl: URL, checks: OidcChecks) {
    const config = await this.conf();
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      throw new AppError(401, 'SSO_FAILED', `Single sign-on failed: ${(e as Error).message}`);
    }
    const claims = tokens.claims() as Claims | undefined;
    if (!claims)
      throw new AppError(401, 'SSO_FAILED', 'The identity provider did not return an ID token.');
    let merged: Claims = { ...claims };
    // Some IdPs only put groups in userinfo.
    if (!(this.cfg.groupsClaim in merged) && tokens.access_token) {
      try {
        const info = await client.fetchUserInfo(config, tokens.access_token, String(claims.sub));
        merged = { ...info, ...merged };
      } catch {
        /* groups are optional */
      }
    }
    return identityFromClaims(merged, this.cfg);
  }
}
