#!/usr/bin/env node
/**
 * Fiuu (Razer Merchant Services) full/partial refund — one transaction per run.
 *
 *   Docs: https://docs.fiuu.dev/reference/advanced-fullpartial-refund
 *   POST  https://api.fiuu.com/RMS/API/refundAPI/index.php
 *
 * THIS MOVES REAL MONEY. Dry-run is the default and prints the exact payload
 * without sending it. Nothing leaves this machine until you pass --execute.
 *
 * CREDENTIALS — never passed on the command line (they would land in shell
 * history and in this session's transcript). Put them in the repo-root .env:
 *
 *   MOLPAY_MERCHANT_ID=...
 *   MOLPAY_SECRET_KEY=...        # the SECRET key, NOT the verify key
 *
 * The verify key signs outgoing *payment* requests; refunds are signed with the
 * secret key. Using the wrong one returns a signature error, not a refund.
 *
 * FPX CAVEAT: online-banking refunds are not automatic the way card refunds
 * are. Fiuu needs somewhere to send the money, so BankCode, BeneficiaryName and
 * BeneficiaryAccNo are required for FPX. You need the payer's bank account
 * number — the transaction report only gives you their account NAME.
 *
 * VOID vs REFUND: an FPX transaction can be voided in the merchant portal on
 * the SAME DAY only. A void is instant, free, and needs no beneficiary details.
 * Always check whether a void is still possible before reaching for this script.
 *
 * Usage:
 *   node scripts/fiuu-refund.mjs --txn 3937845227 --amount 4.00 --ref KAEN-RF-001 \
 *     --bank-code UOB0229 --beneficiary-name "TAN YONG HONG" --beneficiary-acc 1234567890
 *   # add --execute to actually send it
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.fiuu.com/RMS/API/refundAPI/index.php";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

/** Minimal .env reader — avoids a dependency and never logs values. */
function loadEnv() {
  for (const file of [".env", ".env.local"]) {
    let raw;
    try {
      raw = readFileSync(resolve(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (process.env[k] === undefined) {
        process.env[k] = v.trim().replace(/^["']|["']$/g, "");
      }
    }
  }
}

function parseArgs(argv) {
  const out = { execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") { out.execute = true; continue; }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
loadEnv();

const merchantId = process.env.MOLPAY_MERCHANT_ID;
const secretKey = process.env.MOLPAY_SECRET_KEY;

const missing = [
  !merchantId && "MOLPAY_MERCHANT_ID",
  !secretKey && "MOLPAY_SECRET_KEY",
  !args.txn && "--txn",
  !args.amount && "--amount",
  !args.ref && "--ref",
].filter(Boolean);

if (missing.length) {
  console.error(`\nMissing: ${missing.join(", ")}\n`);
  console.error("Credentials go in the repo-root .env (never on the command line):");
  console.error("  MOLPAY_MERCHANT_ID=...");
  console.error("  MOLPAY_SECRET_KEY=...   # SECRET key, not the verify key\n");
  process.exit(1);
}

// Fiuu expects n(10,2) — "4.00", never "4" or "4.0".
const amount = Number(args.amount).toFixed(2);
if (!Number.isFinite(Number(args.amount)) || Number(args.amount) <= 0) {
  console.error(`Invalid --amount: ${args.amount}`);
  process.exit(1);
}

// "P" (partial) with the full original amount is an unambiguous full refund and
// is the variant the docs spell out. Override with --refund-type if Fiuu's
// support tells you otherwise for a given channel.
const refundType = args.refundType ?? "P";

const signature = md5(`${refundType}${merchantId}${args.ref}${args.txn}${amount}${secretKey}`);

const payload = {
  RefundType: refundType,
  MerchantID: merchantId,
  RefID: args.ref,
  TxnID: args.txn,
  Amount: amount,
  Signature: signature,
};

// Conditional block for online banking (FPX). Fiuu has no card to credit back,
// so it needs an explicit destination account.
if (args.bankCode) payload.BankCode = args.bankCode;
if (args.beneficiaryName) payload.BeneficiaryName = args.beneficiaryName;
if (args.beneficiaryAcc) payload.BeneficiaryAccNo = args.beneficiaryAcc;
if (args.bankCode) payload.BankCountry = args.bankCountry ?? "MY";
// 0 = refund the MDR to the customer too (default); 1 = merchant keeps it.
if (args.mdrFlag) payload.mdr_flag = args.mdrFlag;
if (args.notifyUrl) payload.notify_url = args.notifyUrl;

const redacted = { ...payload, Signature: `${signature.slice(0, 8)}…` };
console.log("\n─── Fiuu refund request ─────────────────────────────");
console.log(`  Endpoint : ${ENDPOINT}`);
for (const [k, v] of Object.entries(redacted)) {
  console.log(`  ${k.padEnd(17)}: ${v}`);
}
console.log(`  Signature preimage: ${refundType}${merchantId}${args.ref}${args.txn}${amount}<SECRET_KEY>`);
console.log("─────────────────────────────────────────────────────\n");

if (args.bankCode === undefined) {
  console.log("⚠️  No --bank-code / beneficiary details supplied.");
  console.log("    FPX refunds normally require BankCode, BeneficiaryName and");
  console.log("    BeneficiaryAccNo. Expect a rejection without them.\n");
}

if (!args.execute) {
  console.log("DRY RUN — nothing sent. Re-run with --execute to submit.\n");
  process.exit(0);
}

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(payload).toString(),
});

const text = await res.text();
console.log(`HTTP ${res.status}`);
console.log(text);

let body;
try {
  body = JSON.parse(text);
} catch {
  console.error("\nResponse was not JSON — check the endpoint and credentials.");
  process.exit(1);
}

// Verify the response came from Fiuu and was not altered in transit.
if (body.Signature) {
  const expected = md5(
    `${body.RefundType}${body.MerchantID}${body.RefID}${body.RefundID}${body.TxnID}${body.Amount}${body.Status}${secretKey}`,
  );
  console.log(
    body.Signature === expected
      ? "\n✅ Response signature verified."
      : "\n❌ RESPONSE SIGNATURE MISMATCH — do not trust this response.",
  );
}

const STATUS = {
  "00": "SUCCESS — refund accepted.",
  "22": "PENDING — accepted, in progress. Expect 7–14 days to reach the payer.",
  "11": "REJECTED — see the reason field above.",
};
console.log(`\nStatus ${body.Status}: ${STATUS[body.Status] ?? "unknown status code"}`);
if (body.reason) console.log(`Reason: ${body.reason}`);
if (body.RefundID) console.log(`RefundID: ${body.RefundID} — keep this for reconciliation.`);
console.log();
