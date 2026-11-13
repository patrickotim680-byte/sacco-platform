# Softronics SACCO & Savings Group Platform (Uganda)

Multi-tenant SaaS for SACCOs, VSLAs, investment clubs, cooperatives and community savings groups.
Next.js (App Router) + TypeScript + Tailwind + PostgreSQL (Drizzle ORM). Money is `numeric(18,2)`; all financial writes run in database transactions and post balanced double-entry journals.

## Quick start

```bash
npm install
cp .env.example .env            # set DATABASE_URL
npx drizzle-kit push            # or let the app apply SQL migrations from ./drizzle on first start
npm run dev                     # first start creates the schema (if missing), applies integrity triggers, seeds demo data
```

Demo workspace: **Uganda Community Development SACCO** (fictional). The login page lists one-click demo roles; password for all is `Demo@12345`
(platform owner `admin@softronics.demo`, owner `owner@ucdsacco.demo`, chair, manager, treasurer, secretary, officer, auditor, member `member@ucdsacco.demo`).
Set `SEED_DEMO=false` to skip seeding and `SHOW_DEMO_LOGINS=false` to hide the demo panel in production.
Re-seed from scratch: `npx tsx scripts/seed.ts` (idempotent; skips when the demo org exists).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `APP_URL` | recommended | Public base URL used in password-reset links |
| `SEED_DEMO` | no | `false` disables demo seeding on an empty database |
| `SHOW_DEMO_LOGINS` | no | `false` hides demo credentials on the login page |
| `STORAGE_DIR` | no | Private directory for member documents (default `.storage`). Use a persistent volume or replace with S3/Supabase Storage |
| `CRON_SECRET` | for cron | Bearer token required by `GET /api/cron/daily` (penalties, reminders, delivery) |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | SMS | Africa's Talking (`AT_USERNAME=sandbox` for sandbox) |
| `RESEND_API_KEY`, `EMAIL_FROM` | email | Resend transactional email |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | WhatsApp | Meta WhatsApp Cloud API |
| `MTN_MOMO_SUBSCRIPTION_KEY`, `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`, `MTN_MOMO_ENV` | MTN MoMo | Collections API (`sandbox`/`production`) |
| `AIRTEL_CLIENT_ID`, `AIRTEL_CLIENT_SECRET`, `AIRTEL_ENV` | Airtel | Airtel Money Open API |
| `SHOW_RESET_LINK` | no | `true` shows the password-reset link on screen when no email provider exists (never enable in production) |

## Deployment

* **Vercel**: set `DATABASE_URL` (Supabase/Neon/RDS Postgres), `APP_URL`, `CRON_SECRET`. Add a Vercel Cron entry calling `/api/cron/daily` (it sends `Authorization: Bearer $CRON_SECRET`). Document storage on Vercel needs an object store: swap `STORAGE_DIR` writes in `src/app/api/members/[id]/documents/route.ts` for Supabase Storage / S3 (the access check in `/api/documents/[id]` stays).
* **VPS/Docker**: `npm run build && npm start`, behind HTTPS; mount a persistent volume at `STORAGE_DIR`.
* On start, `src/instrumentation.ts` runs `bootstrap()`: creates tables from `./drizzle` migrations when missing, (re)applies the integrity triggers in `src/db/setup-sql.ts`, seeds demo data on an empty database.
* Schema changes: edit `src/db/schema.ts`, `npx drizzle-kit generate` (commit the SQL), `npx drizzle-kit migrate` or `push`.

## Backups and recovery

`scripts/backup.sh` writes a compressed `pg_dump` (and tars `STORAGE_DIR`). Enable provider-level daily backups and point-in-time recovery as well. To recover: restore into a fresh database, start the app (triggers are re-applied automatically), then run **Audit & security > Verify chain** and **Accounting > Reconciliation**. Test restores regularly.

## Architecture and security model

* **Tenancy**: every tenant table has `org_id`; every service query filters by the session's organisation and looks records up by `(id, org_id)`, so a foreign id returns "not found". Covered by `tests/integration.test.ts`. PostgreSQL Row Level Security is *not* enabled because the app connects with a single role; see limitations.
* **AuthN**: scrypt password hashes, random 256-bit session tokens stored hashed, HttpOnly SameSite=Lax cookies (Secure when behind HTTPS), 5-attempt lockout, single-use expiring reset tokens, password change revokes sessions on reset.
* **AuthZ**: role→permission matrix in `src/lib/permissions.ts`, enforced on the server in every action/route (`requireAction`, `requirePage`). Denied attempts are audited.
* **Ledger**: `postJournal` validates balance; a deferred constraint trigger re-checks in the database. `journal_lines`, `journal_entries`, `audit_logs`, `group_entries` are append-only (triggers). Transactions cannot be deleted or have amounts edited; savings balances and loan paid totals can only change inside ledger services (`app.ledger_write` guard). Corrections are reversals.
* **Fraud controls**: single-transaction limit, large-amount flags, duplicate detection window + unique provider references, rapid-withdrawal flag, maker-checker on withdrawals, loan approval and reversals, hash-chained audit trail.
* **Uploads**: private storage, magic-byte verification, size/type limits, authenticated download.

## Completed feature list

Auth & tenants (register, login/logout, reset, sessions, org profile/branding/policies, 8 roles, audit trail, platform console) · Members (registration, unique numbers, next of kin, documents, suspend/reactivate/exit, search/filter/pagination, CSV import, CSV/Excel export, financial profile) · Savings (products mandatory/voluntary/fixed/flexible, accounts, schedules, deposits, withdrawal approvals, interest posting, alerts) · Loans (products, eligibility, guarantors, collateral, approval, disbursement, flat/reducing schedules, partial/early repayment, penalties, restructuring, overdue/NPL) · VSLA (groups, leadership, cycles, shares, social/emergency funds, fines, group loans, rotating payouts, meetings, attendance, minutes, resolutions, share-out) · Accounting (chart of accounts, journal, cashbook, AP/AR, reversals, reconciliation, trial balance, balance sheet, income statement, cash flow) · Payments (manual channels, MTN/Airtel adapters, confirmation & reconciliation) · Member portal (mobile-first) · Notifications (in-app, SMS/email/WhatsApp adapters, delivery log, preferences, automation) · Dashboard with real SQL analytics and period/financial-year/cycle filters · Reports in PDF/Excel/CSV · SaaS plans, subscriptions, invoices, limits, support.

## Tests

```bash
npx vitest run     # 44 tests: schedules, allocation, penalties, eligibility, share-out, journal integrity, RBAC, triggers, loan lifecycle, tenant isolation
```
Integration tests create throw-away organisations in the configured database, so run them against a development database (never production).

## External integration requirements

* **MTN MoMo** (momodeveloper.mtn.com): Collection product subscription key, API user + key; production needs MTN onboarding and a callback/IP allow-list.
* **Airtel Money** (developers.airtel.africa): client id/secret, country UG, merchant onboarding.
* **SMS**: Africa's Talking account (sender ID registration for UG). **Email**: Resend domain verification. **WhatsApp**: Meta Business verification and approved templates for business-initiated messages.
* **Regulatory**: confirm obligations with the Registrar of Cooperatives/UMRA (registered SACCOs and tier 4 institutions have different reporting and capital rules than informal groups) and register as a data controller under the Data Protection and Privacy Act, 2019 where applicable.

## Remaining production-readiness limitations (honest list)

1. **Payment adapters are untested against live/sandbox APIs** in this repository (no credentials were available). Without credentials the system only supports manual confirmation, and says so in the UI. Webhook/callback endpoints (MTN `callbackUrl`, Airtel callback) are not implemented; status is pulled with "Check status".
2. **SMS/email/WhatsApp adapters are likewise untested**; without credentials messages are labelled *Simulated (not delivered)*.
3. **No PostgreSQL RLS / Supabase Auth**: isolation is enforced in application code with a single DB role. For defence in depth, add RLS policies keyed on `current_setting('app.org_id')` and use a non-superuser role.
4. Interest on savings uses the month-end balance (not average daily balance); loan interest is accrued on a cash basis (income recognised on collection), and no year-end closing entry is generated.
5. Rate limiting is per-account lockout only; add IP rate limiting / WAF and email-verification/MFA for production.
6. Document storage is local disk by default; use object storage on serverless hosts. No antivirus scanning.
7. Excel/PDF reports are generated synchronously; very large organisations should move heavy exports to a background job.
8. Full automated browser/UI tests are not included; manual smoke testing was performed via HTTP.
9. Offline/PWA support is not implemented (the UI is lightweight, server-rendered, and works on slow connections).
