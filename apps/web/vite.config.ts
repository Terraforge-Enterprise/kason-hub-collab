import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import net from "node:net";

// Dev override: point the API proxy at a non-default port (e.g. a worktree API
// on :3002) via VITE_DEV_API_TARGET. Default unchanged for normal dev.
const apiTarget = process.env.VITE_DEV_API_TARGET ?? "http://localhost:3001";

const PROXY_PREFIXES = ["/api", "/portal-api", "/public-api", "/webhooks"];

// How long to hold a request while the API is still coming up, and how often to
// re-probe its port during that wait.
const API_BOOT_WINDOW_MS = 15_000;
const API_PROBE_INTERVAL_MS = 250;
const API_PROBE_TIMEOUT_MS = 1_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `npm run dev` starts Vite and the API in parallel (`turbo run dev --parallel`),
// so they race: Vite is listening in ~100ms, the API needs ~1.5s to build its
// Prisma client. Every request the browser fires in that gap hits a closed port,
// and http-proxy dumps a bare `AggregateError [ECONNREFUSED]` stack per request
// — which reads like a failure but is just the API still booting, and leaves the
// first page load rendered with failed fetches.
//
// This gate runs BEFORE Vite's proxy middleware (a `configure` hook can't do the
// job — Vite attaches its own `error` listener that ends the response with a 500
// immediately, so there is nothing left to retry). It TCP-probes the API port and
// only hands the request to the proxy once the port accepts, so the proxy never
// sees a refused connection during startup.
function apiBootGate(): PluginOption {
  const { hostname, port } = new URL(apiTarget);
  const apiPort = Number(port) || (apiTarget.startsWith("https") ? 443 : 80);

  // Once the window has expired we treat the API as genuinely down and fail fast,
  // so a developer running the web app alone doesn't wait out the full window on
  // every request. The next successful probe clears it.
  let confirmedDown = false;
  let waitAnnounced = false;

  function probe(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(API_PROBE_TIMEOUT_MS, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      socket.connect(apiPort, hostname);
    });
  }

  return {
    name: "api-boot-gate",
    apply: "serve",
    configureServer(server) {
      // Registering directly (rather than in a returned callback) puts this
      // ahead of Vite's internal middlewares, including the proxy.
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        const proxied = PROXY_PREFIXES.some(
          (p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`),
        );
        if (!proxied) return next();

        void (async () => {
          if (await probe()) {
            confirmedDown = false;
            return next();
          }
          if (confirmedDown) return refuse(res);

          if (!waitAnnounced) {
            waitAnnounced = true;
            server.config.logger.info(`  ➜  waiting for API at ${apiTarget} …`);
          }

          const deadline = Date.now() + API_BOOT_WINDOW_MS;
          while (Date.now() < deadline) {
            await delay(API_PROBE_INTERVAL_MS);
            if (res.destroyed) return;
            if (await probe()) {
              confirmedDown = false;
              waitAnnounced = false;
              return next();
            }
          }
          confirmedDown = true;
          server.config.logger.warn(
            `  ➜  API at ${apiTarget} is not responding — start it, or set VITE_DEV_API_TARGET.`,
          );
          refuse(res);
        })();
      });
    },
  };
}

function refuse(res: import("node:http").ServerResponse) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `API not reachable at ${apiTarget}` }));
}

// Dev-server fallback for the public /card/* route. The production build
// emits two HTML entries (`index.html` for admin/portal, `card.html` for the
// public e-namecard SPA per spec §7.3) so public visitors don't download the
// admin bundle. In dev, Vite's default fallback rewrites every unknown path
// to /index.html, which would route /card/<token> to the admin SPA. This
// middleware rewrites /card/* to /card.html so the dev experience matches
// production.
function cardHtmlFallback(): PluginOption {
  return {
    name: "card-html-fallback",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && req.url.startsWith("/card/")) {
          req.url = "/card.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), apiBootGate(), cardHtmlFallback()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    // Kept in sync with PROXY_PREFIXES above, which gates these paths on the
    // API actually being up.
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/portal-api": { target: apiTarget, changeOrigin: true },
      "/public-api": { target: apiTarget, changeOrigin: true },
      // Public API webhooks (no auth) — e.g. the FPX mock-confirm endpoint the
      // mock bank page POSTs to. Lives at the app root, NOT under /portal-api,
      // so it needs its own dev-proxy entry to reach the API.
      "/webhooks": { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        // Admin + portal SPA entry (default).
        main: path.resolve(__dirname, "index.html"),
        // Public e-namecard SPA entry — separate bundle per spec §7.3 so
        // unauthenticated visitors don't download the admin code.
        card: path.resolve(__dirname, "card.html"),
      },
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
          query: ["@tanstack/react-query"],
          ui: ["@base-ui/react", "lucide-react"],
        },
      },
    },
  },
});
