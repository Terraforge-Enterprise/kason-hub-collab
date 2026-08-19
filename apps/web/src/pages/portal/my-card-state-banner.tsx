/**
 * MyCardStateBanner — the five state-banner branches from spec §7.2.
 *
 * Extracted into its own component so /portal/my-card AND
 * /portal/dashboard (agent home) can render the SAME banner with
 * identical copy and CTAs. The agent home page mirrors the banner so
 * the agent sees pending / expiry / cap-reached / no-card prompts
 * without navigating.
 *
 * Banner-selection priority (only ONE renders at a time):
 *   1. No card yet         (no active, no pending)             — EmptyState
 *   2. Reconfirm cap reached (active, reconfirmCount === 4)     — Callout warning
 *   3. Pending submission exists                                — Callout info
 *   4. Last submission rejected (no pending, has active, latest history is rejected) — Callout danger
 *   5. Card expires within 30 days, reconfirmCount < 4          — Callout warning
 *
 * The cap-reached branch is checked BEFORE pending so a fresh post-cap
 * submission (the only escape from cap=4) doesn't briefly disappear the
 * cap-reached prompt while pending. Once approved, reconfirmCount
 * resets to 0 and the cap-reached banner stops rendering.
 */
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { IdCard } from "lucide-react";
import {
  daysUntilExpiry,
  isInReconfirmWindow,
  type MyCardData,
} from "@/api/portal-my-card";
import { formatDistanceFromNow } from "./my-card-utils";

interface Props {
  data: MyCardData;
  /**
   * Callback fired on each banner's primary CTA. The parent page wires
   * this to open the edit Sheet, fire the reconfirm mutation, etc.
   * Banners that have no action don't fire anything.
   */
  onAction: (action: "open-edit" | "reconfirm" | "withdraw") => void;
  reconfirming?: boolean;
  withdrawing?: boolean;
}

export function MyCardStateBanner({ data, onAction, reconfirming, withdrawing }: Props) {
  const { active, pending, history } = data;

  // 1. No card yet
  if (!active && !pending) {
    return (
      <EmptyState
        icon={IdCard}
        title="No e-namecard yet"
        description="Create your e-namecard to share a branded contact link with clients. Submissions go to your manager for approval."
      >
        <div className="mt-4">
          <Button variant="gold" onClick={() => onAction("open-edit")}>
            Set up my card
          </Button>
        </div>
      </EmptyState>
    );
  }

  // 2. Cap reached — checked BEFORE pending so the prompt persists during
  //    the post-cap re-approval submission window.
  if (active && active.reconfirmCount >= 4 && !pending) {
    return (
      <Callout variant="warning" title="Card requires re-approval">
        <p>
          Your card has been re-confirmed 4 times. Submit a fresh card for
          manager approval to continue.
        </p>
        <div className="mt-3">
          <Button variant="gold" onClick={() => onAction("open-edit")}>
            Submit for approval
          </Button>
        </div>
      </Callout>
    );
  }

  // 3. Pending submission exists
  if (pending) {
    return (
      <Callout variant="info" title="Pending review">
        <p>
          Submitted {formatDistanceFromNow(pending.createdAt)}.{" "}
          {active
            ? "Your public link still shows your last approved version."
            : "Your card will go live once a manager approves it."}
        </p>
        <div className="mt-3">
          <Button
            variant="ghost"
            onClick={() => onAction("withdraw")}
            disabled={withdrawing}
          >
            {withdrawing ? "Withdrawing…" : "Withdraw submission"}
          </Button>
        </div>
      </Callout>
    );
  }

  // 4. Last submission rejected (no newer pending, has active, last
  //    history entry was a rejection — and not a self-withdrawal).
  //    The newest history entry will be the rejected row because nothing
  //    newer was submitted.
  const newestHistory = history[0];
  const lastWasRejection =
    newestHistory &&
    newestHistory.status === "rejected" &&
    newestHistory.rejectionReason !== "Withdrawn by agent";
  if (active && lastWasRejection && newestHistory.id !== active.id) {
    return (
      <Callout variant="danger" title="Last submission rejected">
        <p>
          <em>"{newestHistory.rejectionReason ?? "No reason given"}"</em>
        </p>
        <div className="mt-3">
          <Button variant="outline" onClick={() => onAction("open-edit")}>
            Edit & re-submit
          </Button>
        </div>
      </Callout>
    );
  }

  // 5. Card expires soon, reconfirmCount < 4 — the reconfirm window.
  if (
    active &&
    isInReconfirmWindow(active.expiresAt) &&
    active.reconfirmCount < 4
  ) {
    const days = daysUntilExpiry(active.expiresAt);
    const dayLabel =
      days === null
        ? "soon"
        : days <= 0
          ? "today"
          : days === 1
            ? "in 1 day"
            : `in ${days} days`;
    return (
      <Callout variant="warning" title={`Card expires ${dayLabel}`}>
        <p>
          Re-confirm to extend by 3 months. Your public link will keep
          working.
        </p>
        <div className="mt-3">
          <Button
            variant="gold"
            onClick={() => onAction("reconfirm")}
            disabled={reconfirming}
          >
            {reconfirming ? "Re-confirming…" : "Re-confirm now"}
          </Button>
        </div>
      </Callout>
    );
  }

  // No banner — the agent has a healthy active card with plenty of time
  // before expiry. The page still renders the live card panel + stats.
  return null;
}
