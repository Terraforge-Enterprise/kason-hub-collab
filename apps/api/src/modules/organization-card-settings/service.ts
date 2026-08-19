import { getDb } from "@kason/db";
import { REQUIRED_FOR_CONFIGURED, type UpdateOrgCardSettingsInput } from "./validation";

export async function getOrgCardSettings(organizationId: string) {
  const db = getDb();
  // Lazy-create the default row if it doesn't exist yet. All fields are
  // nullable or schema-defaulted, so a bare upsert produces a valid row
  // that the admin can then fill in via the Card Settings page. This
  // eliminates the seed-coupling that caused 500s when an org was created
  // without an explicit settings row.
  return db.organizationCardSettings.upsert({
    where: { organizationId },
    create: { organizationId },
    update: {},
  });
}

export async function updateOrgCardSettings(
  organizationId: string,
  input: UpdateOrgCardSettingsInput,
) {
  const db = getDb();
  const existing = await getOrgCardSettings(organizationId);

  // Compute the post-update view of the row so we can decide whether the
  // isConfigured gate flips. `input` may contain explicit `null` (caller
  // wants to clear a field) — `??` would treat that as "missing" and fall
  // through to the existing value, which is wrong. Use `in`/spread instead.
  const merged = { ...existing, ...input };

  const allRequiredFilled = REQUIRED_FOR_CONFIGURED.every((key) => {
    const value = merged[key];
    return typeof value === "string" && value.trim() !== "";
  });

  return db.organizationCardSettings.update({
    where: { organizationId },
    data: {
      ...input,
      isConfigured: allRequiredFilled,
    },
  });
}
