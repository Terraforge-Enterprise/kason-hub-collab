// packages/shared/src/constants/phase2-status-tones.ts
export type StatusTone = "slate" | "sky" | "emerald" | "amber" | "rose";

/**
 * Central StatusPill tone map for every Phase-2 status (foundation §3).
 * Scoped per entity — the same word can tone differently (Payment.void=slate
 * per M3 skill; Invoice.void=rose per M5 skill). Sources: M2/M3/M5/M6 skills;
 * task/ticket follow the same semantics (sky=new, amber=in-flight,
 * emerald=done-good, rose=failed, slate=neutral/terminal-quiet) and M7 may
 * adjust its own entries with /frontend on its branch.
 */
export const PHASE2_STATUS_TONES = {
  invoice: { draft: "slate", approved: "sky", sent: "amber", paid: "emerald", partial: "amber", void: "rose" },
  payment: { pending_approval: "amber", posted: "emerald", void: "slate", refunded: "rose" },
  charge: { draft: "slate", posted: "sky", pending: "amber", partial: "amber", partially_paid: "amber", paid: "emerald", overdue: "rose", void: "slate" },
  meterReading: { submitted: "sky", charged: "emerald", void: "rose" },
  meter: { active: "emerald", retired: "slate" },
  unitUtilityBill: { draft: "slate", charged: "emerald", void: "rose" },
  task: { pool: "slate", todo: "sky", in_progress: "amber", done: "emerald", archived: "slate" },
  sprint: { planned: "sky", active: "emerald", completed: "slate" },
  ticket: { open: "sky", in_progress: "amber", resolved: "emerald", void: "slate" },
  draftRun: { running: "sky", completed: "emerald", failed: "rose" },
  // M1 tenant-tracker (plan Step 10): ended/terminated are neutral lifecycle
  // states, not errors — slate, never rose (rose = void/overdue/failure).
  tenancy: { active: "emerald", ended: "slate", terminated: "slate" },
  pic: { unassigned: "slate", assigned: "sky" },
  // Bills & Expenses Grid (standalone store). void=slate matches payment/charge/ticket
  // void — a removed expense line is a neutral removal, never a failure (rose).
  // locked=sky mirrors charge.posted: complete, non-terminal.
  billsGridEntry: { unpaid: "slate", pending: "amber", partial: "amber", paid: "emerald", draft: "slate", locked: "sky" },
  billsGridExpense: { active: "emerald", void: "slate" },
} as const satisfies Record<string, Record<string, StatusTone>>;
