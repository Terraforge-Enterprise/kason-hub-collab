import { z } from "zod";

// --- Input schemas ---

// Login validates presence only — strength enforcement belongs on grant /
// change-password (which require min(6)). min(5) is a cheap "obviously not a
// real password" filter: any real account password is ≥6, so anything ≤5 is
// a typo or empty-ish submit not worth running through bcrypt.
export const portalLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(5),
});

export const paymentSubmissionSchema = z.object({
  amount: z.coerce.number().positive().max(10_000_000, "Amount exceeds maximum"),
  paymentMethod: z.enum(["fpx", "bank_transfer", "cash"]),
  referenceNumber: z.string().min(1, "Reference number is required").max(100),
  notes: z.string().max(500).optional(),
});

// Storage keys for the tenant's transfer slip, minted by
// POST /portal-api/payments/slip-upload-url. The browser uploads straight to
// Supabase against a signed URL, then submits the keys here.
//
// ⚠️ Presence is all this validates. The key's PREFIX (which org, which party)
// is authorization, not shape, and is re-checked server-side against the
// session in submitMultiPaymentService — never trust a client-supplied storage
// path.
const slipAttachmentKeySchema = z.string().min(1).max(300);

/**
 * Ceiling on allocations in one basket.
 *
 * Was 50, to match `paginationSchema`'s max page size of 50 payable rows — one
 * allocation per row. It is 100 now because a single DISPLAY row can settle TWO
 * charges: `foldPayableTaxSiblings` folds an SST sibling into the base it taxes, so
 * the RM 0.54 row the tenant ticks submits RM 0.50 against the base and RM 0.04
 * against the sibling. A full page of 50 SST-bearing rows is therefore 100
 * allocations, and at the old cap the tenant's whole basket 400'd at the worst
 * possible moment. The bound on what a tenant can select is still 50 rows.
 */
const MAX_BASKET_ALLOCATIONS = 100;

export const portalPaySchema = z.object({
  idempotencyKey: z.string().uuid(),
  paymentMethod: z.enum(["fpx", "bank_transfer", "cash"]),
  referenceNumber: z.string().min(1, "Reference number is required").max(100),
  notes: z.string().max(500).optional(),
  attachmentKeys: z.array(slipAttachmentKeySchema).max(5).optional(),
  allocations: z.array(z.object({
    chargeId: z.string().uuid(),
    allocatedAmount: z.string().min(1).regex(/^\d+(\.\d{1,2})?$/, "Amount must be a number with up to 2 decimals"),
    prorateRatio: z.string().optional(),
  })).min(1).max(MAX_BASKET_ALLOCATIONS),
}).superRefine((val, ctx) => {
  // A slip is the WHOLE point of the non-FPX path: nothing else tells the org
  // the money moved, so an admin has no artifact to verify against. FPX is
  // exempt because the gateway callback — not a human reading a JPEG — is what
  // reconciles it, and the FPX basket never carries an attachment.
  if (val.paymentMethod === "fpx") return;
  if (!val.attachmentKeys || val.attachmentKeys.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attachmentKeys"],
      message: "Attach the transfer slip so we can verify this payment.",
    });
  }
});

// FPX initiate: the tenant kicks off an online-banking payment for a basket of
// charges. Unlike portalPaySchema there is no paymentMethod (always fpx), no
// referenceNumber and no notes — the gateway owns the bank reference, and the
// callback (not the tenant) reconciles. Same allocation shape as the manual pay.
export const fpxInitiateSchema = z.object({
  idempotencyKey: z.string().uuid(),
  allocations: z.array(z.object({
    chargeId: z.string().uuid(),
    allocatedAmount: z.string().min(1).regex(/^\d+(\.\d{1,2})?$/, "Amount must be a number with up to 2 decimals"),
    prorateRatio: z.string().optional(),
  })).min(1).max(MAX_BASKET_ALLOCATIONS),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// --- Response schemas ---

export const portalDashboardResponseSchema = z.object({
  tenant: z.object({ displayName: z.string(), partyType: z.string() }),
  lease: z.object({
    tenancyCode: z.string(),
    unitCode: z.string(),
    propertyName: z.string(),
    startDate: z.string(),
    endDate: z.string().nullable(),
    monthlyRentAmount: z.number(),
    status: z.string(),
  }).nullable(),
  upcomingCharges: z.array(z.object({
    id: z.string(),
    chargeNumber: z.string(),
    chargeType: z.string(),
    /** ORIGINAL charge amount — pre-CN/DN. Display surfaces must not present
     * this as what is owed: `netBalance` below is Σ outstandingAmount, so a
     * feed row showing `amount` disagrees with the headline the moment a
     * credit/debit note lands on the charge. */
    amount: z.number(),
    debitNoteTotal: z.number(),
    creditNoteTotal: z.number(),
    /** amount + debit notes − credit notes (same basis as the charges list). */
    adjustedAmount: z.number(),
    /** What is still owed on this row — the figure that foots with netBalance. */
    outstandingAmount: z.number(),
    dueDate: z.string(),
    status: z.string(),
  })),
  recentPayments: z.array(z.object({
    id: z.string(),
    paymentNumber: z.string(),
    amount: z.number(),
    status: z.string(),
    receivedAt: z.string(),
  })),
  announcements: z.array(z.object({
    id: z.string(),
    title: z.string(),
    message: z.string(),
    type: z.string(),
    createdAt: z.string(),
  })),
  /**
   * Things the tenant has to DO — the exception list behind Home's "Needs your
   * attention" section. Deliberately not a ledger: Home used to render a merged
   * charge+payment feed that was a truncated copy of the Billing tab (5 of each,
   * no "showing N of M"), so a tenant with 7 rows saw 6 and was told nothing.
   * Billing owns the complete, paginated lists; Home owns what is unresolved.
   */
  attention: z.object({
    /**
     * Self-submitted transfer slips the office has not verified yet. Home
     * previously rendered EVERY payment with a hardcoded emerald "Paid" badge,
     * so an unverified slip read as money received — the exact claim the
     * verification flow exists to withhold.
     */
    pendingVerificationPayments: z.array(z.object({
      id: z.string(),
      paymentNumber: z.string(),
      amount: z.number(),
      submittedAt: z.string(),
    })),
    /** Refused slips, carrying the office's reason so the tenant can act on it. */
    rejectedPayments: z.array(z.object({
      id: z.string(),
      paymentNumber: z.string(),
      amount: z.number(),
      rejectionReason: z.string().nullable(),
      submittedAt: z.string(),
    })),
    /**
     * Both arrays above are capped server-side (ATTENTION_ROW_CAP). Rejected
     * payments are never cleaned up and never block a retry, so the list grows
     * without bound; rendering all of it would repeat the unbounded-render bug
     * this section replaced. True when rows were withheld — the UI MUST say so
     * and point at Billing → Payments rather than drop them silently.
     */
    hasMoreUnresolvedPayments: z.boolean(),
  }),
  balance: z.object({
    totalCharges: z.number(),
    totalPayments: z.number(),
    totalCredits: z.number(),
    /** Σ outstandingAmount over TENANT-VISIBLE charges (draft/void excluded). */
    netBalance: z.number(),
    /**
     * Σ outstandingAmount over tenant-visible charges already PAST their due
     * date, and how many there are. Server-side for the same reason
     * `unpaidCount` is: the Billing page used to derive its Overdue card by
     * filtering `/charges?page=1&limit=20` in the browser, so a tenant with
     * more than 20 charges was shown a short overdue total. One authoritative
     * figure, read by both Home and Billing.
     */
    overdueAmount: z.number(),
    overdueCount: z.number(),
    /**
     * How many tenant-visible charges still carry outstanding > 0. Server-side
     * on purpose: the UI used to count `upcomingCharges`, which is capped at 5,
     * so any tenant with more than 5 unpaid items was shown "5 unpaid item(s)".
     */
    unpaidCount: z.number(),
    /**
     * Unspent credit the tenant holds — Σ over their credit notes of
     * (creditAmount − applied). Money owed TO them, not a reduction of what is
     * currently due, so it is deliberately NOT netted into `netBalance`: it comes
     * off future bills as those are posted.
     *
     * `totalCredits` above is the complement — credit already APPLIED. The two
     * must not be conflated: applied credit has settled a charge, available
     * credit has not yet settled anything.
     */
    creditAvailable: z.number(),
    currency: z.string(),
  }),
});

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    data: z.array(itemSchema),
    pagination: z.object({
      page: z.number(),
      limit: z.number(),
      total: z.number(),
      totalPages: z.number(),
    }),
  });

// --- Owner portal response schemas ---

export const portalOwnerDashboardResponseSchema = z.object({
  propertyCount: z.number(),
  totalRentalIncome: z.number(),
  totalMaintenanceSpend: z.number(),
  occupancy: z.object({
    occupied: z.number(),
    total: z.number(),
    rate: z.number(),
  }),
  recentTransactions: z.array(z.object({
    id: z.string(),
    tenantName: z.string(),
    amount: z.number(),
    receivedAt: z.string(),
  })),
  properties: z.array(z.object({
    id: z.string(),
    name: z.string(),
    unitCount: z.number(),
    occupiedCount: z.number(),
  })),
});

export type PortalOwnerDashboardResponse = z.infer<typeof portalOwnerDashboardResponseSchema>;

// Inferred types for frontend consumption
export type PortalLoginInput = z.infer<typeof portalLoginSchema>;
export type PaymentSubmissionInput = z.infer<typeof paymentSubmissionSchema>;
export type PortalPayInput = z.infer<typeof portalPaySchema>;
export type FpxInitiateInput = z.infer<typeof fpxInitiateSchema>;
export type PortalDashboardResponse = z.infer<typeof portalDashboardResponseSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;
