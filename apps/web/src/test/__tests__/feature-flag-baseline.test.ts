import { describe, it, expect } from "vitest";

/**
 * Guard: a test run must never inherit feature-flag state from a developer's
 * untracked `apps/web/.env.local`.
 *
 * Vite loads `.env.local` into `import.meta.env` for TEST runs too, not just the
 * dev server. Without a deliberate baseline, the flags a developer turns on for
 * their own dev app silently decide test outcomes — so a "flag OFF (default)"
 * suite is green in CI (which has no `.env.local`) and red on the machine of the
 * person actually running it. That inverted feedback loop cost 8 red files and had
 * already been hand-patched per-file twice
 * (`components/__tests__/charge-form.test.tsx`, `pages/tasks/__tests__/tasks-board-page.test.tsx`)
 * before being fixed at the seam in `src/test/setup.ts`.
 *
 * A test that needs a flag ON sets it explicitly with `vi.stubEnv(...)` — the
 * established idiom (see `components/__tests__/navigation-billing.test.ts`). That
 * still works: the baseline only removes AMBIENT values, it does not block stubs.
 */
describe("feature-flag test baseline", () => {
  it("starts a test file with no ambient VITE_ENABLE_* flags", () => {
    const leaked = Object.keys(import.meta.env)
      .filter((k) => k.startsWith("VITE_ENABLE_"))
      .sort();

    expect(leaked).toEqual([]);
  });
});
