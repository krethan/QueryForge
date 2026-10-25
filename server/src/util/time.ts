/** Convert a Db2 for i TIMESTAMP value (stored as UTC) to an ISO-8601 string. */
export function dbTimestampToIso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  // ISO "2026-10-23 22:15:03.123456" or Db2 "2026-10-23-22.15.03.123456"
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T-](\d{2})[:.](\d{2})[:.](\d{2})(?:\.(\d{1,12}))?/.exec(s);
  if (!m) return s;
  const ms = (m[7] ?? '0').padEnd(3, '0').slice(0, 3);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}
