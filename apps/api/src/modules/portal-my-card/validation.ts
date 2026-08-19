// Portal-side validation schemas for the agent's "My Card" surface.
//
// Per spec §6.2, the only mutating endpoint that takes a body is
// `POST /portal-api/my-card/submit`; reconfirm + withdraw are
// argument-less (they act on the agent's current pending/active row,
// derived from the session). Mirrors the four card-display fields on
// the AgentCardVersion snapshot model (spec §5).

import { z } from "zod";
import { optionalPhoneSchema } from "@kason/shared";

export const submitMyCardSchema = z.object({
  displayName: z.string().min(1).max(100),
  title: z.string().min(1).max(100),
  primaryEmail: z.string().email().max(254).optional().nullable(),
  primaryPhone: optionalPhoneSchema,
});

export type SubmitMyCardInput = z.infer<typeof submitMyCardSchema>;
