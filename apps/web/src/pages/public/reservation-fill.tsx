import { Fragment, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  Briefcase,
  Building2,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ClipboardSignature,
  Eraser,
  Home,
  IdCard,
  Loader2,
  Lock,
  MapPin,
  PenLine,
  Phone,
  ShieldCheck,
  UploadCloud,
  User,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchPublicReservation,
  fillPublicReservation,
  signPublicReservation,
  requestReservationUploadUrl,
  uploadReservationFile,
  markReservationDoc,
  deleteReservationDoc,
  type PublicReservationDto,
} from "@/api/public-reservations";
import { SignatureCanvas, type SignatureCanvasHandle } from "@/components/signature-canvas";
import { TncModal } from "@/components/tnc-modal";

const MY_STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
  "Wilayah Persekutuan Kuala Lumpur",
  "Wilayah Persekutuan Labuan",
  "Wilayah Persekutuan Putrajaya",
] as const;

function isMyState(value: string): value is (typeof MY_STATES)[number] {
  return (MY_STATES as readonly string[]).includes(value);
}

// Country is a real dropdown (identical affordance to State/Nationality) with
// the common cases listed; "Other / not listed" reveals a free-text input so
// any nationality can still reserve — the same escape-hatch pattern as State.
const COUNTRY_OPTIONS = [
  "Malaysia",
  "Singapore",
  "Indonesia",
  "Thailand",
  "Philippines",
  "Vietnam",
  "Cambodia",
  "Myanmar",
  "China",
  "Hong Kong",
  "Taiwan",
  "Japan",
  "South Korea",
  "India",
  "Bangladesh",
  "Sri Lanka",
  "Nepal",
  "Pakistan",
  "United Kingdom",
  "United States",
  "Australia",
] as const;

function isKnownCountry(value: string): value is (typeof COUNTRY_OPTIONS)[number] {
  return (COUNTRY_OPTIONS as readonly string[]).includes(value);
}

function formatMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat("en-MY", {
    style: "currency",
    currency: "MYR",
    minimumFractionDigits: 2,
  }).format(n);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
      <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
        {children}
      </span>
    </div>
  );
}

function PaperCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-3xl border border-amber-200/60 bg-white shadow-[0_30px_80px_-20px_rgba(184,150,62,0.18)] dark:border-amber-800/30 dark:bg-zinc-900">
      <div className="h-1.5 bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
      <div className="p-7 md:p-9">{children}</div>
    </div>
  );
}

function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        "w-full rounded-xl border border-zinc-300 bg-white px-3.5 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 transition-colors focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:ring-amber-900/30",
        className,
      )}
    />
  );
}

// A visibly-distinct dropdown: `appearance-none` strips the native control so
// the affordance is identical across browsers, and the amber caret + tinted
// surface signal "pick from a list" so it never reads as a plain text field.
function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          "w-full cursor-pointer appearance-none rounded-xl border border-zinc-300 bg-gradient-to-b from-white to-zinc-50 px-3.5 py-2.5 pr-10 text-sm text-zinc-900 transition-colors focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100 dark:border-zinc-700 dark:from-zinc-900 dark:to-zinc-900/60 dark:text-zinc-100 dark:focus:ring-amber-900/30",
          className,
        )}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-amber-500" />
    </div>
  );
}

function Field({
  label,
  required,
  optional,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-zinc-700 dark:text-zinc-400">
        <span>
          {label}
          {required && <span className="ml-0.5 text-rose-500">*</span>}
        </span>
        {optional && (
          <span className="rounded-full bg-zinc-100 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500">
            Optional
          </span>
        )}
      </span>
      {children}
      {hint && (
        <span className="block text-[11px] leading-snug text-zinc-400 dark:text-zinc-500">
          {hint}
        </span>
      )}
    </label>
  );
}

// A titled sub-section so required and optional fields never sit in one
// undifferentiated grid. `note` carries a plain-language cue (e.g. that a
// whole block can be skipped).
function FieldGroup({
  icon: Icon,
  title,
  note,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-7 first:mt-0">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-zinc-100 pb-2 dark:border-zinc-800">
        <Icon className="h-3.5 w-3.5 text-amber-500" />
        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
          {title}
        </span>
        {note && (
          <span className="text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
            · {note}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

const ID_MIME = ["image/jpeg", "image/png", "image/heic", "application/pdf"];

function IdUploadSlot({
  token, kind, label, uploadedName, onChange,
}: {
  token: string; kind: string; label: string;
  uploadedName: string | null;
  onChange: (kind: string, filename: string | null) => void;
}) {
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const inputId = `iddoc-${kind}`;

  async function pick(file: File) {
    setErr(null);
    if (!ID_MIME.includes(file.type)) { setErr("Use JPG, PNG, HEIC or PDF."); return; }
    try {
      setPct(0);
      const signed = await requestReservationUploadUrl(token, {
        kind, contentType: file.type, filename: file.name,
      });
      await uploadReservationFile(signed, file, setPct);
      const saved = await markReservationDoc(token, { kind, filename: file.name });
      onChange(kind, saved.filename);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setPct(null);
    }
  }

  async function remove() {
    try { await deleteReservationDoc(token, kind); onChange(kind, null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Remove failed"); }
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors",
        uploadedName
          ? "border-emerald-300 bg-emerald-50/50 dark:border-emerald-800/60 dark:bg-emerald-950/20"
          : "border-zinc-300 dark:border-zinc-700",
      )}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-400">{label}</span>
        {uploadedName && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <CheckCircle2 className="h-3 w-3" />
            Uploaded
          </span>
        )}
      </div>
      {uploadedName ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="truncate" title={uploadedName}>{uploadedName}</span>
          <button type="button" className="text-rose-600 text-xs hover:underline" onClick={remove}>Remove</button>
        </div>
      ) : (
        <>
          <label htmlFor={inputId} className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-500 transition-colors hover:border-amber-400 hover:text-amber-600 dark:border-zinc-700 dark:hover:border-amber-600">
            <UploadCloud className="h-3.5 w-3.5" />
            {pct === null ? "Upload photo / scan" : `Uploading ${pct}%…`}
          </label>
          <input id={inputId} type="file" accept={ID_MIME.join(",")} className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ""; }} />
        </>
      )}
      {err && <p className="mt-1 text-[11px] text-rose-600">{err}</p>}
    </div>
  );
}

function PropertySummary({ reservation }: { reservation: PublicReservationDto }) {
  const charges = [
    ["Reservation deposit", reservation.charges.reservationDeposit],
    ["Documentation fee", reservation.charges.documentationFee],
    ["Rental deposit", reservation.charges.rentalDeposit],
    ["Utility deposit", reservation.charges.utilityDeposit],
    ["Access card deposit", reservation.charges.accessCardDeposit],
  ] as const;
  const total = charges
    .reduce((acc, [, v]) => acc + (Number(v) || 0), 0)
    .toFixed(2);

  return (
    <PaperCard>
      <SectionLabel>Section A · Reservation details</SectionLabel>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            <Building2 className="h-3 w-3" />
            Property
          </div>
          <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {reservation.property.name}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            <MapPin className="h-3 w-3" />
            Unit
          </div>
          <p className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {reservation.unit.unitCode}
            {reservation.carPark && (
              <span className="ml-2 text-xs font-normal text-zinc-500">
                · Car park {reservation.carPark}
              </span>
            )}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            <CalendarDays className="h-3 w-3" />
            Proposed move-in
          </div>
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {formatDate(reservation.proposedMoveIn)}
          </p>
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            <CalendarDays className="h-3 w-3" />
            Proposed move-out
          </div>
          <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            {reservation.proposedMoveOut ? formatDate(reservation.proposedMoveOut) : "—"}
          </p>
        </div>
      </div>

      {reservation.specialRemarks && (
        <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-800/40 dark:text-zinc-300">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            Special remarks
          </div>
          <p className="whitespace-pre-wrap">{reservation.specialRemarks}</p>
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <tbody>
            {charges.map(([label, value], i) => (
              <tr
                key={label}
                className={i % 2 === 0 ? "bg-white dark:bg-zinc-900" : "bg-zinc-50/50 dark:bg-zinc-800/30"}
              >
                <td className="px-4 py-2.5 text-zinc-600 dark:text-zinc-400">{label}</td>
                <td className="px-4 py-2.5 text-right font-mono font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                  {formatMoney(value)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-amber-200/60 bg-gradient-to-r from-amber-50 to-yellow-50 dark:border-amber-800/40 dark:from-amber-950/30 dark:to-yellow-950/30">
              <td className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-amber-800 dark:text-amber-300">
                Total payable
              </td>
              <td className="px-4 py-3 text-right font-mono text-base font-bold tabular-nums text-amber-800 dark:text-amber-300">
                {formatMoney(total)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </PaperCard>
  );
}

export default function ReservationFillPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [reservation, setReservation] = useState<PublicReservationDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [section, setSection] = useState<"fill" | "sign">("fill");
  const [form, setForm] = useState({
    applicantFullName: "",
    applicantNric: "",
    applicantContact: "",
    applicantEmail: "",
    applicantAddressLine1: "",
    applicantAddressLine2: "",
    applicantCity: "",
    applicantPostcode: "",
    applicantState: "",
    applicantCountry: "Malaysia",
    nationality: "Malaysian",
    emergencyContactName: "",
    emergencyContactPhone: "",
    emergencyContactRelation: "",
    occupation: "",
    monthlyIncome: "",
  });
  // kind -> uploaded filename (server-confirmed). Empty until mark-uploaded.
  const [docs, setDocs] = useState<Record<string, string>>({});
  // UI-only toggle: distinguishes "unselected" from a deliberate "Other /
  // outside Malaysia" pick so the free-text state input can be revealed. Not
  // part of `form`, so it is never sent to the API.
  const [stateOther, setStateOther] = useState(false);
  // Same escape-hatch toggle for Country: reveals the free-text input when the
  // applicant's country isn't one of the listed options.
  const [countryOther, setCountryOther] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [agreementTicked, setAgreementTicked] = useState(false);
  const [tncModalOpen, setTncModalOpen] = useState(false);
  const [hasReadTnc, setHasReadTnc] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sigRef = useRef<SignatureCanvasHandle>(null);

  useEffect(() => {
    if (!token) return;
    fetchPublicReservation(token)
      .then((r) => {
        setReservation(r);
        setForm({
          applicantFullName: r.applicant.fullName ?? "",
          applicantNric: r.applicant.nric ?? "",
          applicantContact: r.applicant.contact ?? "",
          applicantEmail: r.applicant.email ?? "",
          applicantAddressLine1: r.applicant.addressLine1 ?? "",
          applicantAddressLine2: r.applicant.addressLine2 ?? "",
          applicantCity: r.applicant.city ?? "",
          applicantPostcode: r.applicant.postcode ?? "",
          applicantState: r.applicant.state ?? "",
          applicantCountry: r.applicant.country ?? "Malaysia",
          nationality: r.applicant.nationality ?? "Malaysian",
          emergencyContactName: r.applicant.emergencyContactName ?? "",
          emergencyContactPhone: r.applicant.emergencyContactPhone ?? "",
          emergencyContactRelation: r.applicant.emergencyContactRelation ?? "",
          occupation: r.applicant.occupation ?? "",
          monthlyIncome: r.applicant.monthlyIncome ?? "",
        });
        // A hydrated non-MY state means the applicant is outside Malaysia —
        // reveal the free-text fallback with their saved value.
        const hydratedState = r.applicant.state ?? "";
        setStateOther(hydratedState !== "" && !isMyState(hydratedState));
        // Same for a saved country that isn't one of the listed options.
        const hydratedCountry = r.applicant.country ?? "Malaysia";
        setCountryOther(hydratedCountry !== "" && !isKnownCountry(hydratedCountry));
        // Defensive: `documents` should always be present per the DTO
        // contract, but guard against a missing/empty key so a stale fixture
        // or partial response never throws in the .map(...) below.
        setDocs(Object.fromEntries((r.documents ?? []).map((d) => [d.kind, d.filename])));
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [token]);

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-zinc-50 to-rose-50/30 px-6 dark:from-zinc-950 dark:to-rose-950/20">
        <div className="max-w-sm rounded-3xl border border-rose-200 bg-white p-8 text-center shadow-xl dark:border-rose-900 dark:bg-zinc-900">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950">
            <AlertCircle className="h-7 w-7 text-rose-600 dark:text-rose-400" />
          </div>
          <h1 className="mb-2 text-xl font-bold text-zinc-900 dark:text-zinc-100">
            Link no longer valid
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            This reservation link has expired or has already been completed. Please contact
            your property agent if you need a new link.
          </p>
        </div>
      </div>
    );
  }

  if (!reservation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading reservation…
        </div>
      </div>
    );
  }

  function handleDocChange(kind: string, filename: string | null) {
    setDocs((prev) => {
      const next = { ...prev };
      if (filename) next[kind] = filename;
      else delete next[kind];
      return next;
    });
  }

  async function saveFill() {
    if (!token) return;
    setSubmitting(true);
    setError(null);
    try {
      await fillPublicReservation(token, {
        ...form,
        applicantAddressLine2: form.applicantAddressLine2.trim() || undefined,
        emergencyContactRelation: form.emergencyContactRelation.trim() || undefined,
        occupation: form.occupation.trim() || undefined,
        monthlyIncome: form.monthlyIncome.trim() || undefined,
      });
      setSection("sign");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSign() {
    if (!token) return;
    setError(null);

    if (!sigRef.current || sigRef.current.isEmpty()) {
      setError("Please draw your signature in the box below.");
      return;
    }
    if (!agreementTicked) {
      setError("You must agree to the Terms & Conditions to continue.");
      return;
    }
    if (typedName.trim().toLowerCase() !== form.applicantFullName.trim().toLowerCase()) {
      setError("Typed name must exactly match your full name above.");
      return;
    }

    setSubmitting(true);
    try {
      const signaturePngBase64 = sigRef.current.getDataUrl();
      const r = await signPublicReservation(token, {
        typedName,
        agreementTicked: true,
        signaturePngBase64,
      });
      navigate(`/reserve/${token}/signed`, { state: { pdfUrl: r.signedPdfDownloadUrl } });
    } catch (e) {
      // Backend wraps signature errors as { error: "EMPTY_SIGNATURE" } /
      // { error: "NAME_MISMATCH" }. Humanize for the public-facing UI.
      const raw = e instanceof Error ? e.message : "Sign failed";
      if (raw === "EMPTY_SIGNATURE") {
        setError("Please draw a clearer signature — the box looks empty or too small.");
      } else if (raw === "NAME_MISMATCH") {
        setError("Typed name must exactly match the applicant full name above.");
      } else if (raw === "ID_DOCUMENT_REQUIRED") {
        setError("Please upload at least one identity document (passport or IC) before signing.");
      } else {
        setError(raw);
      }
    } finally {
      setSubmitting(false);
    }
  }

  const isFillStep = section === "fill";
  // A document is only "complete" when BOTH its front and back are uploaded.
  // The applicant may provide either a Passport OR an IC, but whichever they
  // choose must have both sides before they can continue.
  const hasCompletePassport = Boolean(docs.passport_front && docs.passport_back);
  const hasCompleteIc = Boolean(docs.ic_front && docs.ic_back);
  const hasId = hasCompletePassport || hasCompleteIc;

  return (
    <div className="min-h-screen bg-gradient-to-br from-zinc-50 via-amber-50/20 to-zinc-50 px-4 py-10 dark:from-zinc-950 dark:via-amber-950/10 dark:to-zinc-950">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Branded header */}
        <header className="flex flex-wrap items-end justify-between gap-4 pb-2">
          <div className="flex items-end gap-4">
            <img
              src={reservation.brandLogoUrl ?? "/logo.png"}
              alt="KAEN Properties"
              className="h-14 w-auto rounded-md object-contain"
            />
            <div>
              <div className="mb-2 flex items-center gap-2">
                <div className="h-[18px] w-[3px] rounded-sm bg-gradient-to-b from-[#B8963E] via-[#D4AF37] to-[#E8CF6D]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#D4AF37]">
                  Unit Reservation
                </span>
              </div>
              <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100 md:text-3xl">
                {reservation.referenceCode}
              </h1>
            </div>
          </div>
          <div className="rounded-full border border-zinc-200/80 bg-white/60 px-3 py-1.5 text-xs text-zinc-600 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
            Link expires {formatDate(reservation.expiresAt)}
          </div>
        </header>

        {/* Step indicator */}
        <div className="flex items-center gap-3 text-xs">
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 font-medium ${
              isFillStep
                ? "bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-400"
            }`}
          >
            {isFillStep ? (
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/30 text-[10px] font-bold">
                1
              </span>
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Your details
          </div>
          <div className="h-px flex-1 bg-zinc-300 dark:bg-zinc-700" />
          <div
            className={`flex items-center gap-2 rounded-full px-3 py-1.5 font-medium ${
              isFillStep
                ? "bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500"
                : "bg-amber-500/15 text-amber-800 ring-1 ring-amber-500/30 dark:text-amber-300"
            }`}
          >
            <span
              className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                isFillStep
                  ? "bg-zinc-300 dark:bg-zinc-700"
                  : "bg-amber-500/30"
              }`}
            >
              2
            </span>
            Sign &amp; submit
          </div>
        </div>

        <PropertySummary reservation={reservation} />

        {/* Section B / Sign */}
        {isFillStep ? (
          <PaperCard>
            <SectionLabel>Section B · Your details</SectionLabel>
            <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
              Provide the applicant's information exactly as it appears on the NRIC or
              passport. These details will be printed on the signed reservation form.
            </p>

            {/* Marker key — one glance tells the applicant what each cue means,
                so "required vs optional vs dropdown" never has to be guessed. */}
            <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-4 py-2.5 text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400">
              <span className="inline-flex items-center gap-1.5">
                <span className="text-sm leading-none text-rose-500">*</span>
                Required
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="rounded-full bg-zinc-200 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-zinc-500 dark:bg-zinc-700 dark:text-zinc-300">
                  Optional
                </span>
                can be left blank
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ChevronDown className="h-3.5 w-3.5 text-amber-500" />
                Pick from a list
              </span>
            </div>

            <FieldGroup icon={User} title="Personal details">
              <Field label="Full name" required hint="Exactly as printed on your NRIC / passport.">
                <Input
                  value={form.applicantFullName}
                  onChange={(e) =>
                    setForm({ ...form, applicantFullName: e.target.value.toUpperCase() })
                  }
                  placeholder="AS PER NRIC / PASSPORT"
                  autoComplete="name"
                  required
                />
              </Field>
              <Field label="NRIC / Passport number" required>
                <Input
                  value={form.applicantNric}
                  onChange={(e) => setForm({ ...form, applicantNric: e.target.value })}
                  placeholder="e.g. 891231-14-5678"
                  autoComplete="off"
                  required
                />
              </Field>
              <Field label="Nationality" required>
                <Select
                  aria-label="Nationality"
                  value={form.nationality}
                  onChange={(e) => setForm({ ...form, nationality: e.target.value })}
                  required
                >
                  <option value="Malaysian">Malaysian</option>
                  <option value="Non-Malaysian">Non-Malaysian</option>
                </Select>
              </Field>
              <Field label="Contact number" required>
                <Input
                  type="tel"
                  value={form.applicantContact}
                  onChange={(e) => setForm({ ...form, applicantContact: e.target.value })}
                  placeholder="+60 12-345 6789"
                  autoComplete="tel"
                  required
                />
              </Field>
              <Field label="Email" required>
                <Input
                  type="email"
                  value={form.applicantEmail}
                  onChange={(e) => setForm({ ...form, applicantEmail: e.target.value })}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </Field>
            </FieldGroup>

            <FieldGroup
              icon={Home}
              title="Home address"
              note="your current address, not the unit you're renting"
            >
              <Field label="Home address line 1" required>
                <Input
                  value={form.applicantAddressLine1}
                  onChange={(e) =>
                    setForm({ ...form, applicantAddressLine1: e.target.value })
                  }
                  placeholder="Unit / house no. & street"
                  autoComplete="address-line1"
                  required
                />
              </Field>
              <Field label="Home address line 2" optional>
                <Input
                  value={form.applicantAddressLine2}
                  onChange={(e) =>
                    setForm({ ...form, applicantAddressLine2: e.target.value })
                  }
                  placeholder="Apartment, suite, block, etc."
                  autoComplete="address-line2"
                />
              </Field>
              <Field label="City" required>
                <Input
                  value={form.applicantCity}
                  onChange={(e) => setForm({ ...form, applicantCity: e.target.value })}
                  placeholder="e.g. Kuala Lumpur"
                  autoComplete="address-level2"
                  required
                />
              </Field>
              <Field label="Postcode" required>
                <Input
                  value={form.applicantPostcode}
                  onChange={(e) => setForm({ ...form, applicantPostcode: e.target.value })}
                  placeholder="e.g. 55100"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  required
                />
              </Field>
              <Field label="State" required>
                <Select
                  aria-label="State"
                  value={stateOther ? "__other__" : isMyState(form.applicantState) ? form.applicantState : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__other__") {
                      setStateOther(true);
                      setForm({ ...form, applicantState: "" });
                    } else {
                      setStateOther(false);
                      setForm({ ...form, applicantState: v });
                    }
                  }}
                  required
                >
                  <option value="" disabled>
                    Select a state
                  </option>
                  {MY_STATES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  <option value="__other__">Other / outside Malaysia</option>
                </Select>
                {stateOther && (
                  <Input
                    aria-label="State / province"
                    value={form.applicantState}
                    onChange={(e) => setForm({ ...form, applicantState: e.target.value })}
                    placeholder="Enter state / province"
                    required
                  />
                )}
              </Field>
              <Field label="Country" required>
                <Select
                  aria-label="Country"
                  value={countryOther ? "__other__" : isKnownCountry(form.applicantCountry) ? form.applicantCountry : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "__other__") {
                      setCountryOther(true);
                      setForm({ ...form, applicantCountry: "" });
                    } else {
                      setCountryOther(false);
                      setForm({ ...form, applicantCountry: v });
                    }
                  }}
                  required
                >
                  <option value="" disabled>
                    Select a country
                  </option>
                  {COUNTRY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  <option value="__other__">Other / not listed</option>
                </Select>
                {countryOther && (
                  <Input
                    aria-label="Country / region"
                    value={form.applicantCountry}
                    onChange={(e) => setForm({ ...form, applicantCountry: e.target.value })}
                    placeholder="Enter your country"
                    autoComplete="country-name"
                    required
                  />
                )}
              </Field>
            </FieldGroup>

            <FieldGroup
              icon={Briefcase}
              title="Employment & income"
              note="optional — leave blank if you'd rather not share"
            >
              <Field label="Occupation" optional>
                <Input
                  value={form.occupation}
                  onChange={(e) => setForm({ ...form, occupation: e.target.value })}
                  placeholder="e.g. Software Engineer"
                  autoComplete="organization-title"
                />
              </Field>
              <Field label="Monthly income" optional hint="Providing this can help support your application.">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-medium text-zinc-400">
                    RM
                  </span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    className="pl-10"
                    value={form.monthlyIncome}
                    onChange={(e) => setForm({ ...form, monthlyIncome: e.target.value })}
                    placeholder="e.g. 5,000"
                  />
                </div>
              </Field>
            </FieldGroup>

            <FieldGroup
              icon={Phone}
              title="Emergency contact"
              note="someone we can reach if we can't reach you"
            >
              <Field label="Emergency contact name" required>
                <Input
                  value={form.emergencyContactName}
                  onChange={(e) => setForm({ ...form, emergencyContactName: e.target.value })}
                  placeholder="Full name"
                  autoComplete="name"
                  required
                />
              </Field>
              <Field label="Emergency contact phone" required>
                <Input
                  type="tel"
                  value={form.emergencyContactPhone}
                  onChange={(e) => setForm({ ...form, emergencyContactPhone: e.target.value })}
                  placeholder="+60 12-345 6789"
                  autoComplete="tel"
                  required
                />
              </Field>
              <Field label="Emergency contact relationship" optional>
                <Input
                  value={form.emergencyContactRelation}
                  onChange={(e) => setForm({ ...form, emergencyContactRelation: e.target.value })}
                  placeholder="e.g. Spouse, Parent, Sibling"
                />
              </Field>
            </FieldGroup>

            <section className="mt-8">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <IdCard className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-300">
                  Identity documents
                </span>
                <span className="rounded-full bg-rose-50 px-2 py-[1px] text-[9px] font-bold uppercase tracking-wide text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                  Required
                </span>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
                Upload <strong className="font-semibold text-zinc-700 dark:text-zinc-300">either</strong> your
                MyKad / IC <strong className="font-semibold text-zinc-700 dark:text-zinc-300">or</strong> your
                Passport — you don't need both document types. Whichever you choose, both the{" "}
                <strong className="font-semibold text-zinc-700 dark:text-zinc-300">front and back</strong> are
                required before you can sign.
              </p>

              {token && (
                <div className="flex flex-col gap-3 md:flex-row md:items-stretch">
                  {([
                    { title: "MyKad / IC", slots: [["ic_front", "IC (front)"], ["ic_back", "IC (back)"]] },
                    { title: "Passport", slots: [["passport_front", "Passport (front)"], ["passport_back", "Passport (back)"]] },
                  ] as const).map((group, gi) => (
                    <Fragment key={group.title}>
                      {gi === 1 && (
                        <div className="flex items-center justify-center py-1 md:py-0">
                          <span className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900">
                            or
                          </span>
                        </div>
                      )}
                      <fieldset className="flex-1 rounded-2xl border border-zinc-200 p-3 dark:border-zinc-800">
                        <legend className="px-1 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
                          {group.title}
                        </legend>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {group.slots.map(([kind, label]) => (
                            <IdUploadSlot
                              key={kind}
                              token={token}
                              kind={kind}
                              label={label}
                              uploadedName={docs[kind] ?? null}
                              onChange={handleDocChange}
                            />
                          ))}
                        </div>
                      </fieldset>
                    </Fragment>
                  ))}
                </div>
              )}
            </section>

            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {hasId ? (
              <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Front and back uploaded — you're ready to continue.
              </p>
            ) : (
              <p className="mt-4 inline-flex items-center gap-1.5 text-[11px] text-amber-600">
                <AlertCircle className="h-3.5 w-3.5" />
                Upload both the front and back of your MyKad / IC or Passport to continue.
              </p>
            )}

            <button
              type="button"
              onClick={saveFill}
              disabled={submitting || !hasId}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_28px_-8px_rgba(184,150,62,0.45)] transition-all hover:shadow-[0_16px_32px_-6px_rgba(184,150,62,0.55)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100 md:w-auto"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  Continue to signing
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </PaperCard>
        ) : (
          <PaperCard>
            <SectionLabel>Section C · Signature</SectionLabel>
            <p className="mb-5 text-sm text-zinc-600 dark:text-zinc-400">
              Draw your signature in the box, type your full name, and confirm the
              agreement to complete this reservation.
            </p>

            {/* Review block — the address is frozen at signature (spec R3), so
                the applicant must be able to review it read-only before signing. */}
            <div className="mb-6 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
              <p className="mb-2 font-medium text-zinc-700 dark:text-zinc-300">
                Review your details
              </p>
              <p className="text-zinc-600 dark:text-zinc-400">{form.applicantFullName}</p>
              <p className="text-zinc-600 dark:text-zinc-400">{form.applicantNric}</p>
              <p className="text-zinc-600 dark:text-zinc-400">
                {[
                  form.applicantAddressLine1,
                  form.applicantAddressLine2,
                  form.applicantCity,
                  form.applicantPostcode,
                  form.applicantState,
                  form.applicantCountry,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                This address cannot be changed after signing. Go back if anything is
                incorrect.
              </p>
            </div>

            {/* Signature panel */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                  <PenLine className="h-3.5 w-3.5" />
                  Your signature
                </span>
                <button
                  type="button"
                  onClick={() => sigRef.current?.clear()}
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline dark:hover:text-zinc-200"
                >
                  <Eraser className="h-3 w-3" />
                  Clear
                </button>
              </div>
              <div className="overflow-hidden rounded-xl border-2 border-dashed border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-950">
                <SignatureCanvas ref={sigRef} width={500} height={160} />
              </div>
            </div>

            <div className="mt-6 space-y-4">
              <Field label="Type your full name to confirm" required>
                <Input
                  value={typedName}
                  onChange={(e) => setTypedName(e.target.value)}
                  placeholder={form.applicantFullName || "Your full name"}
                />
              </Field>

              <div className={`flex items-start gap-3 rounded-xl border bg-zinc-50/60 p-4 transition-colors dark:bg-zinc-900/40 ${
                hasReadTnc
                  ? "border-zinc-200 hover:border-amber-300 hover:bg-amber-50/40 dark:border-zinc-800 dark:hover:border-amber-700 dark:hover:bg-amber-950/20"
                  : "border-zinc-200 opacity-80 dark:border-zinc-800"
              }`}>
                <input
                  id="agreement-checkbox"
                  type="checkbox"
                  checked={agreementTicked}
                  onChange={(e) => setAgreementTicked(e.target.checked)}
                  disabled={!hasReadTnc}
                  className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-amber-600 focus:ring-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="text-sm text-zinc-700 dark:text-zinc-300">
                  <label
                    htmlFor="agreement-checkbox"
                    className={hasReadTnc ? "cursor-pointer" : "cursor-not-allowed"}
                  >
                    I confirm the details above are accurate and I agree to the
                  </label>{" "}
                  <button
                    type="button"
                    onClick={() => setTncModalOpen(true)}
                    className="font-semibold text-zinc-900 underline underline-offset-2 dark:text-zinc-100 hover:text-amber-700 dark:hover:text-amber-300"
                  >
                    Terms &amp; Conditions
                  </button>
                  <label
                    htmlFor="agreement-checkbox"
                    className={hasReadTnc ? "cursor-pointer" : "cursor-not-allowed"}
                  >
                    {" "}of this Unit Reservation Form.
                  </label>
                  {!hasReadTnc && (
                    <span className="ml-1.5 text-xs italic text-amber-700 dark:text-amber-400">
                      (Open and scroll the T&Cs to enable the checkbox.)
                    </span>
                  )}
                </div>
              </div>
            </div>

            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{error}</p>
              </div>
            )}

            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => setSection("fill")}
                disabled={submitting}
                className="text-xs text-zinc-500 underline-offset-2 hover:text-zinc-800 hover:underline disabled:opacity-50 dark:hover:text-zinc-200"
              >
                ← Edit my details
              </button>
              <button
                type="button"
                onClick={submitSign}
                disabled={submitting}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#B8963E] via-[#D4AF37] to-[#E8CF6D] px-5 py-3 text-sm font-semibold text-white shadow-[0_12px_28px_-8px_rgba(184,150,62,0.45)] transition-all hover:shadow-[0_16px_32px_-6px_rgba(184,150,62,0.55)] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing…
                  </>
                ) : (
                  <>
                    <ClipboardSignature className="h-4 w-4" />
                    Sign &amp; submit
                  </>
                )}
              </button>
            </div>
          </PaperCard>
        )}

        <TncModal
          open={tncModalOpen}
          onClose={() => setTncModalOpen(false)}
          onReadToBottom={() => setHasReadTnc(true)}
          customTerms={reservation.customTerms}
          initialReachedBottom={hasReadTnc}
        />

        {/* Trust footer */}
        <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 pt-2 text-[11px] text-zinc-500 dark:text-zinc-500">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" />
            Encrypted submission
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" />
            Token-gated single-use link
          </span>
        </div>
      </div>
    </div>
  );
}
