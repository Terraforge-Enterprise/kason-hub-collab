import { getDb, Prisma } from "@kason/db";
import type { ManualInvoiceInput } from "@kason/shared";
import { createCharge } from "../billing/billing.repository";
import { issueDocumentTx } from "./issue.service";
import { dashboardCache } from "../../lib/cache";

type Session = { orgId: string; userId: string; role: string };

function chargeNumber(seq: number): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `MINV-${ymd}-${rand}-${seq}`;
}

/**
 * R11: manual invoice create. Mints ONE posted Charge + issues ONE category-routed
 * BillingDocument (invoice/debit_note) per line, all in a single transaction.
 * counterparty + docType are DERIVED from each line's ChargeCategory.family/docType
 * (mirrors issueDocumentsForChargesTx). No "record payment" here — create + view only.
 */
export async function createManualInvoiceService(
  session: Session,
  input: ManualInvoiceInput,
): Promise<
  | { ok: true; data: { documents: { id: string; documentNumber: string }[]; chargeIds: string[] } }
  | { ok: false; status: 400 | 404 | 409; error: string }
> {
  const billingMonthDate = new Date(`${input.billingMonth}-01T00:00:00.000Z`);
  try {
    const result = await getDb().$transaction(async (tx) => {
      const documents: { id: string; documentNumber: string }[] = [];
      const chargeIds: string[] = [];
      let seq = 0;
      for (const line of input.lines) {
        const category = await tx.chargeCategory.findFirst({
          where: { organizationId: session.orgId, id: line.categoryId },
          select: { id: true, active: true, code: true, family: true, docType: true, defaultSstRate: true },
        });
        if (!category) throw new ManualInvoiceError(400, "CATEGORY_NOT_FOUND");
        if (!category.active) throw new ManualInvoiceError(400, "CATEGORY_INACTIVE");

        const amountNum = Number(line.amount);
        if (!Number.isFinite(amountNum) || amountNum <= 0) throw new ManualInvoiceError(400, "AMOUNT_INVALID");

        const cn = chargeNumber(seq++);
        const charge = await createCharge(
          {
            organizationId: session.orgId,
            chargeNumber: cn,
            partyId: input.partyId,
            chargeType: category.code,
            categoryId: category.id,
            description: line.description,
            dueDate: billingMonthDate,
            billingMonth: billingMonthDate,
            amount: amountNum,
            currency: "MYR",
          },
          tx,
        );
        // Post the charge so the document represents a live receivable (mirrors
        // postChargeService's status flip; outstanding already = amount).
        await tx.charge.update({ where: { id: charge.id }, data: { status: "posted", postedAt: new Date() } });
        chargeIds.push(charge.id);

        const doc = await issueDocumentTx(tx, {
          organizationId: session.orgId,
          docType: category.docType as "invoice" | "debit_note",
          counterpartyType: category.family === "owner_income" ? "owner" : "tenant",
          partyId: input.partyId,
          apartmentId: input.apartmentId,
          billingMonth: `${input.billingMonth}-01`,
          idempotencyKey: `manual-inv:${cn}`,
          lines: [
            {
              chargeId: charge.id,
              categoryId: category.id,
              description: line.description,
              amount: line.amount,
              sstRate: category.defaultSstRate.toString(),
            },
          ],
          actorUserId: session.userId,
        });
        documents.push(doc);
      }
      return { documents, chargeIds };
    });
    dashboardCache.invalidate(`dashboard:${session.orgId}`);
    return { ok: true as const, data: result };
  } catch (err) {
    if (err instanceof ManualInvoiceError) return { ok: false as const, status: err.status, error: err.code };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false as const, status: 409, error: "CHARGE_NUMBER_CONFLICT" };
    }
    throw err;
  }
}

class ManualInvoiceError extends Error {
  constructor(public status: 400 | 404, public code: string) {
    super(code);
    this.name = "ManualInvoiceError";
  }
}
