/**
 * Building share notification e-mails safely. Everything a user typed (display names, report and
 * folder names, group names) is treated as untrusted:
 *  - the HTML part escapes it (& < > " '), so a name cannot add markup or links;
 *  - the text part and the subject drop control characters (CR / LF included), so a name cannot
 *    add or end a mail header, and long values are cut short;
 *  - recipient addresses come only from QF_USERS and must look like a plain address.
 * The e-mails never contain report data: only who shared what, the role, the end date and a link.
 */

/** HTML-escape a value for an element body or a quoted attribute. */
export const escapeHtml = (t: string): string =>
  t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * One line of plain text: control characters (C0, DEL, C1, and the Unicode line / paragraph
 * separators) become a space, runs of spaces collapse, and the result is at most `max` characters.
 */
export function plain(v: unknown, max = 200): string {
  const s = String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A subject line that cannot inject headers: one line, no control characters, at most 150 chars. */
export const safeSubject = (s: string): string => plain(s, 150);

/** A plain address with nothing that could break out of the To header. */
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
export const safeAddress = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s.length <= 254 && ADDRESS_RE.test(s) ? s.toLowerCase() : null;
};

export interface EmailParts {
  subject: string;
  text: string;
  html: string;
}

/** A paragraph of the e-mail: plain strings, with optional emphasised (still escaped) pieces. */
export type Para = (string | { strong: string })[];

/** Render paragraphs as the text and HTML parts, plus an optional link button. */
export function render(
  subject: string,
  paras: Para[],
  link?: { href: string; label: string },
  footer?: string,
): EmailParts {
  const textOf = (p: Para) => p.map((x) => (typeof x === 'string' ? x : x.strong)).join('');
  const htmlOf = (p: Para) =>
    p
      .map((x) =>
        typeof x === 'string' ? escapeHtml(x) : `<strong>${escapeHtml(x.strong)}</strong>`,
      )
      .join('');
  const text = [
    ...paras.map(textOf),
    ...(link ? [`${link.label}: ${link.href}`] : []),
    ...(footer ? ['', footer] : []),
  ].join('\n');
  const html = [
    ...paras.map((p) => `<p>${htmlOf(p)}</p>`),
    ...(link ? [`<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`] : []),
    ...(footer ? [`<p style="color:#6f6f6f;font-size:12px">${escapeHtml(footer)}</p>`] : []),
  ].join('');
  return { subject: safeSubject(subject), text: `${text}\n`, html };
}

/**
 * The app link for an e-mail: the configured public base URL (QF_PUBLIC_BASE_URL, or APP_ORIGIN)
 * plus a fixed path. Never taken from a request's Host header. Only http(s) is accepted.
 */
export function appLink(base: string, path: string): string | null {
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const root = u.href.replace(/\/+$/, '');
    return `${root}${path.startsWith('/') ? path : `/${path}`}`;
  } catch {
    return null;
  }
}

/** "20 Nov 2026, 23:59 (America/Chicago)" in the server's display zone. */
export function formatWhen(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  let zone = timeZone;
  let text: string;
  try {
    text = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: zone,
    }).format(d);
  } catch {
    zone = 'UTC';
    text = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(d);
  }
  return `${text} (${zone})`;
}
