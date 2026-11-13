# Uncle Bob

**Bob's your uncle** — Uncle Bob is a browser-based SQL reporting tool for IBM i (IBM Db2 for i).

> The GitHub repository is still named **QueryForge** ([`krethan/QueryForge`](https://github.com/krethan/QueryForge)); only the product/display name changed. Internal
> identifiers are unchanged too — `QF_*` environment variables, the `QFMETA` Db2 schema and
> `QF_*` tables, the session cookie name, and `qf-*` CSS classes — so existing installs keep
> working.

[![CI](https://github.com/krethan/QueryForge/actions/workflows/ci.yml/badge.svg)](https://github.com/krethan/QueryForge/actions/workflows/ci.yml)

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
all rows are fictional. Demo also seeds a parameterized report, reports shared with/by other demo users, shared folders,
three schedules (one with a delivery already in its history; e-mail is captured in memory and logged as `[demo mail — not sent]`), a fake SSO button
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
| `CATALOG_CACHE_TTL_MS`                                                                        | 60000                 | How long the Report Builder caches `QSYS2` catalog reads in memory (`0` disables the cache)     |
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
round-trip as a double; that works on Node.js 22+. On Node 20 those values are rounded before Uncle Bob
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

## Report Builder

**Report Builder** (nav item next to _New Report_) builds a report from a table instead of from typed SQL.
You search the Db2 for i catalog, pick a table, tick the columns you want (in the order you want them),
add one or more sort keys with ASC/DESC, and Uncle Bob generates and runs the `SELECT`.

```
GET  /api/schema/tables                                 ?search=…&limit=…
GET  /api/schema/tables/:schema/:table/columns
POST /api/schema/sql                                    { schema, table, columns, sort, filters, groupBy, aggregates, having }
POST /api/schema/run                                    { …spec, executionId, values }
POST /api/schema/join-suggestions                       { tables: [{ alias, schema, table }], schema, table }
```

- The list comes from `QSYS2.SYSTABLES` (`TABLE_TYPE` in `T`, `P`, `V`, `L`, `A`, `M`, `SYSTEM_TABLE = 'N'`) and
  is filtered with `QSYS2.SQL_CHECK_AUTHORITY(library, file) = 1`, i.e. it shows what the read-only reporting
  profile can actually read (directly, via a group profile, `*PUBLIC` or an authorization list). Columns come
  from `QSYS2.SYSCOLUMNS`. When `REPORT_LIBRARIES` is set only those libraries are listed, otherwise everything
  except the system catalogs and `PROTECTED_SCHEMAS`. Results are bounded (500 tables / 1000 columns per read,
  100 tables per page) and cached in memory for `CATALOG_CACHE_TTL_MS`.
- Search terms, schema and table names are always **bound as `?` parameters**; they are never interpolated into
  the catalog SQL. The list runs through the same validator, read-only job and rate limits as an ad-hoc query.
- The browser **never sends SQL**. It sends a schema, a table, column names and sort directions; the server
  resolves each name against its cached catalog metadata (rejecting anything that is not an exact catalogue
  entry, and rejecting ambiguous case-insensitive matches), then emits the statement with Db2 for i delimited
  identifiers (`"NAME"`, embedded quotes doubled), always schema-qualified. `ORDER BY` only accepts `ASC`/`DESC`
  literals chosen from the UI. Preview (`POST /api/schema/sql`) and Run (`POST /api/schema/run`) build the same
  statement; the built SQL is validated once more before execution.
- **Save as report** creates a normal saved report from the generated SQL (plus any filter parameters) and opens its editor,
  so it shows up in _Saved Reports_, can be shared, scheduled and exported like any other report.

### Joining tables

**Add table** (with a join-type picker: inner, left outer, right outer, full outer) adds up to **8** more tables.
Each joined table gets an alias (default `T2`, `T3`, … with the base table `T1`; custom aliases must match
`^[A-Z][A-Z0-9_]{0,9}$`) and one or more `ON` equalities that are AND-ed together. The left side of each
condition is a column of a table added earlier; the right side is a column of the joined table. The same table
can be joined to itself under a different alias (for example `EMPLOYEES E` joined to `EMPLOYEES MGR`).

- **Suggestions**: when a table is added, the server reads foreign keys between it and the tables already in the
  report from `QSYS2.SYSREFCST` / `SYSCST` / `SYSKEYCST` (both directions, all key columns), and otherwise
  suggests same-name columns with compatible types. The first suggestion is applied; the user can pick another,
  edit the condition rows, add more or remove them.
- Columns are grouped by table and emitted alias-qualified (`"T2"."NAME"`); names that would repeat in the result
  get unique `AS` names (`CUSTOMERS_NAME`, then `ALIAS_NAME`). Sorting can use any column of any table, picked or
  not. A compact diagram shows the join chain and a live SQL preview shows the generated `JOIN … ON …`.
- Validation is server-side: every table/column is resolved against the catalog, aliases and join types are
  checked, each join needs at least one condition referring only to earlier tables, and numeric/character/date
  mismatches in `ON` are rejected (DATE vs TIMESTAMP is allowed with a warning). The browser still never sends SQL.
- Joins can multiply rows (one result row per match); the UI says so, and results are still paged with
  _Load more_ like any other query.
- Joined columns, filters, groups and totals are all alias-qualified the same way.

### Filters

**Add filter** adds a `WHERE` row: column, condition and a type-aware value input (number keypad for numeric
columns, a date picker for `DATE`, one value per line for _is one of_). Conditions: `=`, `<>`, `<`, `<=`, `>`,
`>=`, `BETWEEN`, `IN`, _contains_ / _starts with_ / _ends with_ (`LIKE … ESCAPE`, text columns only), _is empty_
(`IS NULL`) and _is not empty_. The top level is either all **AND** or all **OR** (_Rows must match_), with one
optional level of **groups** (`Add group`), each AND or OR. Limits: 30 filters, 10 groups, 100 `IN` values,
1000 characters per value.

- **Every value is bound with `?`**; the server never splices a value into the SQL. Fixed values travel as
  hidden report parameters named `QF_F1`, `QF_F2`, … (`QF_H…` for totals); the `QF_` prefix is reserved and they
  are never shown in run prompts. For `LIKE`, the server escapes `%`, `_` and the escape character, then adds
  the wildcards.
- **Ask when run** turns a filter into a normal report parameter (name, prompt and optional default): the Run
  button then shows the usual parameter dialog, and a saved report prompts like any hand-written one. `BETWEEN`
  creates two parameters, `NAME_FROM` and `NAME_TO`.

### Grouping and totals

**Group & totals** adds `GROUP BY` columns and totals: `COUNT(*)`, `COUNT`, `COUNT DISTINCT`, `SUM`, `AVG`, `MIN`
and `MAX`, each with a friendly column name (letters, digits, `_` and spaces; defaults such as `Sum of AMOUNT`).
`SUM`/`AVG` are only offered (and only accepted by the server) for numeric columns. Selected columns that are not
totals are added to `GROUP BY` automatically. **Total filters** become `HAVING` conditions with bound values, and
sort keys can be a total (`ORDER BY SUM(…) DESC`).

### Saving and reopening (migration 004)

**Save as report** stores the generated SQL _and_ the builder definition (`{ version: 1, spec }`) in
`QF_REPORTS.BUILDER_DEF` (`CLOB(1M)`, migration `004_report_builder_def.sql`). On every save the server
re-validates the definition against the catalog and regenerates the SQL and parameters itself; the SQL the browser
sends is ignored for builder reports. Reports written as SQL keep working unchanged (`BUILDER_DEF` is `NULL`).

**Open in Report Builder** (report editor header) reopens a builder report as editable at
`/report-builder?report=ID`, with _Save changes_ (same report, optimistic version check) and _Save as new report_.
If a table or column has since disappeared, the button is disabled and shows the server's reason. See
[`docs/IBMI_SETUP.md`](docs/IBMI_SETUP.md#migration-004--report-builder-definitions) for applying the migration (no new grants needed).

Limitations: joins only on column equality; calculated fields have their own limits (see below); one level of filter groups;
filters on totals only compare numbers; changing a builder report's SQL by hand in the SQL editor detaches it
from the builder (the definition is dropped on that save, so it can no longer be reopened in the builder). Views, logical files, aliases
and MQTs are listed alongside physical tables, and whether they are read-only depends on the object itself;
LOB/XML/DATALINK/ROWID columns are listed but may be awkward to display; the table list is cached for
`CATALOG_CACHE_TTL_MS`, so new objects/grants appear after that; mixed-case or system-named objects are emitted
with the catalog's spelling (`SYSTEM_TABLE_NAME`/`SYSTEM_TABLE_SCHEMA` are used for the authority check), and a
name that differs only by case from another object is treated as ambiguous. Like the rest of the app, this has
been tested with fakes only — not against a live IBM i.

### Calculated fields (builder definition version 2)

**Calculated fields** (Report Builder, under the column list) add named expressions such as
`QTY * UNIT_PRICE` or `CASE WHEN AMOUNT > 1000 THEN 'Big' ELSE 'Small' END`. Each one has a name, an expression box
with an **Insert field** picker, a live server check (inline error with a caret at the position, or a
`Result: number (decimal)`-style type hint) and a **Show as a column** switch. A calculated field is marked **ƒ** in
every picker and can be used as an output column, a sort key, a filter, a group-by column, the column of a total
(and so in total filters/`HAVING`), a chart axis or series, a drill column (including drill-to-report) and in Excel
export.

- **Grammar** (hand-written parser, no `eval`, no new dependencies): column names (`COL`, or `T2.COL` when tables are
  joined; `"quoted"` names allowed), numbers, `'strings'`, `DATE 'YYYY-MM-DD'`, `NULL`, `+ - * /`, `||`, parentheses,
  `CASE WHEN … THEN … [ELSE …] END` with `= <> != < <= > >=`, `AND`/`OR`/`NOT` and `IS [NOT] NULL` in conditions, and
  the functions `COALESCE`, `NULLIF`, `ROUND`, `ABS`, `UPPER`, `LOWER`, `TRIM`, `SUBSTR` (also spelled `SUBSTRING`),
  `LENGTH`, `YEAR`, `MONTH`, `DAY`. Every column is checked against the QSYS2 catalog for the tables in the report.
- **The browser never sends SQL.** It sends the expression text; the server parses it, type-checks it and generates the
  SQL itself, and recomputes the stored result type on save.
- **Literals are re-serialized, not copied.** Numbers and strings are inlined into the generated SQL in a canonical
  form the server writes itself (strings re-quoted with `'` doubled, numbers normalised), not as `?` markers, so the
  order of the report's other bound parameters never changes. Nothing the user typed is pasted into the SQL verbatim.
- **Division uses `NULLIF`:** `a / b` becomes `(a) / NULLIF((b), 0)`, so dividing by zero gives `NULL` instead of an
  error. When both sides are integers the result is wrapped in `INTEGER(…)` so the type is predictable.
- `SUBSTR` is generated as `SUBSTRING`, which does not fail when the range runs past the end of the value.
- **Limits:** 1,000 characters per expression, nesting depth 20, 500 tokens, string literals up to 200 characters,
  numbers up to 31 digits, 20 calculated fields per report.
- **Not supported:** TIME, LOB, XML and binary columns; one calculated field referring to another; date arithmetic
  (`date + 1`, date differences); aggregate functions inside an expression (use a total instead); a bare condition
  as a value (use `CASE`).
- **Saving:** a definition with calculated fields is saved as `{ version: 2, spec }`; definitions without them stay
  version 1, and a version 1 definition that contains calculated fields is rejected. Both live in the existing
  `QF_REPORTS.BUILDER_DEF` JSON column, so **no database migration is needed**. Older app builds will refuse to
  reopen a version 2 definition rather than misread it.
- **Excel export** writes the computed values only, never Excel formulas.
- **Demo mode** computes calculated fields from the demo rows itself (the demo `ORDER_LINES` table has `UNIT_PRICE`
  and some `NULL` quantities to exercise this).
- Like the rest of the app, calculated fields have been tested with fakes and the demo engine only. **Nothing here
  has been tested against a real IBM i**; in particular the generated Db2 for i SQL (e.g. `SUBSTRING`, `INTEGER`,
  `DECIMAL` precision of results) has not been run on a real system.

### Pivot reports (builder definition version 3)

Turn on **Pivot** in the Report Builder to show a crosstab: one to five **row fields**, one
**column field**, and one **value** (Sum, Count, Average, Minimum or Maximum of a field, or
Count of rows). Calculated fields can be used as row, column or value fields; filters, prompts
(parameters) and joins apply as usual. While a pivot is on, the builder's own grouping, totals
and sort are replaced by the pivot.

How it works:

- The browser sends only the pivot definition (field names). The server builds one ordinary
  `GROUP BY` query over the row and column fields (Average also selects a hidden `SUM` and
  `COUNT` so totals are exact) and pivots the grouped rows in memory. There is no dynamic
  column SQL: the column values never become SQL text.
- **Column cap:** if the column field has more than **50** distinct values the run stops with
  a message naming the field and suggesting a filter (or a column field with fewer values).
  The grouped query is also limited to 10,000 groups (or the configured row limit, if lower);
  beyond that the run stops with "too large" rather than showing partial totals.
- Row, column and grand totals are computed on the server with exact decimal arithmetic for
  Sum, Count, Minimum and Maximum. Average totals are total sum ÷ total count (not an average
  of averages); integer averages are truncated like Db2's `AVG` on integers.
- `NULL` column values get their own `(null)` column (shown last); `NULL` row values show as
  `(null)`. Empty cells mean no rows for that combination and are not clickable.
- Click any cell or total on a **saved** report to open the existing drill-down with those row
  and column values (`IS NULL` for the `(null)` column). The grand total drills with no keys.
- **Export pivot to Excel** writes the same layout (row fields, one column per value, Total
  column and Total row) as plain values, no formulas.
- The chart panel offers a stacked bar (Sum/Count) or grouped bar (other functions) by default,
  drawn from the grouped rows: first row field on the axis, column values as series.

Storage: the pivot is saved in the builder definition JSON, which is saved as **version 3**
only when a pivot is used; version 1/2 reports load and save unchanged, so **no database
migration is needed** (the definition is already a JSON column). The server rejects a pivot in a
version 1 or 2 definition. The demo engine runs the same grouped SQL, so demo pivots are real
results of the demo data, not mock grids.

Limits:

- Column order is the server's sort (numbers numerically, other values by code point, `(null)`
  last), which may differ from Db2 for i collation for accented or mixed-case text.
- Plain **Run** of the SQL, schedules and dashboards run the grouped (long) form, not the grid.
- One value field and one column field per pivot; at most 50 columns and 5 row fields.
- **Not tested against a real IBM i.** Pivots have only been run against the demo engine and
  the unit tests.

## Date range presets

SQL date parameters and Report Builder date filters can use a rolling range instead of a fixed date: **Today, Yesterday, This/Last week, This/Last month, This/Last quarter, Year to date, Last year, Last N days (1–3650, including today), or Custom**. For an "Ask when run" date filter, the preset is the default at each run. Saved schedules keep the preset, not the date that happened to be current when the schedule was saved; previously cached literal schedule values are ignored for rolling definitions.

The server resolves every range just before binding its `?` markers. The configured **`DATE_PRESET_TIMEZONE`** (default `SCHEDULE_DEFAULT_TIMEZONE`, which defaults to `UTC`) determines the calendar date, independently of the browser's time zone. **UTC is the default deployment zone**: this week is Monday–Sunday and quarters are calendar quarters. A single-date preset becomes an inclusive `BETWEEN` covering the appropriate calendar day(s). Last N days includes today, so N=1 means Today.

The definition stores the preset in the existing `PARAMETERS_JSON` and `BUILDER_DEF` JSON. There is **no database migration**. Existing literal date defaults and reports continue through the old binding path. Resolved values remain parameters, never SQL text, and invalid or tampered presets are rejected.

Limits: rolling filters apply to date columns, not timestamps; there is no fiscal calendar, relative timestamps or arbitrary day-of-week offset. Presets are not evaluated in the browser. A standalone SQL date parameter receives the range start; the generated Builder/SQL range pair receives both bounds. On each interactive or scheduled run the server resolves the stored preset again; schedules contain no resolved preset dates. **Not tested against a real IBM i**: date handling has only been checked with unit/API tests and the demo, never with Db2 for i.

## Charts

Results in the SQL editor and the Report Builder can be shown as a **Table**, a **Chart** or **Both**.
Chart types: bar, horizontal bar, grouped bar, stacked bar, line, area, pie and donut. Pick an X field,
one or more value (Y) fields or a series field, and optionally a title, a sort and a top-N limit.
When you first switch to Chart, a chart is suggested from the column types (text X → bar, date X → line).

- Charting uses `@carbon/charts-react` (d3) loaded lazily in its own `charts` chunk, so pages that
  never draw a chart do not download it.
- Charts plot the rows loaded in the browser; a note appears when the server has more rows, and when
  DECIMAL values are converted to floating point for plotting (the table and Excel stay exact).
- The chart is saved with the report as versioned JSON (`version: 1`) in `QF_REPORTS.CHART_DEF`
  (migration 005, `CLOB(64K)`), validated on the server. A saved chart that names a column the query
  no longer returns is disabled with a message rather than failing.
- **Dashboard:** tick "Show chart on dashboard" to get a mini chart on the tile. It is fetched fresh with
  your permissions and the parameters' default values; it loads on click unless "Run automatically when
  the dashboard opens" is also ticked.
- **Excel / email:** exports add a **Chart** sheet with a PNG picture of the chart (rendered on the
  server; omitted above 50,000 rows), and scheduled emails embed and attach the same PNG.
- The demo includes "Revenue by Region (chart)", "Daily Revenue (chart)" and "Orders by Status (chart)".
  `node scripts/screenshots-charts.mjs` captures chart screenshots from a running demo.

## Drill-down

Click a bar, slice or point in a chart (or a row of a grouped table) to open the
detail rows behind it in a side panel with a breadcrumb (`Revenue by Region > West`),
**Back** and **Export to Excel**. A dashboard mini chart click opens the report with
the drill applied (`/reports/:id?drill=…`).

- **Report Builder reports** with grouping drill automatically. The server derives the
  detail query from the saved definition: same tables, joins, filters and ask-when-run
  parameters, plus `= ?` (or `IS NULL`) for each clicked group field; no GROUP BY or
  totals. The client only sends field names and values, never SQL; fields are checked
  against the report's group fields and values are bound. The detail columns default
  to the group fields, the aggregated columns and base-table columns, and can be
  changed in the panel.
- **Drill to report X** (report settings → Drill-down): map clicked fields to X's
  parameters. Only reports the editor can run are listed, and access to X is checked
  again for whoever clicks; a target the viewer cannot run is not offered. Drills nest
  when X itself drills somewhere.
- **SQL-only reports** drill only through a configured target; otherwise nothing is
  clickable.
- Endpoints: `POST /api/reports/:id/drill`, `POST /api/reports/:id/drill/export`,
  `GET /api/reports/:id/drill-targets`, `PUT /api/reports/:id/drill`.
- Storage: no migration. The drill target is kept in the existing chart column as a
  version 2 envelope `{"version":2,"chart":…,"drill":…}`, written only when a target is
  set; version 1 chart JSON is still read as before.

## Sharing audit

Every share grant, role change and revoke is written to `QFMETA.QF_SHARE_AUDIT` (migration 003) in the same
transaction as the share change. Owners open **Saved Reports → ⋯ → Access and audit** to see current access and
the history (`GET /api/reports/:id/access`, owner only). The audit table has no foreign key to reports, so the
trail survives report deletion. Saved Reports lists reports you own and reports shared with you, filterable by
owner and by your access (Owner / Editor / Viewer).

## Folders and favorites

Each user organises the dashboard for themselves:

- **Favorites.** The star on a report tile adds it to a **Favorites** section at the top of the
  dashboard (owned and shared reports alike). Click it again to unstar.
- **Folders.** **Manage folders** creates, renames and deletes your folders (names are unique per user,
  case-insensitive; "Unfiled" and "Favorites" are reserved). The folder button on a tile moves that
  report into a folder or back to **Unfiled**. The **Folder** filter shows one folder (or Unfiled), and
  **Group by folder** shows a section per folder plus Unfiled.
- **Deleting a folder never deletes reports.** Its reports move to Unfiled, in one transaction.
- **Sharing a folder** is optional; see [Shared folders](#shared-folders). A folder nobody has shared
  works exactly as described here.

Folders and stars belong to the viewing user, not to the report. A report someone shares with you can be
filed and starred by you without changing what the owner (or anyone else) sees. The server enforces this:
every statement on the folder tables is parameterised and scoped by the signed-in user's ID; renaming,
deleting or filing into another user's folder returns 404; starring or filing a report needs at least view
access to it (`PUT /api/reports/:id/prefs`), and a report you lose access to drops off your dashboard
along with its folder placement.

API: `GET/POST /api/folders`, `PUT/DELETE /api/folders/:folderId`, `PUT /api/reports/:id/prefs`
(`{ folderId?: uuid | null, favorite?: boolean }`). `GET /api/reports` adds `folderId` and `favorite` to
each report.

Storage is migration `006_folders_favorites.sql` in `META_SCHEMA` (QFMETA by default):

- `QF_FOLDERS` (FOLDER_ID, OWNER_ID, FOLDER_NAME, FOLDER_NAME_KEY, timestamps). Folder names are unique
  per `(OWNER_ID, FOLDER_NAME_KEY)`. The foreign key to `QF_USERS` uses ON DELETE CASCADE.
- `QF_REPORT_PREFS` (USER_ID, REPORT_ID, FOLDER_ID, IS_FAVORITE, UPDATED_AT) with primary key
  `(USER_ID, REPORT_ID)`. FOLDER_ID NULL means Unfiled. Foreign keys: the user and report use ON DELETE
  CASCADE, and the folder uses ON DELETE SET NULL. A row is removed once a report is both unfiled and
  unstarred.

Both tables are on the protected-objects list, so reporting SQL cannot read them. The migration and the
routes have only been tested against the in-memory fake metadata database. They have not been run on a
real IBM i or Db2 for i yet.

## Shared folders

A folder owner can share a folder with users or app groups, like a report:

- **Share.** In **Manage folders**, the share button on one of your folders opens the same Share dialog
  as reports. Grant **Viewer** (see the folder) or **Editor** (also add, remove and reorder its reports),
  change a role or revoke it. The strongest direct or group grant applies, and group membership changes
  take effect at once. **Only the owner** can share, rename or delete a folder.
- **Sharing a folder never shares the reports in it.** Report access still comes only from the report's
  owner and its own shares. Each person sees the folder and **only the reports in it that they can already
  see**. Counts and order are worked out from those reports alone, so a hidden report is never listed,
  counted or named. If a report's share is revoked, it disappears from the folder for that person at once;
  the folder itself stays.
- **What is in a shared folder.** The owner's own filing (the folder button on a tile) plus the reports
  anyone who may edit the folder put there. Editors use the folder button on a tile: below your own
  folders, **Shared folders you can edit** lists the folders you can add the report to or take it out of.
  An editor can only add or remove reports they can see; anything else is a 404. Taking a report out of a
  shared folder takes it out for everyone (if the owner had filed it there, it becomes Unfiled for the owner,
  who keeps their star). An owner who moves a report to another of their own folders also takes it out of
  their other (shared) folders, so "Move" still means one place among your own folders.
- **On the dashboard**, shared folders appear in the **Folder** filter and in **Group by folder** next to
  your own, named "Folder (Owner)" when someone else owns them, with a "Shared folder" line giving the owner
  and your role. A report can be in your own folder and in any number of shared folders; **Unfiled** means
  "in none of the folders you can see". Under **My order**, a shared folder's section follows the folder's
  own shared order; editors (and the owner) can drag it or use the arrow keys, viewers cannot. Positions
  for reports you cannot see are kept where they are. Personal folders keep using your own tile order.
- **Deleting a shared folder** deletes no report. Its shares and shared placements go with it in the same
  transaction; your filed reports become Unfiled; the people it was shared with simply lose the folder. Their
  own folders and stars are untouched.
- **Admins** are editor-equivalent on every folder that is shared with anyone (they see every report, so
  they see a shared folder's full contents), and may read its shares and audit history, but cannot share,
  rename or delete a folder they do not own. A personal (unshared) folder stays private to its owner, even
  from admins, like their favorites.
- A folder you can see but not edit, or a share you hold, never lets you file into it with
  `PUT /api/reports/:id/prefs`; personal filing still only targets your own folders.

API (all checked on the server by `FolderAccessService`; folders you cannot see are 404, too little access
is 403):

- `GET /api/folders` lists your folders, then folders shared with you. Each has `ownerId`, `ownerName`,
  `access` (OWNER, EDITOR, VIEWER or ADMIN), `shared`, and `reportIds` (the reports in it you can see, in
  folder order). `GET /api/folders/:folderId` returns one.
- `GET/PUT /api/folders/:folderId/shares` (`{ shares: [{ type: 'USER' | 'GROUP', id, role }] }`, owner only
  for PUT; owner or admin for GET) and `GET /api/folders/:folderId/access` (owner and admin: shares and the
  audit trail).
- `POST /api/folders/:folderId/reports` (`{ reportId }`), `DELETE /api/folders/:folderId/reports/:id` and
  `PUT /api/folders/:folderId/order` (`{ reportIds: uuid[] }`, at most 2000) need Editor on the folder and
  view access to each report. Unknown or hidden IDs in an order are dropped without saying whether they
  exist.

Storage is migration `009_shared_folders.sql`, which is additive (three new tables and their indexes;
nothing existing is altered and no row is touched):

- `QF_FOLDER_SHARES` (FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE, CREATED_BY, CREATED_AT) mirrors
  `QF_REPORT_SHARES`: primary key `(FOLDER_ID, PRINCIPAL_TYPE, PRINCIPAL_ID)`, `USER`/`GROUP` and
  `VIEWER`/`EDITOR` checks, ON DELETE CASCADE from `QF_FOLDERS`, and a covering index on the principal.
- `QF_FOLDER_REPORTS` (FOLDER_ID, REPORT_ID, ITEM_POS, ADDED_BY, ADDED_AT): reports placed in a folder and
  the shared order (ITEM_POS NULL = no saved position, sorted after positioned reports by name). Primary
  key `(FOLDER_ID, REPORT_ID)`; ON DELETE CASCADE from both the folder and the report, so it never deletes
  a report. The owner's own filing stays in `QF_REPORT_PREFS` (006) and is counted as being in the folder.
- `QF_FOLDER_SHARE_AUDIT`, like `QF_SHARE_AUDIT` (003): every grant, role change and revoke, written in the
  same transaction, with no foreign key so the trail survives the folder.

All three tables are on the protected-objects list. **This feature has not been tested on a real IBM i.**
The tests run against the in-memory fake metadata database and in-process API; migration 009 has never
been applied to Db2 for i.

## Rearranging dashboard tiles

The dashboard's **Sort by** list starts on **My order**, each user's own tile order:

- **Drag a tile** onto another tile to move it there (it lands before or after the target, depending on
  which half you drop on). From the keyboard, focus the tile's drag handle and use the arrow keys
  (**Home**/**End** move it to the start or end). A screen-reader announcement confirms each move.
- Tiles move within their section (Favorites, My reports, Shared with me, or a folder). The dashboard keeps
  one order across all of them, so a move in one section never shuffles tiles outside it.
- The order is saved on the server straight away and comes back after a reload or on another browser.
  **Reset order** forgets it and returns to name order.
- With no saved order, My order is name order. New reports and reports newly shared with you appear after
  the tiles you have arranged, in name order, until you move them.
- Rearranging is turned off while a search is active (the saved order would otherwise lose the hidden
  tiles) and under the other sort options.

The order belongs to the viewing user, like folders and favorites. The server only stores or applies
positions for reports the user can see right now (own, shared directly or through a group, or every report
for a global admin). IDs for other reports are dropped without saying whether they exist. If a share is
revoked, that report's position is ignored at once and removed the next time the user saves an order. If
it is shared again, it comes back as a new tile at the end.

API: `GET /api/reports?sort=custom` returns tiles in the user's order, and `GET /api/reports` adds
`tilePos` (0-based, or `null` when not placed) to each report. Use `GET/PUT/DELETE /api/dashboard/tile-order`
to read, replace (`{ reportIds: uuid[] }`, unique, at most 2000) or clear the order.

Storage is migration `008_dashboard_tile_order.sql`, which only adds the table `QF_TILE_ORDER`
(USER_ID, REPORT_ID, TILE_POS, UPDATED_AT). It has primary key `(USER_ID, REPORT_ID)` and a `TILE_POS >= 0`
check, and its foreign keys to `QF_USERS` and `QF_REPORTS` use ON DELETE CASCADE. Saving replaces the
user's rows in one transaction. The table is on the protected-objects list. As with 006, this has only been
tested against the in-memory fake metadata database, not on a real IBM i.

## Scheduled report delivery

Owners and Editors (and administrators, who are Editor-equivalent) can e-mail a saved report as its **Excel export** on a schedule. Open the report and choose **Schedule**, or use the **Schedules** page, to create, edit, pause, resume, run now, delete and see the delivery history of each schedule. Viewers can't manage schedules.

- **When:** daily, weekdays (Monday to Friday), weekly on a chosen day, or monthly on day 1–28 or the **last day of the month**, at a chosen time in a chosen **IANA time zone**. Days 29–31 aren't offered because some months don't have them. A custom 5-field cron expression is still available for anything else, and existing cron schedules keep working. Friendly cadences are stored as the equivalent cron expression in `QF_SCHEDULES.CRON_EXPR` and the next run is always computed in the schedule's own zone (`cron-parser`), never the server's local clock; the editor previews the next runs.
- **Who:** every recipient must be an active Uncle Bob user who can **already open the report** (owner, a user or group share, or an administrator), matched by the e-mail address on their account, and must be in `SCHEDULE_RECIPIENT_DOMAINS`. The editor lists the people the report is shared with; anyone else is refused with `RECIPIENT_NO_ACCESS` until the report is shared with them. Access is checked again at **every delivery**: someone who has lost access is left out (and named in the schedule's last result and delivery history); if nobody is left, the run fails and nothing is sent.
- **Runs:** the in-process scheduler (`SCHEDULER_ENABLED=true`) polls, takes the Db2 lease, claims each due schedule with a conditional update, runs the report with the report owner's access, and records the last run, status, error and next run. Pausing clears the next run; resuming starts from the next occurrence after now (missed runs are not replayed) and resets the failure count. After `SCHEDULE_MAX_FAILURES` failures in a row a schedule pauses itself.
- **Mail:** SMTP settings and credentials live only in the server environment; the browser only learns whether e-mail is configured. Without SMTP, saving an active schedule, resuming and **Run now** fail with `503 MAIL_NOT_CONFIGURED` (a paused schedule can still be saved), and a due schedule records a clear failure. Demo mode and tests use an in-memory mailer that never sends anything.
- **History (migration 010):** `QF_SCHEDULE_DELIVERIES` keeps one row per delivery attempt (on schedule or Run now, who pressed it, rows, who it went to, who was left out, error). Deleting a schedule removes its delivery history; the runs stay in report history. Nothing else is altered.

API: `GET/POST /api/reports/:id/schedules`, `GET /api/reports/:id/schedule-recipients`, `PUT/DELETE /api/schedules/:id`, `POST /api/schedules/:id/pause`, `/resume`, `/run`, `GET /api/schedules/:id/deliveries`, `POST /api/schedules/preview` (send `cadence` or `cron` plus `timezone`).

**Not tested on a real IBM i or a real mail server.** The scheduler, recipient checks, delivery history and migration 010 have only been exercised against the fake metadata/query adapters, the in-memory mailer and the demo; migration 010 has never been applied to Db2 for i.

Limitations: no per-recipient bursting or filtering, no Slack/Teams delivery, no calendar invites, no external (non-user) addresses or distribution lists, no notification when someone is left out other than the schedule's status and history, no retention limit on delivery history, and one Excel attachment per run (capped by `MAX_EXPORT_ROWS`).

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
  history (kind SCHEDULE), and mail only over TLS to allow-listed domains and only to users who can
  already open the report (re-checked at every delivery).
- XLSX built server-side with formula-injection escaping. Credentials only in env, never sent to the browser.

## Conditional formatting

Owners and editors can choose **Conditional formatting** in a saved report’s result toolbar. Up to 20 ordered rules support `>`, `>=`, `<`, `<=`, `=`, `<>`, between, contains, and is null, each with a Cell or Whole row target and a small Carbon-friendly palette. Rules match normal and grouped output columns, calculated fields, pivot row fields and pivot values/totals. On pivots, choose the `PIVOT_VALUE` aggregate output; it is mapped to the friendly measure label in the saved JSON. A matched row rule spans the row; a matched rule on its own column is painted there, so specific-cell colours take precedence over a row colour. Earlier rules win.

Rules live in the existing `CHART_DEF` presentation JSON with chart and drill settings: **no migration is needed**. Version 1 and older version 2 values keep working. Saving needs Editor (and is unavailable in the unsaved SQL/Builder preview). Styling is presentation-only: values never become SQL, Excel formulas or Excel conditional-format expressions. Streaming XLSX, scheduled exports and pivot XLSX receive fixed fills/fonts. Server-computed styles cover the first result page and later pages fetched through a cursor. Rules are evaluated against result values only, so browser filtering and sorting do not change which values match.

**This feature has not been tested on a real IBM i.** Tests use fake query results, an in-process API and generated/read-back Excel files.

## Report sharing and roles

Owners can share a saved report with individual users or app groups as **Viewer** (run, export, drill, per-user folder/favorite) or **Editor** (also update SQL/report definitions, charts and schedules), and revoke any grant from the Share dialog. Lower roles cannot edit/delete or manage shares. Hierarchy: owner > Editor > Viewer; the strongest matching direct/group grant applies. Audit grant, role-change and revoke events are shown to owners and administrators. An incoming external group can map into an application group through `GROUP_MAP`.

Administrators inherit read/Editor-equivalent access to every report without an explicit user or group share, including dashboard lists, drill targets, run/export, schedules and their own personal folders/favorites. They see an **Admin** access badge. ADMIN is an application role from the authenticated server-side session, not accepted from the browser.

**Migration 007 adds three supporting indexes** to the existing `QF_REPORT_SHARES` (002) and `QF_SCHEDULES` (002): `(PRINCIPAL_ID, PRINCIPAL_TYPE, SHARE_ROLE, REPORT_ID)`, `(REPORT_ID, PRINCIPAL_TYPE, PRINCIPAL_ID, SHARE_ROLE)` and `(CREATED_BY, REPORT_ID)`. It also refreshes the `QF_REPORT_SHARES` table label. No sharing table is recreated and no business-data schema is touched. Every saved-report endpoint authorizes through `AccessService`; dashboard and schedule listings use equivalent owner/share filtering. `QF_REPORTS.OWNER_ID`, `QF_REPORT_SHARES` and `QF_USER_GROUPS` are the owner, direct/group grants and membership records; there is no separate grant store for the dashboard. Folders have their own shares (migration 009, see [Shared folders](#shared-folders)), which never grant access to a report. Sharing and deletion remain owner-only; administrators may inspect current grants and audit history but cannot alter grants or delete a report they do not own. Shares have no expiry. Existing schedules stop when their creator loses Editor access. Server tests cover unrelated users, Viewer/Editor direct+group roles, denial and immediate revocation plus admin behavior.

**This feature has not been tested on a real IBM i.** API access tests and schedules run against the fake metadata/query adapters; migration 007 is additive but has never been applied to Db2 for i. The sharing UI screenshots are demos of that same local API, not live system validation.

## Known limitations

- Drill-down: not available in the unsaved Report Builder preview or while a report has
  unsaved edits; grouped builder reports whose top-level filters use OR cannot be
  drilled automatically; an empty (NULL) value mapped to a target parameter falls back
  to that parameter's default; ad-hoc drill runs are not linked to the report in history.

- Folders and favorites: there is no bulk move (one report at a time) and no dragging a tile into a
  folder, and no nested folders. Migration 006 has not been applied to a real Db2 for i.
- Shared folders: sharing a folder does not offer to share its reports too, so people may see an emptier
  folder than the owner (by design: report access stays per report). There is no folder access/audit panel
  in the UI yet (the API has one), no notification when a folder is shared with you, and no share expiry.
  Folder names are unique per owner only, so two shared folders can have the same name (the owner's name
  tells them apart). Migration 009 has not been applied to a real Db2 for i.
- Tile order: tiles can only be dragged within their own section, not into another section or
  folder. Drag and drop uses the browser's native HTML drag events, which most touch browsers do not
  fire, so touch-only devices cannot rearrange tiles yet (the handle's arrow-key controls need a keyboard). Rearranging is off while searching.
  Migration 008 has not been applied to a real Db2 for i.
- Conditional formatting has not been tested on a real IBM i.
- Not yet validated against a live IBM i / Mapepire server (this includes the Report Builder catalog queries and
  `QSYS2.SQL_CHECK_AUTHORITY`, which have only been exercised against scripted catalog rows).
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
- Schedules are stored as 5-field cron (friendly cadences included); one scheduler runner at a time (DB
  lease). Missed runs while stopped or paused are not back-filled; the next future time is used.
- Attachments are capped by `MAX_EXPORT_ROWS`; very large exports may exceed mail-server size limits.
- Sharing/global-admin visibility has no expiry. The audit records changes made through Uncle Bob only (not direct SQL edits), and
  is not written for shares removed by report deletion.
- Shared and administrator visibility has no automatic expiry; individual grants can be revoked. Folders and favorites cannot be shared with another user.
