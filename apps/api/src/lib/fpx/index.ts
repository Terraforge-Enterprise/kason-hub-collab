import type { FpxGateway } from "./gateway";
import { MockFpxGateway } from "./mock-gateway";
import { MolpayFpxGateway } from "./molpay-gateway";

export type {
  FpxGateway,
  FpxInitiateRequest,
  FpxInitiateResult,
  FpxCallbackResult,
  FpxPayerInfo,
} from "./gateway";
export { MockFpxGateway } from "./mock-gateway";
export { MolpayFpxGateway } from "./molpay-gateway";
export { FPX_PROVIDER_IDS, isFpxProviderId } from "./providers";
export type { FpxProviderId } from "./providers";

let cached: FpxGateway | null = null;

/**
 * Returns the configured FpxGateway. Selection by env:
 * - FPX_PROVIDER=mock → MockFpxGateway
 * - FPX_PROVIDER=molpay → MolpayFpxGateway (Fiuu/ex-MOLPay; throws here when
 *   its MOLPAY_* env is incomplete — fail at selection, not mid-initiate)
 * - FPX_PROVIDER unset, non-production → MockFpxGateway (dev/CI default)
 * - FPX_PROVIDER unset, production → throws (refuse to silently mock real
 *   payments — a prod deploy must choose its provider explicitly)
 * - any other value → throws until that adapter exists
 *
 * The result is memoized for the process lifetime. Tests should call
 * `resetFpxGateway()` between cases when needed.
 */
export function getFpxGateway(): FpxGateway {
  if (cached) return cached;
  const provider = process.env.FPX_PROVIDER;
  if (provider === "mock") {
    cached = new MockFpxGateway();
  } else if (provider === "molpay") {
    cached = new MolpayFpxGateway();
  } else if (!provider) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "FPX_PROVIDER is not set. Refusing to default to the mock gateway in " +
          "production — set FPX_PROVIDER explicitly.",
      );
    }
    cached = new MockFpxGateway();
  } else {
    throw new Error(
      `FPX_PROVIDER="${provider}" has no adapter configured yet. Only "mock" and "molpay" are available.`,
    );
  }
  return cached;
}

export function resetFpxGateway(): void {
  cached = null;
}
