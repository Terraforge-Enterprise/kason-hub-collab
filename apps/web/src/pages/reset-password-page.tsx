import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Eye, EyeOff, LockKeyhole, AlertCircle } from "lucide-react";
import { adminResetPassword, adminVerifyResetToken } from "@/api/admin-auth";

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

type State =
  | { kind: "verifying" }
  | { kind: "valid"; fullName: string }
  | { kind: "invalid" }
  | { kind: "submitting"; fullName: string };

export default function ResetPasswordPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");

  const [state, setState] = useState<State>(token ? { kind: "verifying" } : { kind: "invalid" });
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [show1, setShow1] = useState(false);
  const [show2, setShow2] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    adminVerifyResetToken(token)
      .then((res) => { if (active) setState({ kind: "valid", fullName: res.fullName }); })
      .catch(() => { if (active) setState({ kind: "invalid" }); });
    return () => { active = false; };
  }, [token]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.kind !== "valid") return;
    setError(null);
    if (pw1.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (pw1 !== pw2) { setError("Passwords don't match."); return; }
    setState({ kind: "submitting", fullName: state.fullName });
    try {
      await adminResetPassword(token!, pw1);
      navigate("/login?reset=success", { replace: true });
    } catch {
      setState({ kind: "invalid" });
    }
  };

  // Background canvas — same as login-page
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    let particles: { x: number; y: number; v: number; o: number; size: number }[] = [];
    const setSize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    setSize();
    const make = () => ({
      x: Math.random() * canvas.width, y: Math.random() * canvas.height,
      v: 0.05 + Math.random() * 0.2, o: 0.05 + Math.random() * 0.15, size: 0.5 + Math.random() * 1.2,
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
        if (p.y < 0) { p.x = Math.random() * canvas.width; p.y = canvas.height + Math.random() * 40; }
        ctx.fillStyle = `rgba(212, 175, 55, ${p.o})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
      });
      raf = requestAnimationFrame(draw);
    };
    const onResize = () => { setSize(); init(); };
    window.addEventListener("resize", onResize);
    init(); raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, []);

  const hLines = [20, 40, 60, 80];
  const vLines = [20, 40, 60, 80];

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[#0a0e1f]">
      <style dangerouslySetInnerHTML={{ __html: gridCSS }} />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      <div className="grid-lines">
        {hLines.map((p, i) => <div key={`h${i}`} className="hline" style={{ top: `${p}%`, animationDelay: `${i * 0.12}s` }} />)}
        {vLines.map((p, i) => <div key={`v${i}`} className="vline" style={{ left: `${p}%`, animationDelay: `${i * 0.12 + 0.06}s` }} />)}
      </div>
      <div
        className="relative z-10 mx-4 w-full max-w-md rounded-3xl border border-white/[0.1] bg-white/[0.06] p-8 shadow-[0_0_80px_-20px_rgba(212,175,55,0.15)] backdrop-blur-xl sm:p-10"
        style={{ animation: "fadeSlideUp 0.7s cubic-bezier(.22,.61,.36,1) both" }}
      >
        {state.kind === "verifying" && (
          <div className="text-center text-sm text-white/60" style={{ animation: "fadeIn 0.4s both" }}>
            <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-white/40 border-t-transparent" />
            Verifying link…
          </div>
        )}

        {state.kind === "invalid" && (
          <div className="text-center" style={{ animation: "fadeIn 0.4s both" }}>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/15 text-rose-300">
              <AlertCircle className="h-6 w-6" aria-hidden="true" />
            </div>
            <h1 className="mb-2 text-xl font-semibold tracking-tight text-white">This link is invalid or expired</h1>
            <p className="text-sm text-white/60">Reset links expire after 15 minutes and can only be used once.</p>
            <div className="mt-6 grid gap-3">
              <Link to="/forgot-password" className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#B8963E_0%,#D4AF37_100%)] px-5 py-3 text-sm font-semibold text-white shadow-[0_24px_40px_-24px_rgba(180,150,62,0.50)]">Request a new link</Link>
              <Link to="/login" className="text-center text-sm text-white/50 hover:text-white/80">Back to sign in</Link>
            </div>
          </div>
        )}

        {(state.kind === "valid" || state.kind === "submitting") && (
          <>
            <div className="mb-6" style={{ animation: "fadeIn 0.6s 0.15s both" }}>
              <h1 className="text-xl font-semibold tracking-tight text-white">Set a new password</h1>
              <p className="mt-1 text-sm text-white/50">Hi {state.fullName}, choose a new password for your account.</p>
            </div>

            {error && (
              <div className="mb-6 rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300" role="alert" aria-live="polite">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="grid gap-5">
              <PasswordField label="New password" value={pw1} onChange={setPw1} show={show1} setShow={setShow1} hint="At least 8 characters" autoComplete="new-password" />
              <PasswordField label="Confirm password" value={pw2} onChange={setPw2} show={show2} setShow={setShow2} autoComplete="new-password" />

              <button
                type="submit" disabled={state.kind === "submitting"}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-2xl bg-[linear-gradient(135deg,#B8963E_0%,#D4AF37_100%)] px-5 py-3 text-sm font-semibold text-white shadow-[0_24px_40px_-24px_rgba(180,150,62,0.50)] transition duration-200 hover:translate-y-[-2px] hover:shadow-[0_28px_44px_-24px_rgba(180,150,62,0.65)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {state.kind === "submitting" ? "Updating…" : "Update password"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  show: boolean;
  setShow: (v: boolean) => void;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <label className="grid gap-2" style={{ animation: "fadeIn 0.5s 0.25s both" }}>
      <span className="text-sm font-medium text-white/60">{props.label}</span>
      <span className="group flex min-h-12 items-center gap-3 rounded-xl border border-white/[0.1] bg-white/[0.04] px-4 transition focus-within:border-[#D4AF37] focus-within:ring-4 focus-within:ring-amber-500/20">
        <LockKeyhole className="h-4 w-4 text-white/30 transition group-focus-within:text-[#D4AF37]" aria-hidden="true" />
        <input
          type={props.show ? "text" : "password"} required minLength={8}
          autoComplete={props.autoComplete} value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          className="w-full border-0 bg-transparent text-[15px] text-white outline-none placeholder:text-white/25"
        />
        <button
          type="button" onClick={() => props.setShow(!props.show)}
          aria-label={props.show ? "Hide password" : "Show password"}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/40 transition hover:bg-white/[0.08] hover:text-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37]"
        >
          {props.show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
        </button>
      </span>
      {props.hint && <span className="text-xs text-white/40">{props.hint}</span>}
    </label>
  );
}
