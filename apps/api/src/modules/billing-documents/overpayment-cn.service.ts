// apps/api/src/modules/billing-documents/overpayment-cn.service.ts
//
// Manual overpayment Credit Note (spec R12): a tenant/owner transfers more than
// the invoice total; the accountant records the settling payment against the
// invoice (P3), then issues a CN for the overpaid remainder. The CN's lines
// settle NO charge and carry NO category (R12a — nullable columns), so
// creditAmount = CN total = fully spendable. Own tx, deterministic idempotency,
// FOR UPDATE row-lock on the freshly minted CN so a concurrent auto/manual
// apply-credit never races off a stale `available`. The CN then flows into the
// existing apply-credit path (credit-apply.service.ts) unchanged.
import { getDb, Prisma } from "@kason/db";
import { recordAudit } from "../../lib/audit";
import { toCents, centsToString } from "@kason/shared";
import { issueDocumentTx, type IssueLineInput } from "./issue.service";
import { lockCreditNoteAndRecomputeAvailable } from "./credit-apply.service";

export type OverpaymentCnLine = { description: string; amount: string; chargeId?: string; categoryId?: string };

export type CreateOverpaymentCnInput = {
  originalDocumentId: string;
  partyId: string;
  counterpartyType: "tenant" | "owner";
  lines: OverpaymentCnLine[];
  /** Default = CN total (fully spendable). */
  creditAmount?: string;
  reason: string;
  idempotencyKey: string;
};

export type CreateOverpaymentCnSession = { orgId: string; userId: string; role: string };

export async function createOverpaymentCreditNoteService(
  session: CreateOverpaymentCnSession,
  input: CreateOverpaymentCnInput,
): Promise<
  | { ok: true; status: 201; data: { id: string; documentNumber: string; creditAmount: string } }
  | { ok: false; status: number; error: string }
> {
  if (input.lines.length === 0) return { ok: false as const, status: 400, error: "LINES_REQUIRED" };

  // CN total from lines (cent math — no float drift). creditAmount defaults to it.
  let totalCents = 0;
  for (const l of input.lines) {
    const c = toCents(l.amount, "overpaymentCn.line");
    if (c <= 0) return { ok: false as const, status: 400, error: "LINE_AMOUNT_INVALID" };
    totalCents += c;
  }
  const creditAmount = input.creditAmount ?? centsToString(totalCents);

  const db = getDb();
  try {
    const result = await db.$transaction(async (tx) => {
      const original = await tx.billingDocument.findFirst({
        where: { id: input.originalDocumentId, organizationId: session.orgId },
        select: { id: true, docType: true, status: true },
      });
      if (!original) return { ok: false as const, status: 404, error: "ORIGINAL_NOT_FOUND" };
      // A DENYLIST, so `proforma` is named explicitly — unlike the CN/correction paths
      // next door, which use `docType: { in: ["invoice", "debit_note"] }` allowlists and
      // exclude it for free. A proforma is a provisional request for payment carrying no
      // money weight (isNonReceivableDocType), so crediting one would issue real,
      // LHDN-reportable relief against a document that never established a receivable —
      // and the invoice graduated from it would still owe the full amount.
      if (
        original.docType === "credit_note"
        || original.docType === "refund_note"
        || original.docType === "proforma"
      ) {
        return { ok: false as const, status: 400, error: "ORIGINAL_NOT_INVOICEABLE" };
      }
      if (original.status === "offset") {
        return { ok: false as const, status: 400, error: "ORIGINAL_OFFSET" };
      }

      const lines: IssueLineInput[] = input.lines.map((l) => ({
        chargeId: l.chargeId, // undefined ⇒ null line (R12a)
        categoryId: l.categoryId,
        description: l.description,
        amount: l.amount,
        sstRate: "0", // overpayment credit carries no SST
      }));

      const cn = await issueDocumentTx(tx, {
        organizationId: session.orgId,
        docType: "credit_note",
        seriesCode: "CN",
        counterpartyType: input.counterpartyType,
        partyId: input.partyId,
        originalDocumentId: input.originalDocumentId,
        creditAmount,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
        lines,
        actorUserId: session.userId,
      });

      // Row-lock the freshly minted CN (SELECT … FOR UPDATE) so a concurrent
      // auto/manual apply-credit serializes against this exact CN and can never
      // over-read `available` (spec invariant: spendable ≤ creditAmount).
      await lockCreditNoteAndRecomputeAvailable(tx, session.orgId, cn.id, Number(creditAmount));

      await recordAudit(tx, {
        organizationId: session.orgId,
        actorUserId: session.userId,
        actorRole: session.role,
        action: "billing-docs.credit_note.overpayment_issue",
        entityType: "BillingDocument",
        entityId: cn.id,
        meta: {
          originalDocumentId: input.originalDocumentId,
          creditAmount,
          reason: input.reason,
        } as unknown as Prisma.InputJsonValue,
      });

      return { ok: true as const, status: 201 as const, data: { id: cn.id, documentNumber: cn.documentNumber, creditAmount } };
    });
    return result;
  } catch (e) {
    // Defense-in-depth: a replayed idempotencyKey is handled inside
    // issueDocumentTx (returns the existing doc, no P2002); a genuine unique
    // collision here must not surface as an unhandled 500.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await db.billingDocument.findFirst({
        where: { organizationId: session.orgId, idempotencyKey: input.idempotencyKey },
        select: { id: true, documentNumber: true, creditAmount: true },
      });
      if (existing) {
        return {
          ok: true as const,
          status: 201 as const,
          data: { id: existing.id, documentNumber: existing.documentNumber, creditAmount: existing.creditAmount?.toString() ?? creditAmount },
        };
      }
      return { ok: false as const, status: 409, error: "DUPLICATE" };
    }
    throw e;
  }
}
