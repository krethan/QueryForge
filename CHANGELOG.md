# Changelog

All notable changes to Uncle Bob (repository `krethan/QueryForge`) are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no tagged releases yet
(`package.json` says `0.1.0`), so everything is listed under **Unreleased**.

> **Unreleased and not verified on IBM i.** Nothing below has run against a real IBM i or a real Mapepire
> server. Every feature has only been tested with the in-memory fakes and in demo mode, and **migrations
> 001–015 have never been applied to Db2 for i**. Run the [verification kit](docs/ibmi-verification.md)
> on a non-production partition first. To upgrade an install, follow the [upgrade runbook](docs/upgrade.md).

## [Unreleased]

### Database migrations

`npm run migrate` applies these in order and records each one in `<META_SCHEMA>.QF_SCHEMA_VERSION`
(details in [docs/upgrade.md](docs/upgrade.md#5-migration-reference)). Each statement commits on its
own, so a migration that fails part-way leaves the objects it already created and is not recorded.
There are no "down" scripts: you roll back by restoring the save taken before the upgrade.

| #   | File                                   | What it does                                                                                                              | Additive? | Locking and risk                                                                                                                                                                      |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001 | `001_initial_schema.sql`               | `QF_USERS`, `QF_REPORTS`, `QF_EXECUTIONS` and their indexes                                                               | New       | New install only                                                                                                                                                                      |
| 002 | `002_parameters_sharing_schedules.sql` | Report parameters, external identities, `QF_USER_GROUPS`, `QF_REPORT_SHARES`, `QF_SCHEDULES`, `QF_LOCKS`                  | Mostly    | `ALTER TABLE … ADD COLUMN` on `QF_REPORTS`, `QF_EXECUTIONS` and `QF_USERS` rebuilds them under an exclusive lock; replaces the `QF_EXEC_CK_KIND` check (re-validated over every row)  |
| 003 | `003_share_audit.sql`                  | `QF_SHARE_AUDIT` (report sharing audit trail)                                                                             | Yes       | New table only                                                                                                                                                                        |
| 004 | `004_report_builder_def.sql`           | `QF_REPORTS.BUILDER_DEF` (saved Report Builder definitions)                                                               | Yes       | `ADD COLUMN` rebuilds `QF_REPORTS` under an exclusive lock                                                                                                                            |
| 005 | `005_report_chart_def.sql`             | `QF_REPORTS.CHART_DEF` (saved chart settings)                                                                             | Yes       | `ADD COLUMN` rebuilds `QF_REPORTS` under an exclusive lock                                                                                                                            |
| 006 | `006_folders_favorites.sql`            | `QF_FOLDERS`, `QF_REPORT_PREFS` (per-user folders and favorites)                                                          | Yes       | New tables only                                                                                                                                                                       |
| 007 | `007_sharing_access_indexes.sql`       | Three indexes for sharing access checks and schedule lists                                                                | Yes       | Builds indexes over `QF_REPORT_SHARES` and `QF_SCHEDULES`; quick on small tables                                                                                                      |
| 008 | `008_dashboard_tile_order.sql`         | `QF_TILE_ORDER` (per-user dashboard order)                                                                                | Yes       | New table only                                                                                                                                                                        |
| 009 | `009_shared_folders.sql`               | `QF_FOLDER_SHARES`, `QF_FOLDER_REPORTS`, `QF_FOLDER_SHARE_AUDIT`                                                          | Yes       | New tables only. The `QF_FOLDER_SHARES` label was shortened to fit Db2 for i's 50-byte limit before the file was ever applied                                                         |
| 010 | `010_schedule_deliveries.sql`          | `QF_SCHEDULE_DELIVERIES` (delivery history)                                                                               | Yes       | New table only                                                                                                                                                                        |
| 011 | `011_folder_report_sharing.sql`        | `QF_FOLDER_REPORT_SHARING` ("also share the reports in this folder")                                                      | Yes       | New table only                                                                                                                                                                        |
| 012 | `012_folder_audit_report_sharing.sql`  | Widens the `QF_FSAU_CK_TYPE` check on `QF_FOLDER_SHARE_AUDIT` to allow `REPORTS`                                          | No        | Drops and re-adds a check constraint; Db2 for i re-checks every existing row while holding a lock                                                                                     |
| 013 | `013_folder_deletion_audit.sql`        | `QF_FOLDER_DELETIONS` (folder deletion audit)                                                                             | Yes       | New table only                                                                                                                                                                        |
| 014 | `014_share_expiry.sql`                 | `EXPIRES_AT` on both share tables, `OLD_/NEW_EXPIRES_AT` on both share audit tables, `EXPIRY` audit action, column labels | No        | **Six `ADD COLUMN`s rebuild four tables under exclusive locks, and two check constraints are replaced (each re-validated over every row). Stop the app and run it in a quiet window** |
| 015 | `015_share_notifications.sql`          | `QF_SHARE_REMINDERS`, `QF_USER_SETTINGS`                                                                                  | Yes       | New tables only                                                                                                                                                                       |

History retention (#34) needs no migration. It does, however, **delete rows by default** once the
scheduler runs. See the Changed section below.

### Added

- **Reporting core** (#1, #2): read-only SQL against Db2 for i over Mapepire (`@ibm/mapepire-js` 1.0.2),
  an IBM Carbon results table, a dashboard of saved reports, Excel export and execution history. Also
  report parameters, OIDC and LDAP/Active Directory sign-in with group mapping, report sharing with
  Viewer and Editor roles, scheduled XLSX e-mail, exact DECIMAL and BIGINT values, server-side paging
  and a sharing audit trail.
- **Demo mode** (`npm run demo`, development only, in-memory fakes) and Playwright screenshot scripts.
- **Report Builder** (#11, #13, #14, #17, #19, #20): pick a table from the `QSYS2` catalog, and the
  server builds the SQL. Joins with foreign-key suggestions, filters (including ask-when-run), grouping,
  totals and HAVING, calculated fields, pivot/crosstab reports, rolling date range presets, and saving
  and reopening definitions (migration 004).
- **Charts** (#15): Table/Chart/Both views, dashboard tiles, a chart sheet in Excel exports and charts in
  scheduled e-mails (migration 005).
- **Drill-down** (#16) from charts and grouped rows into detail queries or target reports.
- **Folders and favorites** (#18, migration 006) and **per-user dashboard tile order** (#23, migration 008).
- **Conditional formatting** per report (#21).
- **Shared folders** (#24, migration 009): share a folder with users or groups as Viewer or Editor.
  Sharing a folder never shares its reports by itself.
- **Scheduled report delivery** (#25, migration 010): daily, weekday, weekly and monthly cadences in a
  chosen time zone. Recipients must already be able to open the report. Pause and resume, Run now and
  delivery history. Returns `503 MAIL_NOT_CONFIGURED` when SMTP is not set up.
- **Sharing a folder's reports** (#26, migration 011): opt-in, capped at each person's folder role. It
  covers only reports the folder owner owns and placed there, and access is worked out on every request.
- **Folder Access and audit panel** (#27, migration 012), which also records changes to the
  "share the reports" option.
- **IBM i verification kit** (#28): `npm run verify:ibmi` and [docs/ibmi-verification.md](docs/ibmi-verification.md).
  It refuses to run without `QF_VERIFY_TARGET=nonprod` and `--confirm-nonprod`, it is read-only by
  default, and it applies migrations only into a disposable library it creates.
- **Folder deletion audit and CSV export** (#30, migration 013): each folder deletion is recorded in the
  same transaction as the delete. A folder's sharing history can be exported as CSV, with a guard
  against spreadsheet formula injection.
- **Admin Deleted folders screen** (#31).
- **Share end dates** (#32, migration 014): optional end dates on report and folder shares. They are
  checked on every request (runs, exports, folder access, schedule recipients), shown as Expired in the
  Share dialogs, and changes to them are audited as `EXPIRY`.
- **Share notifications** (#33, migration 015): an e-mail when someone gains a share or their role
  changes, end-date reminders to the owner (optionally to recipients too), and a per-user opt-out on the
  Account page. Settings: `QF_PUBLIC_BASE_URL`, `QF_SHARE_REMINDER_DAYS`, `QF_SHARE_REMINDER_TO_RECIPIENT`.
- **History retention** (#34): bounded, batched deletes of old delivery history and reminder rows, plus
  run history and audit records when you opt in. An admin **Data retention** screen and
  `GET/POST /api/admin/retention`. Settings: `QF_RETAIN_*`.
- **Upgrade runbook** ([docs/upgrade.md](docs/upgrade.md)) and this changelog.

### Changed

- The product is now called **Uncle Bob** (#12). Internal names are unchanged: the repository, the
  `QFMETA` schema, `QF_*` tables and settings, the cookie name and `qf-*` CSS classes, so existing
  installs keep working.
- Report sharing and roles are enforced on the server across every feature (#22). Migration 007 adds
  indexes for these access checks.
- **History retention is on by default for two tables** (#34). Once an upgraded instance runs with
  `SCHEDULER_ENABLED=true`, the scheduler leader prunes `QF_SCHEDULE_DELIVERIES` rows older than **365
  days** (`QF_RETAIN_DELIVERY_DAYS`). It also prunes `QF_SHARE_REMINDERS` rows whose share end date is
  more than **180 days** past (`QF_RETAIN_REMINDER_DAYS`). The first run is on the first leader poll after
  start-up, then at most once a day. Set either variable to `0` to keep those rows forever. Run history
  and audit tables are kept unless you set `QF_RETAIN_EXECUTION_DAYS` or `QF_RETAIN_AUDIT_DAYS`. A value
  below a setting's minimum stops the server at start-up.
- The Report Builder's column and foreign-key lists now report when they are cut short (this branch).
  `GET /api/schema/tables/:schema/:table/columns` returns `truncated` and `maxColumns`, and
  `POST /api/schema/join-suggestions` returns `foreignKeysTruncated` and `maxForeignKeyRows`. The builder
  shows a notice under a table with more than 1,000 columns, and beside join suggestions when more than
  1,000 foreign-key column rows exist.

### Fixed

- Metadata reads no longer stop at Mapepire's default of 100 rows (#29). Before this, report lists,
  shares, folder items, audit pages and schedules could have been cut short. They now page until the
  end and fail with a clear error past 100,000 rows. A page that is exactly full no longer shows
  "more rows".
- The catalog table list reads one row past its 500-table cap, so `truncated` is reported correctly (#29).
- Catalog column and foreign-key lists were capped at 1,000 rows with no way to tell that rows were
  missing (this branch). They now read one row past the cap, as the table list does. A foreign-key
  constraint cut off by the cap is dropped rather than suggested as half a key, and the foreign-key query
  orders by constraint schema as well as name so that each constraint's rows stay together.
- Migration 009's `QF_FOLDER_SHARES` table label was 52 bytes, which Db2 for i (50-byte limit) would
  have rejected. It was shortened before the file was ever applied (#28).

### Security

- Connection settings, SMTP settings and secrets are never sent to the browser. The browser never sends
  SQL to the Report Builder, and catalog lookups bind every client-supplied value as a parameter.
- E-mail links use `QF_PUBLIC_BASE_URL` (or `APP_ORIGIN`) and never the request's `Host` header.
  Notification e-mails are HTML-escaped and stripped of control characters, and contain no report data.
- `npm run migrate` revokes `*PUBLIC` access to every metadata table. When migrations run under a
  separate `MIGRATE_DB_USER`, it grants the app profile only `SELECT, INSERT, UPDATE, DELETE`
  (`SELECT` on `QF_SCHEMA_VERSION`).

### Known gaps

- Not verified on IBM i: Mapepire paging, the catalog queries (`QSYS2.SQL_CHECK_AUTHORITY`, `SYSREFCST`),
  timestamp binding in the audit export, the retention `DELETE … FETCH FIRST` subselect, and all 15
  migrations. OIDC, LDAP and SMTP have only been tested with in-process fakes.
- See [Known limitations](README.md#known-limitations) in the README.
