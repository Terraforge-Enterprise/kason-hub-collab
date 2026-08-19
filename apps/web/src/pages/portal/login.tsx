import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { queryClient } from "@/main";
import { portalApiFetch, PortalApiError } from "@/lib/portal-api";
import { setPortalToken } from "@/lib/auth";
import { LegalFooterLinks } from "@/components/legal-footer-links";

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function PortalLoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const resetSuccess = searchParams.get("reset") === "success";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  // When set, the user is rate-limited until this Date.now() ms timestamp.
  // While locked, the submit button is disabled and the error block shows
  // a live countdown — no API roundtrip will succeed before this expires.
  const [lockUntil, setLockUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // One ticking effect drives the countdown AND auto-clears the lock when it
  // expires. Both setState calls happen inside the interval callback, never
  // synchronously during effect mount — the React rule disallows the latter.
  useEffect(() => {
    if (lockUntil === null) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockUntil) {
        setLockUntil(null);
        setError(null);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [lockUntil]);

  // Slow gold "star" particles drifting bottom -> top — the same ambient glow
  // the admin login has. Purely decorative background canvas: it sits behind
  // the card and ignores pointer events, so nothing else about this page's
  // design changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const setSize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    setSize();

    type Particle = { x: number; y: number; v: number; o: number; size: number };
    let particles: Particle[] = [];
    let raf = 0;

    const make = (): Particle => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      v: Math.random() * 0.3 + 0.05,
      o: Math.random() * 0.4 + 0.1,
      size: Math.random() * 1.5 + 0.5,
    });

    const init = () => {
      particles = [];
      const count = Math.floor((canvas.width * canvas.height) / 12000);
      for (let i = 0; i < count; i++) particles.push(make());
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach((p) => {
        p.y -= p.v;
        if (p.y < 0) {
          p.x = Math.random() * canvas.width;
          p.y = canvas.height + Math.random() * 40;
        }
        ctx.fillStyle = `rgba(212, 175, 55, ${p.o})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      });
      raf = requestAnimationFrame(draw);
    };

    const onResize = () => {
      setSize();
      init();
    };
    window.addEventListener("resize", onResize);
    init();
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const lockSecondsLeft =
    lockUntil !== null ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;
  const isLocked = lockSecondsLeft > 0;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isLocked) return;
    if (!email || !password) {
      setError("Please enter email and password");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const result = await portalApiFetch<{ ok: true; token: string }>(
        "/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ email, password }),
          redirectOnUnauthorized: false,
        },
      );
      // Store the token for the Authorization-header fallback path. iOS
      // Safari drops the cross-site portal_session cookie; the bearer header
      // is what keeps the mobile session alive.
      setPortalToken(result.token);
      queryClient.removeQueries({ predicate: (q) => String(q.queryKey[0]).startsWith("portal") });
      navigate("/portal/dashboard");
    } catch (err) {
      if (err instanceof PortalApiError && err.status === 429) {
        const body = err.body as { retryAfter?: number } | null;
        const seconds = typeof body?.retryAfter === "number" && body.retryAfter > 0
          ? body.retryAfter
          : 900;
        setLockUntil(Date.now() + seconds * 1000);
        setError(err.message);
      } else if (err instanceof PortalApiError && err.status === 401) {
        setError("Wrong email or password.");
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[var(--page-bg)] px-4">
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="relative z-10 w-full max-w-md rounded-3xl border border-[var(--card-border)] bg-[var(--card-bg)] p-8 backdrop-blur sm:p-10">
        <div className="mb-8 flex flex-col items-center gap-1">
          <img src="/logo.png" alt="KAEN Properties" className="h-32 w-32 object-contain" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-[var(--text-primary)]">Portal Login</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">Sign in to access your account</p>
          </div>
        </div>

        {resetSuccess && (
          <div className="mb-6 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300" role="status" aria-live="polite">
            Password reset. Sign in with your new password.
          </div>
        )}

        {error && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400" role="alert">
            <div>{error}</div>
            {isLocked && (
              <div className="mt-1 font-mono tabular-nums text-red-300">
                Try again in {formatCountdown(lockSecondsLeft)}
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid gap-5">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Email</span>
            <span className="group flex min-h-12 items-center gap-3 rounded-xl border border-[var(--input-border)] bg-[var(--card-bg)] px-4 transition focus-within:border-[var(--primary)] focus-within:ring-4 focus-within:ring-[var(--ring)]">
              <Mail className="h-4 w-4 text-[var(--text-muted)] transition group-focus-within:text-[var(--primary)]" aria-hidden="true" />
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border-0 bg-transparent text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
            </span>
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--text-secondary)]">Password</span>
            <span className="group flex min-h-12 items-center gap-3 rounded-xl border border-[var(--input-border)] bg-[var(--card-bg)] px-4 transition focus-within:border-[var(--primary)] focus-within:ring-4 focus-within:ring-[var(--ring)]">
              <LockKeyhole className="h-4 w-4 text-[var(--text-muted)] transition group-focus-within:text-[var(--primary)]" aria-hidden="true" />
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border-0 bg-transparent text-[15px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] transition hover:bg-[var(--page-bg)] hover:text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </span>
          </label>

          <div className="-mt-2 text-right">
            <Link to="/portal/forgot-password" className="text-sm text-[var(--text-secondary)] transition hover:text-[var(--text-primary)]">Forgot password?</Link>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading || isLocked}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-[linear-gradient(135deg,var(--gold-dark)_0%,var(--gold)_100%)] px-5 py-3 text-sm font-semibold text-white shadow-[0_24px_40px_-24px_rgba(180,150,62,0.50)] transition duration-200 hover:translate-y-[-2px] hover:shadow-[0_28px_44px_-24px_rgba(180,150,62,0.65)] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Signing in...
                </span>
              ) : isLocked ? (
                <span>Locked &middot; {formatCountdown(lockSecondsLeft)}</span>
              ) : (
                "Sign in"
              )}
            </button>
          </div>
        </form>

        {/*
          The merchant site's de-facto landing page: "/" redirects to /dashboard,
          which bounces a logged-out visitor here. A payment-gateway reviewer
          therefore sees this screen, so the compliance pages must be reachable
          from it. See components/legal-footer-links.tsx.
        */}
        <LegalFooterLinks className="mt-8" showEntity />
      </div>
    </div>
  );
}
