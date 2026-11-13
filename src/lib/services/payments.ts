import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentIntegrations, paymentRequests, savingsAccounts, loans } from "@/db/schema";
import { AppError, audit, newRef } from "@/lib/core";
import { detectNetwork, normalizeUgPhone } from "@/lib/format";
import { deposit, type Svc } from "@/lib/services/savings";
import { repayLoan } from "@/lib/services/loans";

/**
 * Mobile-money integration layer.
 *  - Adapters call the providers' documented REST APIs ONLY when credentials are present in env.
 *  - Without credentials every request stays "awaiting_confirmation" and must be verified manually by an officer
 *    against the provider statement. Nothing is ever marked successful without confirmation.
 *  - The adapters below are implemented from the public API docs and have NOT been exercised against live
 *    sandboxes in this repository; use "Test connection" in Payments after setting credentials.
 */
export type ProviderId = "mtn_momo" | "airtel_money";

export function providerEnv(p: ProviderId) {
  if (p === "mtn_momo") {
    const ok = !!(process.env.MTN_MOMO_SUBSCRIPTION_KEY && process.env.MTN_MOMO_API_USER && process.env.MTN_MOMO_API_KEY);
    return { configured: ok, env: process.env.MTN_MOMO_ENV ?? "sandbox", missing: ["MTN_MOMO_SUBSCRIPTION_KEY", "MTN_MOMO_API_USER", "MTN_MOMO_API_KEY"].filter((k) => !process.env[k]) };
  }
  const ok = !!(process.env.AIRTEL_CLIENT_ID && process.env.AIRTEL_CLIENT_SECRET);
  return { configured: ok, env: process.env.AIRTEL_ENV ?? "sandbox", missing: ["AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET"].filter((k) => !process.env[k]) };
}

const mtnBase = () => (process.env.MTN_MOMO_ENV === "production" ? "https://proxy.momoapi.mtn.com" : "https://sandbox.momodeveloper.mtn.com");
const airtelBase = () => (process.env.AIRTEL_ENV === "production" ? "https://openapi.airtel.africa" : "https://openapiuat.airtel.africa");

async function mtnToken() {
  const basic = Buffer.from(`${process.env.MTN_MOMO_API_USER}:${process.env.MTN_MOMO_API_KEY}`).toString("base64");
  const r = await fetch(`${mtnBase()}/collection/token/`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY! } });
  if (!r.ok) throw new Error(`MTN token request failed (HTTP ${r.status})`);
  return ((await r.json()) as { access_token: string }).access_token;
}
async function airtelToken() {
  const r = await fetch(`${airtelBase()}/auth/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: process.env.AIRTEL_CLIENT_ID, client_secret: process.env.AIRTEL_CLIENT_SECRET, grant_type: "client_credentials" }) });
  if (!r.ok) throw new Error(`Airtel token request failed (HTTP ${r.status})`);
  return ((await r.json()) as { access_token: string }).access_token;
}

export async function testConnection(svc: Svc, provider: ProviderId) {
  const cfg = providerEnv(provider);
  let result: string;
  if (!cfg.configured) result = `Not configured. Missing environment variables: ${cfg.missing.join(", ")}`;
  else {
    try { if (provider === "mtn_momo") await mtnToken(); else await airtelToken(); result = `OK: obtained access token from ${cfg.env} environment (authentication only; no payment was made)`; }
    catch (e) { result = `Failed: ${(e as Error).message}`; }
  }
  await db.update(paymentIntegrations).set({ lastTestedAt: new Date(), lastTestResult: result }).where(and(eq(paymentIntegrations.orgId, svc.orgId), eq(paymentIntegrations.provider, provider)));
  return result;
}

/** Creates a collection request. If provider credentials exist the request is pushed to the provider (status pending_provider). */
export async function requestCollection(svc: Svc, i: { provider: string; purpose: "deposit" | "loan_repayment"; memberId: string; accountId?: string; loanId?: string; amount: number; msisdn: string }) {
  const msisdn = normalizeUgPhone(i.msisdn);
  if (!msisdn) throw new AppError("Enter a valid Uganda mobile number");
  if (!Number.isInteger(i.amount) || i.amount < 500) throw new AppError("Amount must be at least UGX 500");
  if (["mtn_momo", "airtel_money"].includes(i.provider) && detectNetwork(msisdn) !== i.provider) throw new AppError(`That number does not look like an ${i.provider === "mtn_momo" ? "MTN" : "Airtel"} number`);
  if (i.purpose === "deposit" && !i.accountId) throw new AppError("Select a savings account");
  if (i.purpose === "loan_repayment" && !i.loanId) throw new AppError("Select a loan");
  const reference = newRef("PR");
  let status = "awaiting_confirmation", providerRef: string | null = null, raw: string | null = "Manual confirmation required: provider API not configured";
  const [integ] = await db.select().from(paymentIntegrations).where(and(eq(paymentIntegrations.orgId, svc.orgId), eq(paymentIntegrations.provider, i.provider)));
  if (integ && !integ.enabled) throw new AppError("This payment channel is disabled");
  if ((i.provider === "mtn_momo" || i.provider === "airtel_money") && integ?.mode !== "manual_only" && providerEnv(i.provider).configured) {
    try {
      if (i.provider === "mtn_momo") {
        const token = await mtnToken();
        providerRef = randomUUID();
        const r = await fetch(`${mtnBase()}/collection/v1_0/requesttopay`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "X-Reference-Id": providerRef, "X-Target-Environment": process.env.MTN_MOMO_ENV ?? "sandbox", "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY!, "Content-Type": "application/json" },
          body: JSON.stringify({ amount: String(i.amount), currency: process.env.MTN_MOMO_ENV === "production" ? "UGX" : "EUR", externalId: reference, payer: { partyIdType: "MSISDN", partyId: msisdn.slice(1) }, payerMessage: "Savings payment", payeeNote: reference }),
        });
        if (r.status !== 202) throw new Error(`MTN rejected the request (HTTP ${r.status})`);
      } else {
        const token = await airtelToken();
        providerRef = reference;
        const r = await fetch(`${airtelBase()}/merchant/v2/payments/`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Country": "UG", "X-Currency": "UGX" },
          body: JSON.stringify({ reference: "Savings payment", subscriber: { country: "UG", currency: "UGX", msisdn: msisdn.slice(4) }, transaction: { amount: i.amount, country: "UG", currency: "UGX", id: reference } }),
        });
        if (!r.ok) throw new Error(`Airtel rejected the request (HTTP ${r.status})`);
      }
      status = "pending_provider"; raw = "Sent to provider; awaiting customer approval on handset";
    } catch (e) { status = "failed"; raw = (e as Error).message; }
  }
  return db.transaction(async (tx) => {
    const [r] = await tx.insert(paymentRequests).values({
      orgId: svc.orgId, reference, provider: i.provider, purpose: i.purpose, memberId: i.memberId, accountId: i.accountId, loanId: i.loanId, amount: String(i.amount),
      msisdn, status, providerRef, providerStatusRaw: raw, createdBy: svc.actor.userId,
    }).returning();
    await audit(tx, svc.orgId, svc.actor, "payment.requested", "payment_request", r.id, { reference, provider: i.provider, amount: i.amount, status });
    return r;
  });
}

/** Polls the provider for the status of a pending request. Only a provider-reported SUCCESS posts the transaction. */
export async function refreshProviderStatus(svc: Svc, requestId: string) {
  const [r] = await db.select().from(paymentRequests).where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.orgId, svc.orgId)));
  if (!r) throw new AppError("Payment request not found", 404);
  if (r.status !== "pending_provider" || !r.providerRef) throw new AppError("This request is not awaiting a provider response");
  let state = "PENDING", ext: string | undefined;
  try {
    if (r.provider === "mtn_momo") {
      const token = await mtnToken();
      const res = await fetch(`${mtnBase()}/collection/v1_0/requesttopay/${r.providerRef}`, { headers: { Authorization: `Bearer ${token}`, "X-Target-Environment": process.env.MTN_MOMO_ENV ?? "sandbox", "Ocp-Apim-Subscription-Key": process.env.MTN_MOMO_SUBSCRIPTION_KEY! } });
      const j = (await res.json()) as { status?: string; financialTransactionId?: string };
      state = j.status ?? "PENDING"; ext = j.financialTransactionId;
    } else {
      const token = await airtelToken();
      const res = await fetch(`${airtelBase()}/standard/v1/payments/${r.reference}`, { headers: { Authorization: `Bearer ${token}`, "X-Country": "UG", "X-Currency": "UGX" } });
      const j = (await res.json()) as { data?: { transaction?: { status?: string; airtel_money_id?: string } } };
      const s = j.data?.transaction?.status; state = s === "TS" ? "SUCCESSFUL" : s === "TF" ? "FAILED" : "PENDING"; ext = j.data?.transaction?.airtel_money_id;
    }
  } catch (e) { throw new AppError(`Provider status check failed: ${(e as Error).message}`); }
  if (state === "SUCCESSFUL") return confirmPayment(svc, requestId, ext ?? r.providerRef);
  if (state === "FAILED") await db.update(paymentRequests).set({ status: "failed", providerStatusRaw: state }).where(eq(paymentRequests.id, requestId));
  else await db.update(paymentRequests).set({ providerStatusRaw: state }).where(eq(paymentRequests.id, requestId));
  return { status: state.toLowerCase() };
}

/** Confirms a payment (manually verified against a provider statement, or confirmed by the provider) and posts the ledger transaction. */
export async function confirmPayment(svc: Svc, requestId: string, providerTxnId: string) {
  if (!providerTxnId.trim()) throw new AppError("Enter the provider transaction ID from the statement or SMS receipt");
  const [r] = await db.select().from(paymentRequests).where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.orgId, svc.orgId)));
  if (!r) throw new AppError("Payment request not found", 404);
  if (!["awaiting_confirmation", "pending_provider"].includes(r.status)) throw new AppError("This request has already been finalised");
  const amount = Number(r.amount);
  let txnRef: string;
  if (r.purpose === "deposit") {
    const [a] = await db.select().from(savingsAccounts).where(and(eq(savingsAccounts.id, r.accountId!), eq(savingsAccounts.orgId, svc.orgId)));
    if (!a) throw new AppError("Savings account not found");
    txnRef = (await deposit(svc, { accountId: a.id, amount, channel: r.provider, externalRef: providerTxnId, description: `Mobile money deposit ${r.reference}`, confirmDuplicate: true })).reference;
  } else {
    const [l] = await db.select().from(loans).where(and(eq(loans.id, r.loanId!), eq(loans.orgId, svc.orgId)));
    if (!l) throw new AppError("Loan not found");
    txnRef = (await repayLoan(svc, l.id, { amount, channel: r.provider, externalRef: providerTxnId, confirmDuplicate: true })).reference;
  }
  const { transactions } = await import("@/db/schema");
  const [t] = await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.reference, txnRef));
  await db.transaction(async (tx) => {
    await tx.update(paymentRequests).set({ status: "confirmed", providerRef: providerTxnId, transactionId: t.id, reconciledAt: new Date(), providerStatusRaw: "Confirmed" }).where(eq(paymentRequests.id, requestId));
    await audit(tx, svc.orgId, svc.actor, "payment.confirmed", "payment_request", requestId, { reference: r.reference, providerTxnId, transaction: txnRef });
  });
  return { status: "confirmed", reference: txnRef };
}

export async function cancelPayment(svc: Svc, requestId: string) {
  const r = await db.update(paymentRequests).set({ status: "cancelled" }).where(and(eq(paymentRequests.id, requestId), eq(paymentRequests.orgId, svc.orgId), eq(paymentRequests.status, "awaiting_confirmation"))).returning({ id: paymentRequests.id });
  if (!r[0]) throw new AppError("Only requests awaiting confirmation can be cancelled");
}
