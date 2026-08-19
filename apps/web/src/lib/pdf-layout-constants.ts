// PDF layout values that the A4 live preview shares with the server-side
// renderer. The renderer's CSS literals live in
// apps/api/src/lib/document-templates/render.ts — when you change one of
// these, update both. The existing render snapshot test in render.test.ts
// acts as a tripwire if they drift.
export const A4_HEIGHT_MM = 297;
export const A4_WIDTH_MM = 210;
export const LOGO_MAX_HEIGHT_MM = 40;
export const LOGO_HEIGHT_PCT = (LOGO_MAX_HEIGHT_MM / A4_HEIGHT_MM) * 100;
