// Unified admin source queue — returns pending agent-sourced submissions
// from BOTH SalesUnit and UnitSubmission/PropertySubmission in one payload.
// Replaces the per-entity queue endpoints in the admin UI navigation.
//
// Spec: docs/superpowers/specs/2026-04-29-unified-property-sourcing-design.md §5.2
// Updated 2026-05-19 for three-table refactor: pending Units now live in
// UnitSubmission (not Unit.sourcingApproved=false), and pending properties
// live in PropertySubmission (not Property.sourcingApproved=false). The
// admin mutation routes for the UnitSubmission lifecycle live in this
// module (next to the list GETs) — the submission service module ships
// the business logic; this file exposes the HTTP surface.

import { Hono } from "hono";
import { getDb } from "@kason/db";
import type { SessionPayload } from "../../lib/auth";
import { requireRole } from "../../middleware/require-role";
import { listPendingUnitSubmissions } from "../submissions/submission.repository";
import {
  approveSubmissionService,
  rejectSubmissionService,
  setSubmissionNeedsAmendmentService,
} from "../submissions/submission.service";
import {
  approvePropertySubmissionService,
  rejectPropertySubmissionService,
  setPropertySubmissionNeedsAmendmentService,
} from "../submissions/property-submission.service";
import { listSalesUnits } from "../sales/sales.repository";

const sourceQueueRoutes = new Hono<{
  Variables: { session: SessionPayload };
}>();

sourceQueueRoutes.use("*", requireRole("manager"));

sourceQueueRoutes.get("/", async (c) => {
  const session = c.get("session");
  const db = getDb();

  const [salesUnits, units, properties] = await Promise.all([
    listSalesUnits(session.orgId, { sourcingApproved: false }),
    // Pending unit submissions — both first-time (pending) and amendment
    // requests (needs_amendment) appear in the admin queue.
    listPendingUnitSubmissions(session.orgId),
    // Pending property submissions are surfaced inline here to keep the
    // queue payload self-contained — the dedicated property-sourcing
    // service module was removed in the three-table refactor.
    db.propertySubmission.findMany({
      where: {
        organizationId: session.orgId,
        submissionState: { in: ["pending", "needs_amendment"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        propertyCode: true,
        proposedName: true,
        propertyType: true,
        submissionState: true,
        amendmentNote: true,
        sourcingAgentId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return c.json({ data: { salesUnits, units, properties } });
});

// Dedicated UnitSubmission list — returns the same rows as the unified
// queue's `units` slice, but as a flat array. Used by web clients that
// already worked off a list-shaped endpoint pre-refactor.
sourceQueueRoutes.get("/unit-submissions", async (c) => {
  const session = c.get("session");
  const data = await listPendingUnitSubmissions(session.orgId);
  return c.json({ data });
});

// PropertySubmission list — same projection as the unified queue's
// `properties` slice, but as a flat array.
sourceQueueRoutes.get("/property-submissions", async (c) => {
  const session = c.get("session");
  const db = getDb();
  const data = await db.propertySubmission.findMany({
    where: {
      organizationId: session.orgId,
      submissionState: { in: ["pending", "needs_amendment"] },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      propertyCode: true,
      proposedName: true,
      propertyType: true,
      submissionState: true,
      amendmentNote: true,
      sourcingAgentId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return c.json({ data });
});

// Approve a UnitSubmission — publishes it to a real Listing (or merges an
// amendment into the parent Listing) inside one transaction.
sourceQueueRoutes.post("/unit-submissions/:id/approve", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await approveSubmissionService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Reject a UnitSubmission — terminal. `note` is optional but persisted on
// the row + the audit diff for the agent's reference.
sourceQueueRoutes.post("/unit-submissions/:id/reject", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req
    .json<{ note?: string }>()
    .catch(() => ({}) as { note?: string });
  const result = await rejectSubmissionService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
    body.note ?? "",
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Send a UnitSubmission back to the agent for amendment — non-terminal,
// the agent can re-submit after fixing per the admin's notes.
sourceQueueRoutes.post("/unit-submissions/:id/needs-amendment", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req
    .json<{ note?: string }>()
    .catch(() => ({}) as { note?: string });
  const result = await setSubmissionNeedsAmendmentService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
    body.note ?? "",
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Approve a PropertySubmission — creates a real Property row + cascades to
// child UnitSubmissions in one transaction. Restored in 2026-05-21 (the
// post-C-series Phase-C follow-up that the three-table refactor punted on).
sourceQueueRoutes.post("/property-submissions/:id/approve", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const result = await approvePropertySubmissionService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Reject a PropertySubmission — terminal.
sourceQueueRoutes.post("/property-submissions/:id/reject", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req
    .json<{ note?: string }>()
    .catch(() => ({}) as { note?: string });
  const result = await rejectPropertySubmissionService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
    body.note ?? "",
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Send a PropertySubmission back for amendment — non-terminal.
sourceQueueRoutes.post("/property-submissions/:id/needs-amendment", async (c) => {
  const session = c.get("session");
  const id = c.req.param("id");
  const body = await c.req
    .json<{ note?: string }>()
    .catch(() => ({}) as { note?: string });
  const result = await setPropertySubmissionNeedsAmendmentService(
    {
      orgId: session.orgId,
      userId: session.userId,
      partyId: session.partyId,
      actorRole: session.role,
    },
    id,
    body.note ?? "",
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status as 404 | 409);
  }
  return c.json({ data: result.data }, result.status as 200);
});

// Pending-changes feed — Listings with a staged amendment awaiting merge/
// reject now live as UnitSubmission rows with parentListingId IS NOT NULL
// (the pre-refactor "pendingChanges JSON on Listing" model has been
// retired). This endpoint returns those amendment-style submissions.
sourceQueueRoutes.get("/pending-changes", async (c) => {
  const session = c.get("session");
  const db = getDb();
  const data = await db.unitSubmission.findMany({
    where: {
      organizationId: session.orgId,
      submissionState: { in: ["pending", "needs_amendment"] },
      parentListingId: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      unitCode: true,
      listingType: true,
      submissionState: true,
      amendmentNote: true,
      parentListingId: true,
      sourcingAgentId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return c.json({ data });
});

export { sourceQueueRoutes };
