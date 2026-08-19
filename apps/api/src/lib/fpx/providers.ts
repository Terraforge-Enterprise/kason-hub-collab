/**
 * Every provider id an FPX payment row may carry in `Payment.provider`.
 *
 * Creation stamps the ACTIVE gateway's id (`getFpxGateway().provider`), but
 * every lookup — callback resolve, admin in-flight list/cancel, stale-expiry
 * GC — filters `provider IN` this list, so flipping FPX_PROVIDER never
 * orphans in-flight rows minted by the previous provider. Cross-provider
 * `providerTxnId` collision is impossible: every mint is a fresh random UUID.
 */
export const FPX_PROVIDER_IDS = ["fpx-mock", "molpay"] as const;

export type FpxProviderId = (typeof FPX_PROVIDER_IDS)[number];

export function isFpxProviderId(v: string | null | undefined): v is FpxProviderId {
  return typeof v === "string" && (FPX_PROVIDER_IDS as readonly string[]).includes(v);
}
