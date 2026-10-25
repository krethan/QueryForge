# PLAN — IBM i Query Reports

## Goal

A web app where authenticated users write read-only SQL against Db2 for i, view results in an
interactive Carbon table, save reports, see them as dashboard tiles, re-run them, export XLSX,
and review execution history. Mapepire (`@ibm/mapepire-js` 1.0.2) is the only database access path;
application metadata also lives in Db2 for i.

## Architecture

- `web/` — React 19 + TypeScript + Vite + `@carbon/react` (g10 theme, IBM Plex bundled locally),
  CodeMirror 6 SQL editor. Talks only to `/api` with a same-site session cookie + CSRF header.
- `server/` — Node + TypeScript + Express. Never trusts the browser:
  - Auth: bcrypt users in `QF_USERS`, JWT (HS256) session cookie (HttpOnly, SameSite=Strict),
    double-submit CSRF token, Origin check, login throttling and lockout.
  - SQL: lexer-based validator (single statement; SELECT/WITH/VALUES only; rejects DML/DDL/CALL,
    `FOR UPDATE`, protected schemas); then executed on a fresh read-only Mapepire job
    (JDBC `access=read only`, separate least-privilege profile).
  - Limits: row cap with truncation flag, timeout (job closed), concurrency semaphore, rate limits.
  - Export: server-side streaming XLSX (exceljs), typed cells, formula-injection escaping.
  - Metadata repositories: parameterised SQL only, optimistic locking via `VERSION`.
- Migrations: `server/migrations/*.sql`, applied by `npm run migrate` or printed for a DBA.

## Milestones

1. Server core, validator, executor, metadata repos, API, tests with fakes — done.
2. Carbon UI: login, dashboard, editor/results, saved reports + history, data source, account — done.
3. Docs, IBM i setup guide, lint/typecheck/test/build — done.
4. Next: integration test run against a **non-production** IBM i with Mapepire (not yet done).
