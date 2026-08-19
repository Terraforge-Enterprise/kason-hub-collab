import { useState, useRef, useEffect, type FormEvent } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole, Mail } from "lucide-react";
import { setAdminToken, useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api-client";
import { LegalFooterLinks } from "@/components/legal-footer-links";

const gridCSS = `
.grid-lines{position:absolute;inset:0;pointer-events:none;opacity:.5}
.hline,.vline{position:absolute;background:rgba(255,255,255,0.06)}
.hline{left:0;right:0;height:1px;transform:scaleX(0);animation:drawX 1s cubic-bezier(.22,.61,.36,1) forwards}
.vline{top:0;bottom:0;width:1px;transform:scaleY(0);animation:drawY 1.1s cubic-bezier(.22,.61,.36,1) forwards}
@keyframes drawX{to{transform:scaleX(1)}}
@keyframes drawY{to{transform:scaleY(1)}}
@keyframes fadeSlideUp{0%{opacity:0;transform:translateY(32px)}100%{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{0%{opacity:0}100%{opacity:1}}
`;

export default function LoginPage() {
  const { setAuth, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    searchParams.get("error") === "invalid_credentials"
      ? "Invalid email or password"
      : searchParams.get("error") === "missing_fields"
      ? "Please enter email and password"
      : null
  );
  const [resetSuccess] = useState(searchParams.get("reset") === "success");
  const [isPending, setIsPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Redirect if already authenticated
  useEffect(() => {
    if (isAuthenticated) navigate("/dashboard", { replace: true });
  }, [isAuthenticated, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Please enter email and password");
      return;
    }
    setIsPending(true);
    setError(null);
    try {
      const result = await apiFetch<{
        user: { id: string; fullName: string; email: string; role: string; userType: string };
        orgId: string;
        token: string;
      }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      // Store the token for the Authorization-header fallback path. iOS
      // Safari drops the cross-site cookie; the bearer header is what keeps
      // mobile users logged in.
      setAdminToken(result.token);
      setAuth({
        id: result.user.id,
        fullName: result.user.fullName,
        email: result.user.email,
        role: result.user.role,
        orgId: result.orgId,
        userType: result.user.userType,
      });
      navigate("/dashboard", { replace: true });
    } catch (err) {
      if (err instanceof Error && (err as any).code === "PORTAL_ACCOUNT") {
        navigate("/portal/login", { replace: true });
        return;
      }
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsPending(false);
    }
  };

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

    const onResize = () => { setSize(); init(); };
    window.addEventListener("resize", onResize);
    init();
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const hLines = [20, 40, 60, 80];
  const vLines = [20, 40, 60, 80];

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0a0e1f]">
      <style dangerouslySetInnerHTML={{ __html: gridCSS }} />

      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

      <div className="grid-lines">
        {hLines.map((p, i) => (
          <div key={`h${i}`} className="hline" style={{ top: `${p}%`, animationDelay: `${i * 0.12}s` }} />
        ))}
        {vLines.map((p, i) => (
          <div key={`v${i}`} className="vline" style={{ left: `${p}%`, animationDelay: `${i * 0.12 + 0.06}s` }} />
        ))}
      </div>

      <div
        className="relative z-10 mx-4 w-full max-w-md rounded-3xl border border-white/[0.1] bg-white/[0.06] p-8 shadow-[0_0_80px_-20px_rgba(212,175,55,0.15)] backdrop-blur-xl sm:p-10"
        style={{ animation: "fadeSlideUp 0.7s cubic-bezier(.22,.61,.36,1) both" }}
      >
        <div className="mb-8 flex flex-col items-center gap-1" style={{ animation: "fadeIn 0.6s 0.15s both" }}>
          <img src="/logo.png" alt="KAEN Properties" width={128} height={128} className="h-32 w-32 object-contain" />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight text-white">KAEN Properties</h1>
            <p className="mt-1 text-sm text-white/40">Property intelligence, simplified.</p>
          </div>
        </div>

        {resetSuccess && (
          <div className="mb-6 rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300" role="status" aria-live="polite">
            Password reset. Sign in with your new password.
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300" role="alert" aria-live="polite">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid gap-5">
          <label className="grid gap-2" style={{ animation: "fadeIn 0.5s 0.25s both" }}>
            <span className="text-sm font-medium text-white/60">Email</span>
            <span className="group flex min-h-12 items-center gap-3 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 transition focus-within:border-[#D4AF37] focus-within:ring-4 focus-within:ring-amber-500/20">
              <Mail className="h-4 w-4 text-white/30 transition group-focus-within:text-[#D4AF37]" aria-hidden="true" />
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/25"
              />
            </span>
          </label>

          <label className="grid gap-2" style={{ animation: "fadeIn 0.5s 0.35s both" }}>
            <span className="text-sm font-medium text-white/60">Password</span>
            <span className="group flex min-h-12 items-center gap-3 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 transition focus-within:border-[#D4AF37] focus-within:ring-4 focus-within:ring-amber-500/20">
              <LockKeyhole className="h-4 w-4 text-white/30 transition group-focus-within:text-[#D4AF37]" aria-hidden="true" />
              <input
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/25"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/40 transition hover:bg-white/[0.08] hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]"
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
              </button>
            </span>
          </label>

          <div className="-mt-2 text-right">
            <Link to="/forgot-password" className="text-sm text-white/50 transition hover:text-white/80">Forgot password?</Link>
          </div>

          <div style={{ animation: "fadeIn 0.5s 0.45s both" }}>
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#B8963E_0%,#D4AF37_100%)] px-5 py-3 text-sm font-semibold text-white shadow-[0_24px_40px_-24px_rgba(180,150,62,0.50)] transition duration-200 hover:translate-y-[-2px] hover:shadow-[0_28px_44px_-24px_rgba(180,150,62,0.65)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isPending ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Signing in...
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </div>
        </form>

        {/* See components/legal-footer-links.tsx — this is a landing page a
            payment-gateway reviewer can reach without a session. */}
        <LegalFooterLinks className="mt-8" showEntity />
      </div>
    </main>
  );
}
