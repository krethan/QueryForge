import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { daemonServer, metadataJdbcOptions, reportingJdbcOptions } from '../src/db/mapepire.js';
import { sanitizeErrorMessage, toDbError } from '../src/util/errors.js';
import { dbTimestampToIso } from '../src/util/time.js';
import { baseEnv, testConfig } from './helpers/config.js';

describe('Mapepire configuration', () => {
  it('builds DaemonServer settings for each identity', () => {
    const cfg = testConfig();
    expect(daemonServer(cfg, cfg.reporting)).toMatchObject({
      host: 'ibmi.example.test',
      port: 8076,
      user: 'QFREPORT',
      rejectUnauthorized: true,
    });
    expect(daemonServer(cfg, cfg.metadata)).toMatchObject({ user: 'QFAPP' });
  });
  it('uses read-only access for reporting and the metadata library for metadata', () => {
    const cfg = testConfig({ REPORT_LIBRARIES: 'LIBA,LIBB' });
    expect(reportingJdbcOptions(cfg)).toMatchObject({
      access: 'read only',
      libraries: ['SALESLIB', 'LIBA', 'LIBB'],
      naming: 'sql',
    });
    expect(metadataJdbcOptions(cfg, false)).toMatchObject({
      libraries: ['QFMETA'],
      'auto commit': false,
    });
  });
  it('rejects missing or weak settings', () => {
    expect(() => loadConfig({ ...baseEnv, MAPEPIRE_HOST: '' } as NodeJS.ProcessEnv)).toThrow();
    expect(() =>
      loadConfig({ ...baseEnv, SESSION_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
  it('requires distinct reporting and metadata users in production', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        META_DB_USER: 'QFREPORT',
        COOKIE_SECURE: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});

describe('Db2 for i error handling', () => {
  it('extracts SQLSTATE and SQLCODE from mapepire-js errors', () => {
    const e = toDbError(
      new Error('[SQL0204] ORDERS in SALESLIB type *FILE not found., 42704, -204'),
    );
    expect(e).toMatchObject({
      sqlState: '42704',
      sqlCode: -204,
      status: 400,
      message: '[SQL0204] ORDERS in SALESLIB type *FILE not found.',
    });
  });
  it('maps authority errors to 403 and connection failures to 503', () => {
    expect(toDbError(new Error('Not authorized to object., 42501, -551')).status).toBe(403);
    expect(toDbError(new Error('connect ECONNREFUSED 10.0.0.1:8076'))).toMatchObject({
      status: 503,
      code: 'CONNECTION_ERROR',
    });
  });
  it('sanitizes secrets and stack traces', () => {
    const msg = sanitizeErrorMessage(
      new Error('login failed password=hunter2 for user\n    at Foo.bar (x.js:1:1)'),
    );
    expect(msg).not.toContain('hunter2');
    expect(msg).not.toContain('x.js');
  });
  it('converts stored UTC timestamps to ISO', () => {
    expect(dbTimestampToIso('2026-10-23-22.15.03.123456')).toBe('2026-10-23T22:15:03.123Z');
    expect(dbTimestampToIso(null)).toBeNull();
  });
});
