import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from '../config/config.js';
import { AppError } from '../util/errors.js';
import type { AppUser } from './users.js';

export const SESSION_COOKIE = 'qf_session';
export const CSRF_COOKIE = 'qf_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface Session {
  user: AppUser;
  csrf: string;
  expiresAt: number;
  issuedAt: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    session?: Session;
  }
}

/**
 * Stateless, signed (HS256) session tokens in an HttpOnly, SameSite=Strict cookie.
 * CSRF uses the synchroniser value embedded in the signed session, mirrored in a
 * readable cookie the SPA echoes back in the X-CSRF-Token header, plus an Origin check.
 */
export class SessionService {
  private readonly key: Uint8Array;
  constructor(private readonly cfg: AppConfig) {
    this.key = new TextEncoder().encode(cfg.session.secret);
  }

  private cookieOpts(httpOnly: boolean) {
    return {
      httpOnly,
      secure: this.cfg.session.cookieSecure,
      sameSite: 'strict' as const,
      path: '/',
      maxAge: this.cfg.session.ttlMinutes * 60_000,
    };
  }

  async issue(res: Response, user: AppUser): Promise<Session> {
    const csrf = randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const exp = now + this.cfg.session.ttlMinutes * 60;
    const token = await new SignJWT({
      name: user.displayName,
      usr: user.username,
      role: user.role,
      src: user.authSource ?? 'LOCAL',
      csrf,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .setIssuer('queryforge')
      .sign(this.key);
    res.cookie(SESSION_COOKIE, token, this.cookieOpts(true));
    res.cookie(CSRF_COOKIE, csrf, this.cookieOpts(false));
    return { user, csrf, expiresAt: exp * 1000, issuedAt: now * 1000 };
  }

  clear(res: Response) {
    const o = { path: '/', sameSite: 'strict' as const, secure: this.cfg.session.cookieSecure };
    res.clearCookie(SESSION_COOKIE, { ...o, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, o);
  }

  async read(req: Request): Promise<Session | null> {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: 'queryforge',
        algorithms: ['HS256'],
      });
      if (!payload.sub || typeof payload.csrf !== 'string') return null;
      return {
        user: {
          id: payload.sub,
          username: String(payload.usr),
          displayName: String(payload.name),
          role: payload.role === 'ADMIN' ? 'ADMIN' : 'USER',
          authSource: payload.src === 'OIDC' || payload.src === 'LDAP' ? payload.src : 'LOCAL',
        },
        csrf: payload.csrf,
        expiresAt: (payload.exp ?? 0) * 1000,
        issuedAt: (payload.iat ?? 0) * 1000,
      };
    } catch {
      return null;
    }
  }

  /** Require a valid session; for unsafe methods also require CSRF token + same origin. */
  requireAuth() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const s = await this.read(req);
        if (!s)
          throw new AppError(401, 'UNAUTHENTICATED', 'Your session has expired. Sign in again.');
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) this.checkCsrf(req, s.csrf);
        req.session = s;
        next();
      } catch (e) {
        if (e instanceof AppError && e.status === 401) this.clear(res);
        next(e);
      }
    };
  }

  checkOrigin(req: Request) {
    const origin = req.get('origin');
    if (
      origin &&
      origin !== this.cfg.appOrigin &&
      origin !== `${req.protocol}://${req.get('host')}`
    )
      throw new AppError(403, 'BAD_ORIGIN', 'Cross-origin request rejected.');
  }

  checkCsrf(req: Request, expected: string) {
    this.checkOrigin(req);
    const got = req.get(CSRF_HEADER) ?? '';
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      throw new AppError(
        403,
        'CSRF_FAILED',
        'Security token missing or invalid. Reload the page and try again.',
      );
  }
}
