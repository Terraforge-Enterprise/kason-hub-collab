import tseslint from "typescript-eslint";

// Bootstrapped 2026-05-05 for Agent E-Namecard (spec §9.1).
// Scope: minimal flat-config that enforces the public-card module's
// envelope isolation. Project-wide rules are intentionally permissive —
// this is not a retrofit; broaden later as needed.
export default tseslint.config(
  {
    // The public-card __fixtures__ directory is ignored from `npm run lint`
    // because it contains a NEGATIVE TEST FIXTURE that intentionally violates
    // the no-restricted-imports rule (see
    // src/modules/public-card/__fixtures__/should-fail-lint.ts). A dedicated
    // CI script — `scripts/test-eslint-guards.sh` — runs eslint on that file
    // with `--no-ignore` and asserts the rule fires. Per spec §9.1 #2.
    ignores: [
      "dist/**",
      "node_modules/**",
      "prisma/migrations/**",
      "src/modules/public-card/__fixtures__/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Bootstrap mode: keep the rule surface narrow so `npm run lint` is
    // green out of the box. The only rule we actively enforce today is
    // the public-card envelope guard below; broaden later as needed.
    linterOptions: {
      // Pre-existing files in this app have inline `// eslint-disable-next-line
      // @typescript-eslint/no-explicit-any` comments. We turn that rule off
      // below, so without this opt-out every one of those comments would
      // surface as "unused eslint-disable directive" noise.
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // === Agent E-Namecard envelope isolation (spec §9.1) ===
  // The public-card module serves unauthenticated requests. It MUST NOT
  // reach for the auth or role middleware — doing so would either gate a
  // public surface behind auth (breaking it) or, worse, leak the impression
  // that the surface is protected when it isn't. Block both.
  {
    files: ["src/modules/public-card/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "../../middleware/auth",
              message:
                "public-card module must NOT import auth middleware (per spec §9.1).",
            },
            {
              name: "../../middleware/require-role",
              message:
                "public-card module must NOT import requireRole (per spec §9.1).",
            },
          ],
          patterns: [
            {
              group: [
                "**/middleware/auth",
                "**/middleware/auth/**",
                "**/middleware/require-auth*",
                "**/middleware/require-role*",
              ],
              message:
                "public-card module must NOT import auth middleware (per spec §9.1).",
            },
          ],
        },
      ],
    },
  },
);
