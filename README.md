# Kaen Properties

Real Estate Operating System project bootstrapped from Kaen Properties architecture and logic.

## Source Spec
- `docs/superpowers/specs/2026-04-06-kaen-real-estate-os-design.md`

## Core Direction
- Multi-tenant real estate OS anchored to **Unit**
- Stack parity with Kaen Properties (Next.js 16, TS 5, Prisma 7 + Postgres 16, Tailwind 4)
- Copy business logic and data models from Kaen Properties; re-skin UI separately

## Next Steps
1. Initialize package scaffold with Kaen Properties versions
2. Copy auth/session/rbac/audit primitives
3. Port required Prisma models (Phase 1)
4. Implement Module 1-8 server actions and cron jobs
