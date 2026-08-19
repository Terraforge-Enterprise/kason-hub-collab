export {
  createOwnerSchema,
  updateOwnerSchema,
  blacklistOwnerSchema,
  reactivateOwnerSchema,
  createTenantSchema,
  updateTenantSchema,
  blacklistTenantSchema,
  reactivateTenantSchema,
  createAgentSchema,
  updateAgentSchema,
  blacklistAgentSchema,
  reactivateAgentSchema,
  deactivateAgentSchema,
  activateAgentSchema,
  revokePortalAccessSchema,
  setPartyStatusSchema,
} from "@kason/shared";

import { z } from "zod";

export const resetPortalPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});
