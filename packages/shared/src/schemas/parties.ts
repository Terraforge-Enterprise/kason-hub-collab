import { z } from "zod";
import { optionalPhoneSchema } from "./phone";

export const createOwnerSchema = z.object({
  displayName: z.string().min(1),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  primaryPhone: optionalPhoneSchema,
  idType: z.string().optional(),
  idNumber: z.string().optional(),
  nationality: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  whatsappPhone: z.string().optional(),
  gender: z.string().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  occupation: z.string().optional(),
  employerName: z.string().optional(),
  employerAddress: z.string().optional(),
  monthlyIncome: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  emergencyContactRelation: z.string().optional(),
});

export const updateOwnerSchema = z.object({
  partyId: z.string().uuid(),
  displayName: z.string().min(1).optional(),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  // .optional() preserves PATCH "omit-key = leave alone" semantics. Without
  // it, optionalPhoneSchema's preprocess turns a missing key into `null`,
  // which the service's `!== undefined` check would then write to the DB —
  // silently wiping the existing phone on every update that omits the key.
  primaryPhone: optionalPhoneSchema.optional(),
  idType: z.string().optional(),
  idNumber: z.string().optional(),
  nationality: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  whatsappPhone: z.string().optional(),
  gender: z.string().optional(),
  // .or(z.literal("")) lets the edit dialog send "" to clear dateOfBirth; the
  // service coerces "" → null on write (see updateOwnerService). Without it,
  // .optional() admits only `undefined`, so the edit form's blank DOB ("")
  // would 400 on every owner edit that leaves date-of-birth empty.
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().or(z.literal("")),
  occupation: z.string().optional(),
  employerName: z.string().optional(),
  employerAddress: z.string().optional(),
  // .or(z.literal("")) lets the edit dialog send "" to clear monthlyIncome; the
  // backend coerces "" → null on write — see updateTenantSchema.
  monthlyIncome: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").optional().or(z.literal("")),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  emergencyContactRelation: z.string().optional(),
});

export const blacklistOwnerSchema = z.object({
  partyId: z.string().uuid(),
  reason: z.string().min(3),
});

export const createTenantSchema = z.object({
  displayName: z.string().min(1),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  primaryPhone: optionalPhoneSchema,
  idType: z.string().optional(),
  idNumber: z.string().optional(),
  nationality: z.string().optional(),
  occupation: z.string().optional(),
  employerName: z.string().optional(),
  employerAddress: z.string().optional(),
  monthlyIncome: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").optional(),
  whatsappPhone: z.string().optional(),
  gender: z.string().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  emergencyContactRelation: z.string().optional(),
  // When creating a tenant FROM a signed reservation (admin picker), the new
  // Party is race-safely linked to the reservation in the same transaction
  // as the create — see createTenantService. Absent = today's behaviour
  // (created, unlinked).
  reservationId: z.string().uuid().optional(),
});

export const updateTenantSchema = z.object({
  partyId: z.string().uuid(),
  displayName: z.string().min(1).optional(),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  // .optional() preserves PATCH "omit-key = leave alone" — see updateOwnerSchema.
  primaryPhone: optionalPhoneSchema.optional(),
  idType: z.string().optional(),
  idNumber: z.string().optional(),
  nationality: z.string().optional(),
  occupation: z.string().optional(),
  employerName: z.string().optional(),
  employerAddress: z.string().optional(),
  // .or(z.literal("")) lets the edit dialog send "" to clear monthlyIncome; the
  // backend coerces "" → null on write (six-ux #1). Plain string fields already accept "".
  monthlyIncome: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount").optional().or(z.literal("")),
  whatsappPhone: z.string().optional(),
  gender: z.string().optional(),
  // .or(z.literal("")) lets the edit dialog send "" to clear dateOfBirth; the
  // service coerces "" → null on write (see updateTenantService). Without it,
  // .optional() admits only `undefined`, so the edit form's blank DOB ("")
  // would 400 on every tenant edit that leaves date-of-birth empty.
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD").optional().or(z.literal("")),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  emergencyContactRelation: z.string().optional(),
});

export const blacklistTenantSchema = z.object({
  partyId: z.string().uuid(),
  reason: z.string().min(3),
});

export const reactivateTenantSchema = z.object({
  partyId: z.string().uuid(),
  note: z.string().max(500).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const reactivateOwnerSchema = z.object({
  partyId: z.string().uuid(),
  note: z.string().max(500).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const createAgentSchema = z.object({
  displayName: z.string().min(1),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  primaryPhone: optionalPhoneSchema,
  idType: z.string().optional(),
  idNumber: z.string().optional(),
  nationality: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  agentLevel: z.enum(["new_agent", "pre_leader", "leader"]).optional(),
  // Optional E-Namecard job title. When supplied (and the org's
  // OrganizationCardSettings.isConfigured = true), agent creation will
  // also mint an approved AgentCardVersion in the same transaction —
  // see apps/api parties.service + agent-cards.service. Per spec §6.1,
  // §7.1.
  title: z.string().min(1).max(100).optional(),
});

export const updateAgentSchema = z.object({
  partyId: z.string().uuid(),
  updatedAt: z.string().datetime(),
  displayName: z.string().min(1).optional(),
  legalName: z.string().optional(),
  primaryEmail: z.string().email().optional().or(z.literal("")),
  // .optional() preserves PATCH "omit-key = leave alone" — see updateOwnerSchema.
  primaryPhone: optionalPhoneSchema.optional(),
  nationality: z.string().optional(),
  bankName: z.string().optional(),
  bankAccountHolder: z.string().optional(),
  bankAccountNumber: z.string().optional(),
  agentLevel: z.enum(["new_agent", "pre_leader", "leader"]).optional(),
  uplineId: z.string().uuid().nullable().optional(),
});

export const blacklistAgentSchema = z.object({
  partyId: z.string().uuid(),
  updatedAt: z.string().datetime(),
  reason: z.string().min(3),
});

export const reactivateAgentSchema = z.object({
  partyId: z.string().uuid(),
  note: z.string().min(10).max(500),
  updatedAt: z.string().datetime(),
});

export const deactivateAgentSchema = z.object({
  partyId: z.string().uuid(),
  note: z.string().min(10).max(500),
  updatedAt: z.string().datetime(),
});

export const activateAgentSchema = z.object({
  partyId: z.string().uuid(),
  note: z.string().min(10).max(500),
  updatedAt: z.string().datetime(),
});

export const revokePortalAccessSchema = z.object({
  partyId: z.string().uuid(),
  updatedAt: z.string().datetime(),
});

export const setPartyStatusSchema = z.object({
  partyId: z.string().uuid(),
  status: z.enum(["active", "inactive"]),
});
