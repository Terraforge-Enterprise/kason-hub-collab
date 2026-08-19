import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // OFF (2026-07-29). This rule guards Vite fast-refresh granularity only —
      // a file that exports a component alongside anything else loses
      // component-level HMR and full-reloads instead. It has NO effect on the
      // production bundle or on runtime behaviour.
      //
      // It accounted for 140 of the repo's 220 lint warnings, spread over 32
      // files. Clearing them means splitting those modules so each exports only
      // components — a large mechanical refactor, across money-critical
      // surfaces, that changes nothing a user or the build can observe. Not
      // worth the regression risk, so the rule is off rather than papered over
      // with 140 inline disables.
      //
      // The React-Compiler-era react-hooks rules (set-state-in-effect, refs,
      // preserve-manual-memoization) stay ERRORS on purpose — those catch real
      // defects. Existing deliberate patterns carry per-site disables with a
      // stated reason; new violations still fail the build.
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],

      // Drawer System Redesign — ban window.confirm and inline width classes
      // on SheetContent. The first rule's escape hatch is <ConfirmAlert>;
      // the second is the `size` prop with semantic tokens (sm/md/lg/xl/full).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='window'][property.name='confirm']",
          message:
            "Use <ConfirmAlert> from @/components/ui/confirm-alert (or FormDrawer's action.confirm) — window.confirm is banned.",
        },
        {
          // Match <SheetContent ... className="... w-... ..."> and ... className="... max-w-... ...">
          // The literal regex inside JSXAttribute selectors needs the slashes
          // escaped within the string. Tailwind variants like md:w-[480px]
          // also match because the body contains the substring "w-".
          selector:
            "JSXOpeningElement[name.name='SheetContent'] JSXAttribute[name.name='className'] Literal[value=/\\b(w-|max-w-)/]",
          message:
            "Don't set width classes on SheetContent — use the size prop. See sheetSizes in @/components/ui/sheet.tsx.",
        },
      ],
    },
  },

  // Drawer System Redesign — role-envelope import boundary.
  // Portal (agent-side) and admin (operator-side) share the same backend rows
  // but stay disjoint at the data layer: separate API modules, fetch helpers,
  // and query-key namespaces. See apps/web/src/api/sales-claims.ts:6-7 for the
  // canonical statement of the rule. Do not bridge these via shared imports.
  {
    files: ["src/pages/portal/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/api-client",
              message:
                "Portal pages must use portalApiFetch from @/lib/portal-api, not apiFetch from @/lib/api-client.",
            },
          ],
          patterns: [
            {
              group: [
                "@/api/sales-claims",
                "@/api/sales",
                "@/api/renovation-claims",
                "@/api/renovation-settings",
                "@/api/source-queue",
                "@/api/sales-source-queue",
                "@/api/inventory-source-queue",
                // Agent E-Namecard envelope isolation (spec §6.4):
                // public-card module is its own role envelope.
                "@/api/public-card",
                "@/api/public-card/**",
              ],
              message:
                "Portal pages must not import admin or public-card API modules. Use the @/api/portal-* counterpart.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/pages/commissions/**/*.{ts,tsx}",
      "src/pages/sales/**/*.{ts,tsx}",
      "src/pages/parties/**/*.{ts,tsx}",
      "src/pages/workspace/**/*.{ts,tsx}",
      "src/pages/inventory/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/portal-api",
              message:
                "Admin pages must not use portalApiFetch — use apiFetch from @/lib/api-client.",
            },
          ],
          patterns: [
            {
              group: ["@/api/portal-*"],
              message:
                "Admin pages must not import portal-* API modules. Use the @/api/<name> admin counterpart.",
            },
            {
              // Agent E-Namecard envelope isolation (spec §6.4).
              group: ["@/api/public-card", "@/api/public-card/**"],
              message:
                "Admin pages must NOT import the public-card API module (per spec §6.4).",
            },
          ],
        },
      ],
    },
  },

  // === Agent E-Namecard envelope isolation (spec §6.4) ===
  // The public-card module is unauthenticated. Pages under src/pages/card/**
  // must use native fetch — apiFetch carries admin auth headers and
  // portalApiFetch carries portal auth headers; neither belongs on a public
  // surface.
  {
    files: ["src/pages/card/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/api-client",
              importNames: ["apiFetch"],
              message:
                "public card pages must NOT use apiFetch — use native fetch (per spec §6.4).",
            },
            {
              name: "@/lib/portal-api",
              importNames: ["portalApiFetch"],
              message:
                "public card pages must NOT use portalApiFetch — use native fetch (per spec §6.4).",
            },
          ],
        },
      ],
    },
  },
  // Organization pages have no existing envelope rule, so block public-card
  // here as a standalone override.
  {
    files: ["src/pages/organization/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/api/public-card", "@/api/public-card/**"],
              message:
                "Organization pages must NOT import the public-card API module (per spec §6.4).",
            },
          ],
        },
      ],
    },
  },

  { ignores: ["dist/", "node_modules/"] },
);
