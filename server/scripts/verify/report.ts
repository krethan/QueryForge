/** Result model, text formatting and JSON shape for the IBM i verification kit. */

export type Status = 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'INFO';

export interface CheckResult {
  section: string;
  id: string;
  title: string;
  status: Status;
  detail?: string;
  migration?: number;
}

export interface VerificationReport {
  tool: 'uncle-bob-verify-ibmi';
  formatVersion: 1;
  startedAt: string;
  finishedAt: string;
  /** Never contains passwords. */
  target: {
    host?: string;
    port: number;
    reportUser?: string;
    metaUser?: string;
    schema?: string;
    dataLibraries: string[];
  };
  mode: 'refused' | 'dry-run' | 'read-only' | 'writes-to-disposable-library';
  refusedBecause: string[];
  results: CheckResult[];
  summary: Record<Status, number>;
  /** Every statement that changed something, in order (all confined to the disposable library). */
  writes: string[];
  readCount: number;
  ok: boolean;
}

export const SECTIONS = [
  'Safety',
  'Static checks',
  'Connectivity',
  'Platform',
  'Read-only reporting profile',
  'Reporting path',
  'Metadata library',
  'Migrations',
  'Schema objects',
  'Metadata queries',
  'Smoke test (disposable library)',
  'Cleanup',
] as const;

export function summarise(results: CheckResult[]): Record<Status, number> {
  const s: Record<Status, number> = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, INFO: 0 };
  for (const r of results) s[r.status]++;
  return s;
}

const MARK: Record<Status, string> = {
  PASS: '[PASS]',
  FAIL: '[FAIL]',
  WARN: '[WARN]',
  SKIP: '[SKIP]',
  INFO: '[INFO]',
};

/** Human-readable report: one block per section, details indented, summary last. */
export function formatReport(r: VerificationReport): string {
  const lines: string[] = [];
  lines.push('Uncle Bob - IBM i verification report');
  lines.push(
    `Target: ${r.target.host ?? '(not set)'}:${r.target.port}  reporting profile: ${r.target.reportUser ?? '-'}  metadata profile: ${r.target.metaUser ?? '-'}`,
  );
  lines.push(
    `Disposable library: ${r.target.schema ?? '-'}  data libraries: ${r.target.dataLibraries.join(', ') || '-'}`,
  );
  lines.push(`Mode: ${r.mode}   Started: ${r.startedAt}   Finished: ${r.finishedAt}`);
  if (r.refusedBecause.length) {
    lines.push('', 'REFUSED - nothing was connected to:');
    for (const e of r.refusedBecause) lines.push(`  - ${e}`);
  }
  const order = [...SECTIONS, ...new Set(r.results.map((x) => x.section))].filter(
    (s, i, a) => a.indexOf(s) === i,
  );
  for (const section of order) {
    const rows = r.results.filter((x) => x.section === section);
    if (!rows.length) continue;
    lines.push('', section);
    for (const row of rows) {
      const mig = row.migration ? ` (migration ${String(row.migration).padStart(3, '0')})` : '';
      lines.push(`  ${MARK[row.status]} ${row.title}${mig}`);
      if (row.detail)
        for (const d of row.detail.split('\n')) if (d.trim()) lines.push(`         ${d}`);
    }
  }
  lines.push('');
  lines.push(
    `Statements: ${r.readCount} read(s), ${r.writes.length} write(s)${r.writes.length ? ` - all inside ${r.target.schema}` : ''}.`,
  );
  const s = r.summary;
  lines.push(
    `Summary: ${s.PASS} passed, ${s.FAIL} failed, ${s.WARN} warning(s), ${s.SKIP} skipped. Result: ${r.ok ? 'PASS' : 'FAIL'}`,
  );
  return lines.join('\n');
}

/** Exit code: 0 all passed (warnings allowed), 1 at least one check failed, 2 refused to run. */
export const exitCode = (r: VerificationReport) => (r.mode === 'refused' ? 2 : r.ok ? 0 : 1);
