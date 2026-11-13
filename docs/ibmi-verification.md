# IBM i verification plan (non-production)

> **Status:** nothing in Uncle Bob has been run on a real IBM i yet, and migrations 001–013 have never
> been applied to Db2 for i. This plan and the `verify:ibmi` kit are for you to run on a **test or
> development partition**. Never point them at production.

The plan has three parts:

1. [Prepare](#1-prerequisites) a non-production IBM i, two test profiles and a disposable library.
2. Run the [verification kit](#3-run-the-verification-kit) (`npm run verify:ibmi`): read-only checks
   first, then migrations applied into the disposable library, checked against the catalog, and dropped.
3. Work through the [manual UI checklist](#6-manual-ui-checklist) with the app pointed at that library,
   and record everything in the [results table](#7-results-template).

## 1. Prerequisites

| Item                          | Requirement                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IBM i release                 | **7.2 or later.** The app pages with `OFFSET … FETCH FIRST` (folder audit), which needs 7.2. The kit fails on 7.1 or earlier.                                                                                                                                                                                                            |
| Db2 for i PTF group           | Current database group PTF (SF99702 / SF99703 / SF99704 / SF99705 / SF99706 for 7.2–7.6). The kit prints the installed level.                                                                                                                                                                                                            |
| Mapepire server               | Installed and running on the test partition (`yum install mapepire-server`, `sc start mapepire`; port 8076 by default). Use a CA-signed certificate, or give the kit the CA with `QF_VERIFY_CA_FILE`.                                                                                                                                    |
| Reporting profile (read-only) | e.g. `QFREPORT`: `USRCLS(*USER) SPCAUT(*NONE) LMTCPB(*YES)`; `*USE` to the data libraries and `SELECT` on the files reports read; **no** `*ADD`/`*UPD`/`*DLT`, no ownership, no `*ALLOBJ`/`*SECADM`; no authority to the metadata library. See [`IBMI_SETUP.md`](IBMI_SETUP.md#2-user-profiles-examples--adapt-to-your-security-policy). |
| Metadata profile (test)       | e.g. `QFAPPTEST`: may run `CREATE SCHEMA` (needs authority to create a library; otherwise have a DBA run `CREATE SCHEMA UBVERIFY`, give this profile `*ALL` to it, and pass `--adopt-empty-library`). It owns the disposable library. Do not reuse the production `QFAPP`.                                                               |
| Disposable metadata library   | A **new** library name of up to 10 characters that does not start with `Q` or `SYS`, e.g. `UBVERIFY`. It must be created with SQL `CREATE SCHEMA` (not `CRTLIB`) so it gets the `QSQJRN` journal the app's commit-controlled transactions need.                                                                                          |
| Test data library             | A non-production copy of a data library (e.g. `SAMPLELIB`) that reports can read. The kit only reads its catalog and authority entries; it never reads or writes its rows.                                                                                                                                                               |
| Test SMTP sink                | For schedules: a local catcher such as MailHog / Mailpit / smtp4dev reachable from the Uncle Bob server, with `SCHEDULE_RECIPIENT_DOMAINS` set to a test domain. Never a real mail relay.                                                                                                                                                |
| Workstation                   | This repository with `npm ci` done, Node 22 or 24, and network access to the Mapepire port.                                                                                                                                                                                                                                              |

Save the test partition's metadata library (if one exists) before you begin, even though the kit never
touches any library except the disposable one.

## 2. Configure the kit

```bash
cp server/verify-ibmi.env.example verify-ibmi.env   # git-ignored; fill in the placeholders
```

| Setting                                              | Meaning                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `QF_VERIFY_TARGET=nonprod`                           | **Required.** Together with `--confirm-nonprod` on the command line. Without both, the kit refuses and connects to nothing.              |
| `QF_VERIFY_HOST`, `QF_VERIFY_PORT`                   | Mapepire server on the test partition.                                                                                                   |
| `QF_VERIFY_CA_FILE`, `QF_VERIFY_REJECT_UNAUTHORIZED` | TLS. Keep certificate checking on.                                                                                                       |
| `QF_VERIFY_PRODUCTION_HOSTS`                         | Comma-separated production host names; the kit refuses to connect to any of them.                                                        |
| `QF_VERIFY_REPORT_USER`, `QF_VERIFY_REPORT_PASSWORD` | The reporting profile (the app's `REPORT_DB_USER`).                                                                                      |
| `QF_VERIFY_DATA_LIBRARIES`                           | Data libraries the reporting profile must only be able to read.                                                                          |
| `QF_VERIFY_SCHEMA`                                   | The disposable metadata library, e.g. `UBVERIFY`. `QFMETA` is refused unless you pass `--allow-qfmeta`; never use it on a shared system. |
| `QF_VERIFY_META_USER`, `QF_VERIFY_META_PASSWORD`     | The test metadata profile. Optional for read-only runs; required for `--apply-migrations` and `--cleanup`.                               |

The kit reads only `QF_VERIFY_*` settings (from `--config` and the environment; the environment wins). It
never reads `server/.env`. You can keep passwords out of the file and `export` them in the shell instead.
Passwords are never printed or written to the JSON report.

## 3. Run the verification kit

All commands run from the repository root. Each run prints a pass/fail report and writes JSON
(`ibmi-verification-report.json` by default, or `--json <file>`). Exit code: `0` all checks passed
(warnings allowed), `1` at least one check failed, `2` refused to run.

**Step 1: dry run.** Checks the settings and prints the plan; connects to nothing.

```bash
npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod --dry-run
```

**Step 2: read-only checks (the default).** Every statement is a `SELECT` or `VALUES`; the kit's own
statement policy throws before anything else can be sent.

```bash
npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod --json results-readonly.json
```

This checks, as the reporting profile:

- connectivity through Mapepire, `CURRENT SERVER` and `CURRENT USER`;
- IBM i release from `SYSIBMADM.ENV_SYS_INFO` (7.2+), the Db2 PTF group from `QSYS2.GROUP_PTF_INFO`,
  and that `OFFSET … FETCH FIRST` works;
- read-only: no `*ALLOBJ` / `*SECADM` (`QSYS2.USER_INFO`); for each data library, no add/delete
  authority to the library and no add/update/delete/existence/alter authority or ownership of its files,
  for the profile, its group profiles and `*PUBLIC` (`QSYS2.OBJECT_PRIVILEGES`);
- the app's own reporting path: the report executor (job opened with `access=read only`) keeps
  `DECIMAL(19,2)` and `BIGINT` values exact, the SQL validator refuses a `DELETE` locally, and the Report
  Builder table list (`QSYS2.SYSTABLES` + `QSYS2.SQL_CHECK_AUTHORITY`) runs.

If `QF_VERIFY_SCHEMA` and the metadata profile are set and the library already exists (for example from
an earlier `--apply-migrations` run without `--cleanup`), it also runs the catalog checks in step 3 and the
app's metadata read queries, read-only.

**Step 3: apply migrations 001–013 into the disposable library, verify, and drop it.**

```bash
npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod \
  --apply-migrations --cleanup UBVERIFY --json results-migrations.json
```

As the metadata profile, and only inside `UBVERIFY`:

1. `CREATE SCHEMA UBVERIFY` (refused if the library already exists and the kit did not create it; an
   empty, DBA-created library can be used with `--adopt-empty-library`).
2. A marker table `UBVERIFY.QF_VERIFY_KIT` records that the kit owns the library.
3. `QF_SCHEMA_VERSION` is created and each migration file is applied in order, exactly as
   `npm run migrate` would, then `REVOKE ALL … FROM PUBLIC` on the metadata tables. A failing statement
   stops the run and is reported with its file, statement number, SQLSTATE and SQLCODE.
4. Catalog checks (below), the reporting profile's lack of access to `UBVERIFY.QF_USERS`, and the app's
   metadata read queries (reports, shares, folders, folder audit with `OFFSET` paging, folder deletions
   and the audit export's keyset query, tile order, schedules, deliveries, history).
5. A write smoke test through the app's own repository code (skip it with `--no-smoke`): two test
   users, a report, a folder, filing the report, sharing the folder with "also share the reports"
   (writes the migration 012 `REPORTS` audit row in a commit-controlled transaction), reading it back,
   the viewer seeing the folder, the check constraint rejecting an unknown principal type, deleting the
   folder (cascades), reading back its migration 013 `QF_FOLDER_DELETIONS` row, exporting the deleted
   folder's sharing history one row per batch (which binds the keyset cursor's `OCCURRED_AT` back as a
   `TIMESTAMP` parameter), and deleting the report. It also checks that the app's metadata reads return more than 100
   rows (see [Known risks](#8-known-risks-to-watch-for)).
6. `--cleanup UBVERIFY` drops the library with `DROP SCHEMA UBVERIFY CASCADE`, but only if the
   `QF_VERIFY_KIT` marker is there and it holds nothing except `QF_*` tables, the SQL catalog views
   `CREATE SCHEMA` adds, and its journal (any program, data area or other object makes it refuse).

Leave out `--cleanup` to keep the library for the manual UI checklist, then run the cleanup on its own
afterwards:

```bash
npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod --cleanup UBVERIFY
```

### What the kit enforces

- No connection at all unless `QF_VERIFY_TARGET=nonprod` **and** `--confirm-nonprod`, and the host is not
  in `QF_VERIFY_PRODUCTION_HOSTS`, and `NODE_ENV` is not `production`.
- Read-only by default: every statement passes through a guard that only lets `SELECT` / `VALUES` /
  `WITH` reads through.
- With `--apply-migrations` or `--cleanup`, a non-read statement is sent only if every object it names
  (created, altered, labelled, inserted into, updated, deleted from, referenced, granted on) is qualified
  with the disposable library. `CREATE`/`DROP SCHEMA` is only allowed for that library, and individual
  `DROP TABLE` / `DROP INDEX` are refused. The JSON report lists every write.
- The disposable library may not be an IBM-supplied library (`Q*`, `SYS*`), one of the data libraries,
  or `QFMETA` (unless `--allow-qfmeta`).
- Application data libraries are never written to; their rows are never read.

## 4. Expected objects per migration

The kit derives this list from `server/migrations` and compares it with `QSYS2.SYSTABLES`
(`TABLE_TYPE = 'T'` and `TABLE_TEXT` = the `LABEL ON` text), `QSYS2.SYSCOLUMNS`, `QSYS2.SYSCST`
(type, table, `ESTABLISHED`, enabled, not check-pending), `QSYS2.SYSREFCST` (`DELETE_RULE`),
`QSYS2.SYSCHKCST` (every literal of the `CHECK` appears in `CHECK_CLAUSE`) and `QSYS2.SYSINDEXES`
(`IS_UNIQUE`: `D` duplicates allowed, `U` unique, `V` unique where not null). It also checks
`QF_SCHEMA_VERSION` holds versions 1–13 and that the library has a journal
(`QSYS2.OBJECT_STATISTICS(lib, '*JRN')`). Problems are reported against the migration that creates the
object.

| #   | File                                   | Objects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 001 | `001_initial_schema.sql`               | tables `QF_USERS`, `QF_REPORTS`, `QF_EXECUTIONS`; primary keys `QF_USERS_PK`, `QF_REPORTS_PK`, `QF_EXEC_PK`; unique `QF_USERS_UK_NAME`, `QF_REPORTS_UK_NAME`; foreign keys `QF_REPORTS_FK_OWNER` (RESTRICT), `QF_EXEC_FK_REPORT` (SET NULL), `QF_EXEC_FK_USER` (RESTRICT); checks `QF_USERS_CK_ROLE`, `QF_USERS_CK_ACTIVE`, `QF_USERS_CK_NAME`, `QF_REPORTS_CK_NAME`, `QF_REPORTS_CK_STATUS`, `QF_EXEC_CK_STATUS`, `QF_EXEC_CK_TRUNC`; indexes `QF_REPORTS_IX_OWNER_EXEC`, `QF_REPORTS_IX_OWNER_CAT`, `QF_REPORTS_IX_OWNER_CRT`, `QF_EXEC_IX_USER`, `QF_EXEC_IX_REPORT`                                                                                                                                                                                                  |
| 002 | `002_parameters_sharing_schedules.sql` | tables `QF_USER_GROUPS`, `QF_REPORT_SHARES`, `QF_SCHEDULES`, `QF_LOCKS`; columns `QF_REPORTS.PARAMETERS_JSON`, `QF_EXECUTIONS.PARAMS_JSON`, `QF_EXECUTIONS.SCHEDULE_ID`, `QF_USERS.AUTH_SOURCE`, `QF_USERS.EXTERNAL_ID`, `QF_USERS.EMAIL`; drops and re-adds `QF_EXEC_CK_KIND`; primary keys `QF_UGRP_PK`, `QF_SHARE_PK`, `QF_SCHED_PK`, `QF_LOCKS_PK`; foreign keys `QF_UGRP_FK_USER` (CASCADE), `QF_SHARE_FK_REPORT` (CASCADE), `QF_SCHED_FK_REPORT` (CASCADE); checks `QF_EXEC_CK_KIND`, `QF_USERS_CK_SOURCE`, `QF_UGRP_CK_SOURCE`, `QF_SHARE_CK_TYPE`, `QF_SHARE_CK_ROLE`, `QF_SCHED_CK_ENABLED`, `QF_SCHED_CK_STATUS`; indexes `QF_USERS_UX_EXTERNAL` (unique where not null), `QF_UGRP_IX_GROUP`, `QF_SHARE_IX_PRINCIPAL`, `QF_SCHED_IX_DUE`, `QF_SCHED_IX_REPORT` |
| 003 | `003_share_audit.sql`                  | tables `QF_SHARE_AUDIT`; primary keys `QF_SAUD_PK`; checks `QF_SAUD_CK_ACTION`, `QF_SAUD_CK_TYPE`, `QF_SAUD_CK_OLD`, `QF_SAUD_CK_NEW`; indexes `QF_SAUD_IX_REPORT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 004 | `004_report_builder_def.sql`           | columns `QF_REPORTS.BUILDER_DEF`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 005 | `005_report_chart_def.sql`             | columns `QF_REPORTS.CHART_DEF`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 006 | `006_folders_favorites.sql`            | tables `QF_FOLDERS`, `QF_REPORT_PREFS`; primary keys `QF_FLDR_PK`, `QF_RPRF_PK`; unique `QF_FLDR_UQ_NAME`; foreign keys `QF_FLDR_FK_OWNER` (CASCADE), `QF_RPRF_FK_USER` (CASCADE), `QF_RPRF_FK_REPORT` (CASCADE), `QF_RPRF_FK_FOLDER` (SET NULL); checks `QF_RPRF_CK_FAV`; indexes `QF_RPRF_IX_FOLDER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 007 | `007_sharing_access_indexes.sql`       | indexes `QF_SHARE_IX_COVERS`, `QF_SHARE_IX_REPORT_ROLE`, `QF_SCHED_IX_CREATOR`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 008 | `008_dashboard_tile_order.sql`         | tables `QF_TILE_ORDER`; primary keys `QF_TORD_PK`; foreign keys `QF_TORD_FK_USER` (CASCADE), `QF_TORD_FK_REPORT` (CASCADE); checks `QF_TORD_CK_POS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 009 | `009_shared_folders.sql`               | tables `QF_FOLDER_SHARES`, `QF_FOLDER_REPORTS`, `QF_FOLDER_SHARE_AUDIT`; primary keys `QF_FSHR_PK`, `QF_FRPT_PK`, `QF_FSAU_PK`; foreign keys `QF_FSHR_FK_FOLDER` (CASCADE), `QF_FRPT_FK_FOLDER` (CASCADE), `QF_FRPT_FK_REPORT` (CASCADE); checks `QF_FSHR_CK_TYPE`, `QF_FSHR_CK_ROLE`, `QF_FRPT_CK_POS`, `QF_FSAU_CK_ACTION`, `QF_FSAU_CK_OLD`, `QF_FSAU_CK_NEW`; indexes `QF_FSHR_IX_COVERS`, `QF_FRPT_IX_REPORT`, `QF_FSAU_IX_FOLDER`                                                                                                                                                                                                                                                                                                                                  |
| 010 | `010_schedule_deliveries.sql`          | tables `QF_SCHEDULE_DELIVERIES`; primary keys `QF_SDLV_PK`; foreign keys `QF_SDLV_FK_SCHED` (CASCADE); checks `QF_SDLV_CK_TRIGGER`, `QF_SDLV_CK_STATUS`; indexes `QF_SDLV_IX_SCHED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 011 | `011_folder_report_sharing.sql`        | tables `QF_FOLDER_REPORT_SHARING`; primary keys `QF_FRSH_PK`; foreign keys `QF_FRSH_FK_FOLDER` (CASCADE); checks `QF_FRSH_CK_ROLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 012 | `012_folder_audit_report_sharing.sql`  | drops and re-adds `QF_FSAU_CK_TYPE`; checks `QF_FSAU_CK_TYPE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 013 | `013_folder_deletion_audit.sql`        | tables `QF_FOLDER_DELETIONS`; primary keys `QF_FDEL_PK`; checks `QF_FDEL_CK_COUNTS`, `QF_FDEL_CK_ROLE`; indexes `QF_FDEL_IX_TIME`, `QF_FDEL_IX_FOLDER`; no foreign keys (by design)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Not created by a migration file: `QF_SCHEMA_VERSION` (by the migration runner) and, in the disposable
library only, `QF_VERIFY_KIT` (by the kit). `CREATE SCHEMA` also adds Db2's own catalog views
(`SYSTABLES`, `SYSCOLUMNS`, …) and the `QSQJRN` journal and receiver to the library.

To list what is actually there by hand:

```sql
SELECT TABLE_NAME, TABLE_TYPE, TABLE_TEXT FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = 'UBVERIFY' ORDER BY 1;
SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE, TABLE_NAME, CONSTRAINT_STATE, ENABLED, CHECK_PENDING
  FROM QSYS2.SYSCST WHERE CONSTRAINT_SCHEMA = 'UBVERIFY' ORDER BY 3, 1;
SELECT C.CONSTRAINT_NAME, C.CHECK_CLAUSE FROM QSYS2.SYSCHKCST C WHERE C.CONSTRAINT_SCHEMA = 'UBVERIFY';
SELECT R.CONSTRAINT_NAME, R.DELETE_RULE FROM QSYS2.SYSREFCST R WHERE R.CONSTRAINT_SCHEMA = 'UBVERIFY';
SELECT INDEX_NAME, TABLE_NAME, IS_UNIQUE FROM QSYS2.SYSINDEXES WHERE INDEX_SCHEMA = 'UBVERIFY' ORDER BY 2, 1;
SELECT VERSION, FILE_NAME, APPLIED_AT FROM UBVERIFY.QF_SCHEMA_VERSION ORDER BY 1;
```

## 5. Rollback and cleanup

- **Disposable library:** `npm run verify:ibmi -- --config verify-ibmi.env --confirm-nonprod --cleanup UBVERIFY`,
  or as the metadata profile in ACS Run SQL Scripts: `DROP SCHEMA UBVERIFY CASCADE` (check the name
  first; this drops everything in it, including its journal). Confirm with
  `SELECT COUNT(*) FROM QSYS2.SYSSCHEMAS WHERE SCHEMA_NAME = 'UBVERIFY'` → 0.
- **A migration failed part-way:** each statement auto-commits, so objects created before the failing
  statement stay and the version row is not written. In the disposable library, drop it and start again
  after fixing the file. Do not hand-patch: the point is to prove the files apply cleanly.
- **Test profiles:** `DLTUSRPRF QFAPPTEST` (and the test reporting profile if it was created only for
  this) once you are done; revoke any test grants you added on the data library.
- **Mapepire:** nothing to undo; the kit only opens client connections.
- Migrations have no "down" scripts. A real metadata library is rolled back by restoring the save taken
  before the migration (`SAVLIB` / `RSTLIB`), never by dropping objects by hand.

## 6. Manual UI checklist

Point a local Uncle Bob server at the test partition: copy `.env.example` to `server/.env` with
`MAPEPIRE_HOST` = the test host, `REPORT_DB_USER` = the test reporting profile, `META_DB_USER` = the test
metadata profile, `META_SCHEMA=UBVERIFY` (kept from step 3 without `--cleanup`, or applied with
`npm run migrate`), `NODE_ENV=development`, SMTP pointing at the test sink, and
`SCHEDULE_RECIPIENT_DOMAINS` = the sink's test domain. Create two app users
(`npm run user:create -- --username tester1 --name "Tester One" --admin` and a non-admin `tester2`), then
`npm run dev`. Use only test data.

| ID    | Feature                | Steps                                                                                                                             | Expected                                                                                                                                                                                             |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI-01 | Sign-in                | Sign in as tester1; sign out; repeated wrong passwords for tester2                                                                | Dashboard loads; tester2 is locked out after repeated failures (`QF_USERS.LOCKED_UNTIL` set)                                                                                                         |
| UI-02 | Ad-hoc SQL             | Run a `SELECT` over a `SAMPLELIB` file with > 1,000 rows; scroll/page                                                             | Rows and column types correct; paging loads more; DECIMAL and BIGINT values exact                                                                                                                    |
| UI-03 | Read-only guard        | Run `DELETE FROM SAMPLELIB.<file>` and `CALL QSYS2.QCMDEXC('DLTF ...')`                                                           | Refused by the validator; nothing changes on IBM i (check row count)                                                                                                                                 |
| UI-04 | Timeout / cancel       | Run a long query and cancel it                                                                                                    | Job ends (WRKACTJOB shows the QZDASOINIT/Mapepire job gone)                                                                                                                                          |
| UI-05 | Save reports           | Save a SQL report with a `?` parameter, and a Report Builder report with joins, filters, grouping, a calculated field and a pivot | Reopens with the same definition; runs on IBM i                                                                                                                                                      |
| UI-06 | Excel export           | Export both reports                                                                                                               | `.xlsx` opens; numbers, dates and formulas-as-text correct; row limit honoured                                                                                                                       |
| UI-07 | Date presets           | Use Last month, This quarter, Last 7 days on a date parameter and a builder date filter                                           | Resolved ranges correct for `DATE_PRESET_TIMEZONE`                                                                                                                                                   |
| UI-08 | Conditional formatting | Add rules (greater than, between, text contains)                                                                                  | Colours in the grid and in the export                                                                                                                                                                |
| UI-09 | Charts and drill-down  | Add a chart; drill from a value into a target report                                                                              | Chart renders; drill passes the value                                                                                                                                                                |
| UI-10 | Sharing and roles      | Share a report with tester2 as Viewer, then Editor; revoke                                                                        | Viewer can run/export only; Editor can edit; revoke removes access; Access and audit panel lists each change                                                                                         |
| UI-11 | Folders and favorites  | Create folders, file reports, star favorites, rename, delete a folder                                                             | Reports kept when the folder is deleted; as tester1 (admin), **Deleted folders** lists the deletion with its counts, its sharing history and CSV export; tester2 has no nav entry and the API is 403 |
| UI-12 | Shared folders         | Share a folder with tester2 as Viewer and as Editor                                                                               | Viewer sees the folder (only reports they can already see); Editor can add, remove, reorder                                                                                                          |
| UI-13 | Folder report sharing  | Turn on "Also share the reports in this folder" (Viewer, then Editor), then off                                                   | tester2 gains and loses access to the owner's reports in that folder, never above the folder role                                                                                                    |
| UI-14 | Folder audit           | Open the folder's Access and audit panel; Show older changes; Export CSV                                                          | Every share and report-sharing change listed, newest first; paging works (uses `OFFSET`); the CSV opens in Excel as UTF-8 with every event (keyset paging), names starting with `=` shown as text    |
| UI-15 | Tile order             | Drag tiles, use the keyboard to move one, reload, Reset order                                                                     | Order persists per user; reset restores the default                                                                                                                                                  |
| UI-16 | Schedules              | Create daily/weekly/monthly schedules to tester1's address; Run now; pause/resume                                                 | Mail with the Excel attachment arrives in the SMTP sink; delivery history rows; paused schedule does not run                                                                                         |
| UI-17 | Scheduler lease        | Run two app instances against `UBVERIFY` with `SCHEDULER_ENABLED=true`                                                            | Each due run is delivered once                                                                                                                                                                       |
| UI-18 | History                | Open execution history                                                                                                            | Runs, exports and scheduled runs recorded with row counts and durations                                                                                                                              |
| UI-19 | Admin                  | As tester1 (admin), list all reports; open a personal folder of tester2                                                           | Admin sees every report; a never-shared personal folder of tester2 stays private (404)                                                                                                               |
| UI-20 | Authority errors       | Run a report on a file the reporting profile cannot read                                                                          | Clean "not authorized" message (SQLSTATE 42501), no stack trace                                                                                                                                      |

## 7. Results template

Copy this table into the PR or an issue and fill it in.

| Item                                              | Result (Pass / Fail / N/A) | Evidence (report file, screenshot, job log) | Notes |
| ------------------------------------------------- | -------------------------- | ------------------------------------------- | ----- |
| IBM i release and TR / Db2 PTF group level        |                            |                                             |       |
| Mapepire server version                           |                            |                                             |       |
| Kit dry run                                       |                            |                                             |       |
| Kit read-only run (exit code)                     |                            | `results-readonly.json`                     |       |
| Reporting profile read-only on every data library |                            |                                             |       |
| Migrations 001–013 applied into `UBVERIFY`        |                            | `results-migrations.json`                   |       |
| Catalog objects 001–013 all PASS                  |                            |                                             |       |
| Metadata queries all PASS                         |                            |                                             |       |
| Smoke test all PASS (incl. > 100-row reads)       |                            |                                             |       |
| Cleanup dropped `UBVERIFY`                        |                            |                                             |       |
| UI-01 … UI-20 (one row each)                      |                            |                                             |       |

Tested by: ______ Date: ______ Partition / host (not production): ______ App commit: ______

## 8. Known risks to watch for

- **Metadata reads past 100 rows.** `@ibm/mapepire-js` 1.0.2's `SQLJob.execute()` fetches only 100
  rows by default. The app's metadata store no longer relies on it: it pages with
  `Query.execute(1000)` / `fetchMore(1000)` until Mapepire reports the end, closes the cursor, and
  fails (rather than returning a partial list) past 100,000 rows. Report runs, exports and the
  catalog always request explicit row counts and report truncation against the app's own limits.
  The smoke test still compares a > 100-row catalog read through the app's metadata store with a
  full read. All of this is tested against fakes that emulate Mapepire's paging; it has not been
  confirmed on a real IBM i.
- **Audit export cursor.** The folder audit CSV export pages with a keyset cursor
  (`OCCURRED_AT < CAST(? AS TIMESTAMP) OR (OCCURRED_AT = … AND AUDIT_ID > ?)`), binding back the
  `OCCURRED_AT` text exactly as Mapepire returned it. If Db2 for i or Mapepire formats timestamps in a
  way the cast does not accept, or drops microseconds, the export would fail or could repeat rows. The
  smoke test exports a 4-row history one row per batch to catch this; it has only run against fakes.
- **Label lengths.** Db2 for i limits `LABEL ON TABLE` text to 50 bytes. Migration 009 originally
  labelled `QF_FOLDER_SHARES` with 52 bytes, which would have failed on Db2 for i. It was shortened
  before any real use, and a unit test now checks every label.
- **Commitment control.** The app's transactions need the metadata library to be journaled. A library
  created with `CRTLIB` instead of `CREATE SCHEMA` fails the kit's journal check.
- **What catalog checks cannot see.** `QSYS2.OBJECT_PRIVILEGES` only shows other profiles' authorities
  (including `*PUBLIC`) to a caller with `*OBJMGT` on the object or the right function usage. If the kit
  warns that no authority rows were visible, confirm with `DSPOBJAUT` / `PRTPVTAUT`. Adopted authority
  from programs and authorization-list details are not evaluated; the app's `access=read only` job
  property is a second line of defence, not a replacement.
