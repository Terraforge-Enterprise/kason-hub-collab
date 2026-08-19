// NEGATIVE TEST FIXTURE — this file IS EXPECTED TO FAIL ESLint.
//
// It deliberately imports auth middleware from inside the public-card module
// to prove the no-restricted-imports rule from spec §9.1 actually fires.
//
// The CI script `scripts/test-eslint-guards.sh` runs eslint on this file and
// asserts the expected error is present. If you change this file, also update
// that script.
//
// DO NOT delete this file. DO NOT "fix" the lint error.
// eslint-disable for *any other rule* is fine; the no-restricted-imports
// error MUST stay.

import { authMiddleware } from "../../../middleware/auth";
export const _intentionallyFails: unknown = authMiddleware;
