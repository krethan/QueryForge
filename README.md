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

Node.js ≥ 20.19 (22+ recommended; some Carbon packages declare `>=22`), npm 10+, and a
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

## Commands

| Command                                 | Description                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                           | Server (tsx watch) + Vite dev server                                          |
| `npm run build`                         | Compile server, typecheck + build web                                         |
| `npm start`                             | Run built server                                                              |
| `npm run lint` / `npm run format:check` | ESLint / Prettier                                                             |
| `npm run typecheck`                     | `tsc --noEmit` for both workspaces                                            |
| `npm test`                              | Server (vitest + supertest, fake Mapepire) and web (vitest + Testing Library) |
| `npm run test:integration`              | Real Mapepire tests; skipped unless `QF_INTEGRATION=1` — non-production only  |
| `npm run migrate`                       | Apply metadata migrations                                                     |
| `npm run user:create`                   | Create/reset an app user (password via prompt or `QF_NEW_PASSWORD`)           |

## Environment variables (`server/.env`)

| Variable                                                                                      | Default               | Purpose                                    |
| --------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------ |
| `NODE_ENV`                                                                                    | development           |                                            |
| `PORT` / `HOST`                                                                               | 3001 / 127.0.0.1      | Listen address                             |
| `APP_ORIGIN`                                                                                  | http://localhost:5173 | Allowed browser origin (CSRF/Origin check) |
| `TRUST_PROXY`                                                                                 | false                 | Express trust proxy                        |
| `MAPEPIRE_HOST` / `MAPEPIRE_PORT`                                                             | — / 8076              | Mapepire server                            |
| `MAPEPIRE_REJECT_UNAUTHORIZED`                                                                | true                  | TLS verification                           |
| `MAPEPIRE_CA_FILE`                                                                            | —                     | PEM CA/cert for self-signed servers        |
| `IBMI_DISPLAY_NAME`                                                                           | host                  | Name shown in UI                           |
| `REPORT_DB_USER` / `REPORT_DB_PASSWORD`                                                       | —                     | Read-only reporting profile                |
| `REPORT_DEFAULT_SCHEMA` / `REPORT_LIBRARIES` / `REPORT_NAMING`                                | — / — / sql           | Job defaults                               |
| `META_DB_USER` / `META_DB_PASSWORD`                                                           | —                     | Metadata profile                           |
| `META_SCHEMA` / `META_POOL_SIZE`                                                              | QFMETA / 2            | Metadata schema and pool                   |
| `QUERY_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS`                                                     | 60000 / 15000         | Timeouts                                   |
| `MAX_RESULT_ROWS` / `MAX_EXPORT_ROWS`                                                         | 5000 / 100000         | Row caps                                   |
| `FETCH_BATCH_SIZE`                                                                            | 500                   | Rows per Mapepire fetch                    |
| `MAX_CONCURRENT_EXECUTIONS` / `MAX_QUERY_LENGTH`                                              | 4 / 32000             |                                            |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` / `EXECUTE_RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_MAX` | 60000 / 120 / 30 / 10 |                                            |
| `SESSION_SECRET`                                                                              | —                     | ≥ 32 chars, random                         |
| `SESSION_TTL_MINUTES` / `COOKIE_SECURE`                                                       | 480 / true in prod    |                                            |
| `PROTECTED_SCHEMAS`                                                                           | —                     | Extra schemas blocked from user SQL        |
| `XLSX_FORMULA_ESCAPE`                                                                         | prefix                | Escape `= + - @` etc. in exported text     |

## Security model

- Session JWT in HttpOnly SameSite=Strict cookie; double-submit CSRF token + Origin check; login lockout.
- SQL validator: one statement, SELECT/WITH/VALUES only, no `FOR UPDATE`, no protected schemas.
- Execution on a fresh Mapepire job per run as a least-privilege profile with the `access=read only` JDBC option,
  row caps, timeouts (job closed on timeout/cancel), concurrency and rate limits.
- Reports are owner-scoped; all metadata SQL is parameterised; optimistic locking on update.
- XLSX built server-side with formula-injection escaping. Credentials only in env, never sent to the browser.

## Known limitations

- Not yet validated against a live IBM i / Mapepire server.
- Mapepire 1.0.2 has no statement cancel API; cancel/timeout close the job.
- DECIMAL > 15 digits and BIGINT may lose precision as JSON numbers before reaching the server.
- Result display is capped (`MAX_RESULT_ROWS`); no server-side paging of huge result sets.
- No SSO/LDAP; users are local to `QF_USERS`. No report sharing between users.
