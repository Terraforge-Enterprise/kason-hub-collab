// Entry point for the public e-namecard SPA bundle (per spec §7.3).
//
// This is a SEPARATE Vite entry from the admin/portal app — registered in
// vite.config.ts under build.rollupOptions.input.card. Production deploys
// emit `card.html` alongside `index.html`, and the deployment tier (S3 +
// CloudFront in this repo) is configured to serve card.html for /card/*
// paths so unauthenticated visitors never download the admin bundle.
//
// Do NOT import from src/main.tsx, src/router.tsx, src/lib/auth, or any
// admin/portal page module here — doing so would defeat the bundle split.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { PublicCardPage } from "./PublicCardPage";
import "../globals.css";

// Inline 404 element — kept as JSX expression rather than a separate
// component so this file remains a pure entry-point (no extra named
// component exports to trip react-refresh/only-export-components).
const notFoundElement = (
  <div className="min-h-screen flex items-center justify-center text-muted-foreground">
    This card is no longer available.
  </div>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/card/:token" element={<PublicCardPage />} />
        <Route path="*" element={notFoundElement} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
