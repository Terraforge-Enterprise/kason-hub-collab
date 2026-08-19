# Kason Hub — Collaboration Copy

A working copy of the Kason Hub property-management application, for
collaborative development.

This is **not** the authoritative repository and it is **not deployed
anywhere**. The maintained copy lives in a separate private repository, which
is the source of truth and the backup. Work here freely — push to `main`, merge
whatever you like. Nothing you do in this repo can affect a live environment.

## What has been removed from this copy

This copy is deliberately incomplete. The following were stripped out before
publishing, because they contain deployment credentials, infrastructure
identifiers, or internal planning material:

| Removed | What it was |
|---|---|
| `.github/workflows/` | CI and deployment pipelines |
| `infra/`, `deploy/` | Terraform and deployment configuration |
| `supabase/` | Hosted database project configuration |
| `docs/` | Internal specifications, plans, runbooks and meeting notes |
| `e2e/` | End-to-end test suite (contained environment URLs and test logins) |
| `scripts/` (partial) | Environment reset, wipe and credential utilities |
| `apps/web/.env.prod`, `.env.production`, `.env.uat` | Per-environment build settings |
| Agent tooling and internal notes | Assistant configuration and handover docs |

**If something appears broken or missing because of this, that is expected.**
Do not try to reconstruct the removed pieces. Nothing is lost — the complete
version is preserved in the private repository. Raise it and it will be sorted
out on that side.

## Getting started

You need Node (see `.nvmrc`) and a local PostgreSQL server. Nothing else — no
cloud account, no API key, no access to any hosted environment.

```bash
# 1. install
npm install

# 2. configure — the defaults in these two files work as-is for local dev
cp .env.example .env
cp apps/web/.env.example apps/web/.env

# 3. set a session secret in .env (the API will not start without one)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. create the database and load the schema
createdb kasonhub
npm run db:generate
npm run db:migrate

# 5. seed demo data (properties, units, tenancies and login accounts)
npm run db:seed

# 6. run it — API on :3001, web on :5173
npm run dev
```

Open http://localhost:5173. The accounts the seed creates are defined in
`packages/db/prisma/seed.ts` — read the file to see the emails and passwords.
They exist only in your own local database.

Only `DATABASE_URL` and `SESSION_SECRET` are actually required. Every other
variable is optional: email, file storage, WhatsApp and online-banking payments
all fall back to mocks or no-ops when left blank, so the app runs fine without
a single real credential. `.env.example` documents each one.

## Deployment

There is none, and that is intentional. This repository has no CI, no
deployment pipeline, and no environment attached to it.

**Run the application locally.** That is the supported way to work here, and it
is enough for essentially all development.

If a piece of work genuinely requires a deployed environment or a real API key,
**stop and ask the repository owner.** They will provide what is needed through
a private channel. Do not create deployment workflows, and do not commit
credentials to this repository under any circumstances — it is public.

## Layout

| Path | Contents |
|---|---|
| `apps/api/` | Hono API server |
| `apps/web/` | Vite single-page application |
| `packages/db/` | Prisma schema, migrations and generated client |
| `packages/` | Shared internal packages |

## Contributing

Push to `main` as you go. `main` cannot be force-pushed or deleted — ordinary
pushes and merges are fine. Changes are reviewed and pulled across into the
authoritative repository from here.

Never commit secrets, API keys, database URLs, or `.env` files. This repository
is public.
