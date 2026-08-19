# Notes for AI coding agents

Read this before planning any work in this repository.

## What this repository is

A collaboration copy of the Kason Hub property-management application. It is
**not** the authoritative repository, and it is **not connected to any deployed
environment**. The maintained copy lives in a separate private repository which
acts as the source of truth and the backup.

## This copy is deliberately incomplete

The following were removed before publishing. Their absence is intentional and
is **not** a bug to fix:

- `.github/workflows/` — CI and deployment pipelines
- `infra/`, `deploy/` — Terraform and deployment configuration
- `supabase/` — hosted database project configuration
- `docs/` — internal specifications, plans, runbooks, meeting notes
- `e2e/` — end-to-end tests (contained environment URLs and test logins)
- parts of `scripts/` — environment reset, wipe and credential utilities
- `apps/web/.env.prod`, `.env.production`, `.env.uat` — per-environment settings

## Rules

1. **Do not attempt to deploy anything.** There is no deployment pipeline here
   by design, and no environment to deploy to. Do not write GitHub Actions
   workflows, Terraform, or deployment scripts unless explicitly asked.

2. **Do not reconstruct the removed files.** If a task seems to require one,
   stop and say so rather than recreating it from guesswork.

3. **There are no credentials in this repository, and there must never be
   any.** No API keys, no database URLs, no `.env` files, no tokens. This
   repository is public. If a task genuinely needs a real credential or a
   deployment target, stop and ask the repository owner — they will supply what
   is needed through a private channel.

4. **Run everything locally.** Use a local PostgreSQL database and a local
   `.env` derived from `.env.example`. Never point this code at a shared or
   hosted database.

5. **Do not add or modify anything under `.github/`.**

## Working locally

```bash
npm install
cp .env.example .env
cp apps/web/.env.example apps/web/.env
createdb kasonhub
npm run db:generate && npm run db:migrate && npm run db:seed
npm run dev
```

Set `SESSION_SECRET` in `.env` to any random 32+ character string; the API will
not boot without it. `DATABASE_URL` and `SESSION_SECRET` are the only required
variables — email, storage, WhatsApp and payments all fall back to mocks when
left blank. `.env.example` documents every variable the application reads.

Seed accounts are defined in `packages/db/prisma/seed.ts`.

## Layout

| Path | Contents |
|---|---|
| `apps/api/` | Hono API server |
| `apps/web/` | Vite single-page application |
| `packages/db/` | Prisma schema, migrations, generated client |
| `packages/` | Shared internal packages |

## Git

Push to `main` freely. `main` cannot be force-pushed or deleted; ordinary
pushes and merges are fine. Never rewrite published history — the owner pulls
changes from this repository into the authoritative one, and a rewrite breaks
that.
