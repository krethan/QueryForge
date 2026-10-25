# QueryForge — IBM i Query Reports

Write read-only SQL against **IBM Db2 for i**, view results in an interactive IBM Carbon table,
save reports to a dashboard, re-run them, export to Excel, and review execution history.
Database access is exclusively through **Mapepire** (`@ibm/mapepire-js` 1.0.2); report metadata is
stored in Db2 for i as well.

> Status: unit/API tests run against in-memory fakes of Mapepire. **This app has not yet been
> connected to or verified against a real IBM i system.** See `docs/IBMI_SETUP.md`.

## Layout

```
server/   Express API (auth, SQL validation, Mapepire execution, XLSX export, metadata repos)
  migrations/  Db2 for i DDL (applied by `npm run migrate`)
  scripts/     migrate.ts, create-user.ts
web/      React + Vite + @carbon/react UI
docs/     IBMI_SETUP.md (Mapepire, profiles, authorities, TLS)
PLAN.md   Design plan
```

## Requirements

Node.js ≥ 20.19 (**22+ strongly recommended**: exact DECIMAL/BIGINT values need `JSON.parse` source-text access, and some Carbon packages declare `>=22`), npm 10+, and a
Mapepire server on IBM i for real use.

## Quick start (development)

```bash
npm install
cp .env.example server/.env      # fill in placeholders — never commit this file
npm run migrate                  # or: npm run migrate -- --print   (hand SQL to a DBA)
npm run user:create -- --username jdoe --name "Jane Doe" [--admin]
npm run dev                      # API on :3001, UI on http://localhost:5173
```

Production: `npm run build && NODE_ENV=production npm start` (server also serves `web/dist`).
Put it behind TLS; set `APP_ORIGIN`, `COOKIE_SECURE=true`, `TRUST_PROXY` as appropriate.

## Demo mode (development only)

`npm run demo` builds the UI and starts the app on http://127.0.0.1:3005 with the **in-memory test fakes**
for both Mapepire and the metadata store. It never connects to IBM i, ignores `.env`, refuses
`NODE_ENV=production`, and is not used by `npm start`/`npm run dev`. Login `demo` / `demo-password-123`;
all rows are fictional. Demo also seeds a parameterized report, reports shared with/by other demo users,
two schedules (e-mail is captured in memory and logged as `[demo mail — not sent]`), a fake SSO button
("Contoso SSO (demo fake)", signs in as Carol in Finance) and a fake directory login (`dave` / `directory-pass`).
The fakes live in `server/test/helpers` and are only reachable from `npm run demo`, which binds 127.0.0.1. With it running, `npm run screenshots` captures 1440×900 PNGs into `screenshots/`
(first time: `npx playwright install chromium`).

## Commands

| Command                                 | Description                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                           | Server (tsx watch) + Vite dev server                                                                            |
| `npm run build`                         | Compile server, typecheck + build web                                                                           |
| `npm start`                             | Run built server                                                                                                |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                                                               |
| `npm run typecheck`                     | `tsc --noEmit` for both workspaces                                                                              |
| `npm test`                              | Server (vitest + supertest, fake Mapepire) and web (vitest + Testing Library)                                   |
| `npm run test:integration`              | Real Mapepire tests; skipped unless `QF_INTEGRATION=1` — non-production only                                    |
| `npm run migrate`                       | Apply metadata migrations                                                                                       |
| `npm run user:create`                   | Create/reset an app user (password via prompt or `QF_NEW_PASSWORD`; `--groups finance,sales` sets local groups) |

## Environment variables (`server/.env`)

| Variable                                                                                      | Default               | Purpose                                                                                         |
| --------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                    | development           |                                                                                                 |
| `PORT` / `HOST`                                                                               | 3001 / 127.0.0.1      | Listen address                                                                                  |
| `APP_ORIGIN`                                                                                  | http://localhost:5173 | Allowed browser origin (CSRF/Origin check)                                                      |
| `TRUST_PROXY`                                                                                 | false                 | Express trust proxy                                                                             |
| `MAPEPIRE_HOST` / `MAPEPIRE_PORT`                                                             | — / 8076              | Mapepire server                                                                                 |
| `MAPEPIRE_REJECT_UNAUTHORIZED`                                                                | true                  | TLS verification                                                                                |
| `MAPEPIRE_CA_FILE`                                                                            | —                     | PEM CA/cert for self-signed servers                                                             |
| `IBMI_DISPLAY_NAME`                                                                           | host                  | Name shown in UI                                                                                |
| `REPORT_DB_USER` / `REPORT_DB_PASSWORD`                                                       | —                     | Read-only reporting profile                                                                     |
| `REPORT_DEFAULT_SCHEMA` / `REPORT_LIBRARIES` / `REPORT_NAMING`                                | — / — / sql           | Job defaults                                                                                    |
| `META_DB_USER` / `META_DB_PASSWORD`                                                           | —                     | Metadata profile                                                                                |
| `META_SCHEMA` / `META_POOL_SIZE`                                                              | QFMETA / 2            | Metadata schema and pool                                                                        |
| `QUERY_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS`                                                     | 60000 / 15000         | Timeouts                                                                                        |
| `MAX_RESULT_ROWS` / `MAX_EXPORT_ROWS`                                                         | 50000 / 100000        | Row caps                                                                                        |
| `RESULT_PAGE_SIZE`                                                                            | 500                   | Rows per page shown in the browser (first page + each "Load next"); capped at `MAX_RESULT_ROWS` |
| `CURSOR_IDLE_TTL_MS` / `CURSOR_MAX_LIFETIME_MS`                                               | 120000 / 600000       | A paged result's Mapepire job is closed after this idle time / absolute lifetime                |
| `MAX_OPEN_CURSORS` / `MAX_OPEN_CURSORS_PER_USER`                                              | 8 / 2                 | Open paged results (each holds one Mapepire job). A user's oldest is closed at their limit      |
| `FETCH_BATCH_SIZE`                                                                            | 500                   | Rows per Mapepire fetch                                                                         |
| `MAX_CONCURRENT_EXECUTIONS` / `MAX_QUERY_LENGTH`                                              | 4 / 32000             |                                                                                                 |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `EXECUTE_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_MAX` | 60000 / 120 / 30 / 10 |                                                                                                 |
| `SESSION_SECRET`                                                                              | —                     | ≥ 32 chars, random                                                                              |
| `SESSION_TTL_MINUTES` / `COOKIE_SECURE`                                                       | 480 / true in prod    |                                                                                                 |
| `PROTECTED_SCHEMAS`                                                                           | —                     | Extra schemas blocked from user SQL                                                             |
| `XLSX_FORMULA_ESCAPE`                                                                         | prefix                | Escape `= + - @` etc. in exported text                                                          |

### Sign-in (local, OIDC, LDAP)

| Variable                                                      | Default                                  | Purpose                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_LOCAL_ENABLED`                                          | true                                     | Local username/password accounts. `false` requires OIDC or LDAP.                                                              |
| `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_REDIRECT_URI`    | —                                        | Enable OIDC (all three together; issuer must be https in production). Redirect URI is `https://<app>/api/auth/oidc/callback`. |
| `OIDC_CLIENT_SECRET`                                          | —                                        | Confidential-client secret (PKCE + state + nonce are always used).                                                            |
| `OIDC_SCOPES`                                                 | openid profile email                     | Requested scopes                                                                                                              |
| `OIDC_USERNAME_CLAIM` / `OIDC_GROUPS_CLAIM`                   | preferred_username / groups              | Claims used for username and groups                                                                                           |
| `OIDC_LABEL`                                                  | Single sign-on                           | Button text                                                                                                                   |
| `LDAP_URL`                                                    | —                                        | `ldaps://…` (or `ldap://` + `LDAP_STARTTLS=true`; plain LDAP is refused in production)                                        |
| `LDAP_STARTTLS` / `LDAP_REJECT_UNAUTHORIZED` / `LDAP_CA_FILE` | false / true / —                         | TLS options                                                                                                                   |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD`                         | —                                        | Service account used to look users up (read-only)                                                                             |
| `LDAP_SEARCH_BASE`                                            | —                                        | Required with `LDAP_URL`                                                                                                      |
| `LDAP_USER_FILTER`                                            | `(sAMAccountName={{username}})`          | Must contain `{{username}}` (value is LDAP-escaped)                                                                           |
| `LDAP_GROUP_ATTRIBUTE` / `LDAP_LABEL` / `LDAP_TIMEOUT_MS`     | memberOf / Directory (LDAP / AD) / 10000 |                                                                                                                               |
| `GROUP_MAP`                                                   | —                                        | `external=app;external2=app2`. Only mapped groups are kept; matching is case-insensitive.                                     |
| `ADMIN_GROUPS`                                                | —                                        | App groups (after mapping) whose members get ADMIN at sign-in                                                                 |

### Scheduled runs and e-mail

| Variable                                    | Default         | Purpose                                                                                                                                                                                         |
| ------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SCHEDULER_ENABLED`                         | false           | Run the scheduler loop in this process (DB lease keeps one runner across instances)                                                                                                             |
| `SCHEDULER_POLL_MS` / `SCHEDULER_LEASE_MS`  | 30000 / 120000  | Poll interval and lease length                                                                                                                                                                  |
| `SCHEDULE_MAX_FAILURES`                     | 3               | Consecutive failures before a schedule is paused                                                                                                                                                |
| `SCHEDULE_MIN_INTERVAL_MINUTES`             | 15              | Reject cron expressions that fire more often                                                                                                                                                    |
| `SCHEDULE_MAX_RECIPIENTS`                   | 20              | Per schedule                                                                                                                                                                                    |
| `SCHEDULE_RECIPIENT_DOMAINS`                | —               | Comma-separated allow-list. **Exact domain match**: `example.com` allows `a@example.com` but **not** `a@sales.example.com` — list each subdomain explicitly. Empty = scheduled e-mail disabled. |
| `SCHEDULE_DEFAULT_TIMEZONE`                 | UTC             | IANA zone pre-selected in the editor                                                                                                                                                            |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE`   | — / 587 / false | `SMTP_SECURE=false` means STARTTLS is **required** (no plaintext fallback)                                                                                                                      |
| `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | —               | Credentials and sender                                                                                                                                                                          |
| `SMTP_REJECT_UNAUTHORIZED` / `SMTP_CA_FILE` | true / —        | TLS verification                                                                                                                                                                                |

## Exact numbers

DECIMAL/NUMERIC and BIGINT values are kept as **strings** from the Mapepire job through the API and the
results grid (which sorts them with an exact decimal comparison). `@ibm/mapepire-js` 1.0.2 parses every
message with a `JSON.parse` reviver that returns a number's original source text when it does not
round-trip as a double; that works on Node.js 22+. On Node 20 those values are rounded before QueryForge
sees them: the server logs a warning at start-up and wide columns (BIGINT, DECIMAL with precision > 15) are
flagged `precisionAtRisk` and shown with a warning icon in the grid.

In XLSX exports a value is written as an Excel number only when it has ≤ 15 significant digits and
round-trips exactly; otherwise it is written as text with a cell note ("Exact value kept as text…", up
to 500 notes per sheet), wide columns get a header note, and the Report Info sheet counts the values kept
as text.

## Paging large results

A run returns the first `RESULT_PAGE_SIZE` rows. If more exist, the server keeps that Mapepire job open as a
short-lived **result cursor** owned by the signed-in user, and the grid shows **"More rows are available —
Load next N rows"**, which calls `POST /api/results/:id/next` (`Query.fetchMore`). Cursors:

- are visible only to their owner (others get 404); an unknown or expired one returns `410 CURSOR_EXPIRED`
  and the UI asks you to re-run;
- slide their expiry on each page, but never beyond `CURSOR_MAX_LIFETIME_MS`; a sweeper closes expired ones and
  their job, so no connection is held past the TTL;
- close automatically at the end of the result or at `MAX_RESULT_ROWS` (then marked "Results limited"), when the
  grid is replaced/unmounted (`DELETE /api/results/:id`), and on server shutdown;
- are limited per user (oldest evicted) and globally; at the global limit the first page is returned with
  `pagingUnavailable` and the UI explains that more rows exist. The execution history row is updated with the
  final row count when the cursor closes.

Client-side sort and filter apply to the rows loaded so far.

## Sharing audit

Every share grant, role change and revoke is written to `QFMETA.QF_SHARE_AUDIT` (migration 003) in the same
transaction as the share change. Owners open **Saved Reports → ⋯ → Access and audit** to see current access and
the history (`GET /api/reports/:id/access`, owner only). The audit table has no foreign key to reports, so the
trail survives report deletion. Saved Reports lists reports you own and reports shared with you, filterable by
owner and by your access (Owner / Editor / Viewer).

## Security model

- Session JWT in HttpOnly SameSite=Strict cookie; double-submit CSRF token + Origin check; login lockout.
- SQL validator: one statement, SELECT/WITH/VALUES only, no `FOR UPDATE`, no protected schemas.
- Execution on a fresh Mapepire job per run as a least-privilege profile with the `access=read only` JDBC option,
  row caps, timeouts (job closed on timeout/cancel), concurrency and rate limits.
- Reports are owner-scoped unless the owner shares them with a user or app group as VIEWER (run/export)
  or EDITOR (also edit SQL/parameters and schedules). Only owners share or delete; access is checked on
  the server for every read, run, export and schedule call. All metadata SQL is parameterised; optimistic
  locking on update.
- Report parameters: values are **always bound** as JDBC parameters (`?`), validated by type
  (string/integer/decimal/date/list) and never concatenated into SQL. Markers must match definitions in
  order. SQL containing `?` with **zero** parameter definitions is rejected before reaching Db2 with
  `400 PARAMETERS_NOT_DEFINED` (ad-hoc runs, saved runs and exports alike).
- SSO: OIDC uses authorization code + PKCE, state and nonce; LDAP binds as the user over TLS after a
  service-account lookup. External users are created on first sign-in (`authSource` OIDC/LDAP is returned
  by `/api/auth/me`); they cannot collide with an existing local username. Groups are re-synced each sign-in.
- Schedules run with the report owner's access via the same validator and read-only job, are recorded in
  history (kind SCHEDULE), and mail only to allow-listed domains over TLS.
- XLSX built server-side with formula-injection escaping. Credentials only in env, never sent to the browser.

## Known limitations

- Not yet validated against a live IBM i / Mapepire server.
- Mapepire 1.0.2 has no statement cancel API; cancel/timeout close the job.
- On Node.js 20, DECIMAL > 15 digits and BIGINT are rounded inside mapepire-js before reaching the server
  (flagged in the UI); use Node.js 22+. The exact-value path has been tested with fakes only.
- Paged results are capped at `MAX_RESULT_ROWS`; each open cursor holds one Mapepire job until it completes,
  is closed, or expires. Sort/filter only cover loaded rows. Paging has been tested with a fake Mapepire job only.
- OIDC, LDAP and SMTP are implemented against their standard protocols but have **only been tested with
  in-process fakes** — not with a real IdP, directory or mail server.
- Schedule times are computed with the server runtime's ICU time-zone data. Alberta moved to permanent
  UTC−6 (tzdata 2026c); an older Node/ICU will still assume a fall-back on 2026-11-01 for
  `America/Edmonton`, shifting runs by an hour. Keep Node current (or use a fixed zone such as `Etc/GMT+6`).
- Schedules use 5-field cron; one scheduler runner at a time (DB lease). Missed runs while stopped are not
  back-filled; the next future time is used.
- Attachments are capped by `MAX_EXPORT_ROWS`; very large exports may exceed mail-server size limits.
- Sharing has no expiry. The audit records changes made through QueryForge only (not direct SQL edits), and
  is not written for shares removed by report deletion.
- Saved Reports page lists owned reports; shared reports appear under “Shared with me” on the dashboard.
