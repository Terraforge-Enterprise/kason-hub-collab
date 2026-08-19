import { Copy, MessageCircle, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function SendLinkActions({
  reservationId,
  referenceCode,
  publicToken,
  propertyName,
  unitCode,
  apiBasePath,
}: {
  reservationId: string;
  referenceCode: string;
  publicToken: string;
  propertyName: string;
  unitCode: string;
  /**
   * Fully-qualified base for the reservation API, e.g.
   * `${API_BASE}/admin/reservations` (admin) or
   * `${PORTAL_API_BASE}/reservations` (portal). Caller must include the
   * env-aware origin — relative paths break in S3+CloudFront UAT/prod where
   * the SPA host does not proxy /api or /portal-api to Lightsail.
   */
  apiBasePath: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const link = `${window.location.origin}/reserve/${publicToken}`;
  const message = encodeURIComponent(
    `Hi, please sign your Unit Reservation Form for ${propertyName} ${unitCode} (${referenceCode}):\n${link}`,
  );

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Sign link copied to clipboard");
    } catch {
      toast.error("Failed to copy — copy the URL manually");
    }
  }

  async function onDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`${apiBasePath}/${reservationId}/unsigned-pdf`, {
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 401) toast.error("Session expired — please reload the page");
        else toast.error(`Could not generate PDF (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${referenceCode}-unsigned.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not generate PDF");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={onCopy}>
        <Copy className="h-4 w-4 mr-1.5" /> Copy link
      </Button>
      <a
        href={`https://wa.me/?text=${message}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-3 py-1.5 text-sm font-medium hover:bg-accent"
      >
        <MessageCircle className="h-4 w-4" /> Share via WhatsApp
      </a>
      <Button variant="outline" size="sm" onClick={onDownload} disabled={downloading}>
        {downloading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Download className="h-4 w-4 mr-1.5" />}
        {downloading ? "Generating…" : "Download PDF"}
      </Button>
    </div>
  );
}
