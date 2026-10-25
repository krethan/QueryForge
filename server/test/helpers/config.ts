import { loadConfig, type AppConfig } from '../../src/config/config.js';

export const baseEnv = {
  NODE_ENV: 'test',
  MAPEPIRE_HOST: 'ibmi.example.test',
  MAPEPIRE_PORT: '8076',
  REPORT_DB_USER: 'QFREPORT',
  REPORT_DB_PASSWORD: 'report-secret',
  REPORT_DEFAULT_SCHEMA: 'SALESLIB',
  META_DB_USER: 'QFAPP',
  META_DB_PASSWORD: 'meta-secret',
  META_SCHEMA: 'QFMETA',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-123',
  APP_ORIGIN: 'http://localhost:5173',
  QUERY_TIMEOUT_MS: '2000',
  MAX_RESULT_ROWS: '100',
  MAX_EXPORT_ROWS: '1000',
  FETCH_BATCH_SIZE: '30',
};

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...baseEnv, ...over } as NodeJS.ProcessEnv);
}
