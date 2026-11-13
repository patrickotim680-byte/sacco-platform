"use server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { glAccounts, loanProducts, payablesReceivables, savingsProducts, contributionSchedules, savingsAccounts } from "@/db/schema";
import type { FormState } from "@/components/forms";
import { act, S, O, I, OI, B, oneOf, isoDate } from "@/lib/action-helpers";
import { AppError, audit } from "@/lib/core";
import { can } from "@/lib/permissions";
import * as Sv from "@/lib/services/savings";
import * as Ln from "@/lib/services/loans";
import * as Pay from "@/lib/services/payments";
import { dispatchQueued } from "@/lib/services/notify";
import { runContributionAlerts } from "@/lib/services/savings";
import { todayEAT } from "@/lib/finance";

const CH = Sv.CHANNELS;

/* ------------------------------- savings ------------------------------- */
export async function depositAction(_p: FormState, fd: FormData) {
  return act("savings.deposit", async (_c, svc) => {
    const t = await Sv.deposit(svc, { accountId: S(fd, "accountId"), amount: I(fd, "amount", "Amount"), channel: oneOf(S(fd, "channel"), CH, "channel"), externalRef: O(fd, "externalRef"), description: O(fd, "description"), date: isoDate(O(fd, "date")), confirmDuplicate: B(fd, "confirmDuplicate") });
    void dispatchQueued(svc.orgId);
    return `Deposit recorded. Reference ${t.reference}`;
  });
}
export async function requestWithdrawalAction(_p: FormState, fd: FormData) {
  return act("savings.withdraw.request", async (_c, svc) => {
    await Sv.requestWithdrawal(svc, { accountId: S(fd, "accountId"), amount: I(fd, "amount", "Amount"), channel: oneOf(S(fd, "channel"), CH, "channel"), reason: O(fd, "reason") });
    return "Withdrawal request submitted for approval";
  });
}
export async function reviewWithdrawalAction(_p: FormState, fd: FormData) {
  return act("savings.withdraw.approve", async (_c, svc) => {
    const d = oneOf(S(fd, "decision"), ["approve", "reject"] as const, "decision");
    const r = await Sv.reviewWithdrawal(svc, S(fd, "id"), d, O(fd, "reason"));
    void dispatchQueued(svc.orgId);
    return d === "approve" ? `Withdrawal approved and paid. Ref ${r.reference}` : "Withdrawal rejected";
  });
}
export async function reverseTxnAction(_p: FormState, fd: FormData) {
  return act("accounting.reverse", async (_c, svc) => {
    const r = await Sv.reverseTransaction(svc, S(fd, "id"), S(fd, "reason"));
    return `Transaction reversed. Reversal reference ${r.reference}`;
  });
}
export async function postInterestAction(_p: FormState, fd: FormData) {
  return act("savings.interest", async (_c, svc) => {
    const r = await Sv.postSavingsInterest(svc, S(fd, "period"));
    return `Interest posted to ${r.count} account(s), total UGX ${r.total.toLocaleString("en-UG")}`;
  });
}
export async function saveSavingsProductAction(_p: FormState, fd: FormData) {
  return act("savings.products", async (ctx, svc) => {
    const id = O(fd, "id");
    const v = {
      name: S(fd, "name"), category: oneOf(S(fd, "category"), ["mandatory", "voluntary"] as const, "category"), planType: oneOf(S(fd, "planType"), ["flexible", "fixed"] as const, "plan type"),
      frequency: oneOf(S(fd, "frequency"), ["daily", "weekly", "monthly", "custom"] as const, "frequency"), minContribution: String(I(fd, "minContribution", "Minimum contribution")),
      interestRate: String(I(fd, "interestRate", "Interest rate")), lockMonths: OI(fd, "lockMonths") ?? 0, active: !id || B(fd, "active"),
    };
    if (!v.name) throw new AppError("Name is required");
    if (Number(v.interestRate) < 0 || Number(v.interestRate) > 100) throw new AppError("Interest rate must be between 0 and 100");
    await db.transaction(async (tx) => {
      if (id) await tx.update(savingsProducts).set(v).where(and(eq(savingsProducts.id, id), eq(savingsProducts.orgId, ctx.orgId)));
      else await tx.insert(savingsProducts).values({ ...v, orgId: ctx.orgId });
      await audit(tx, ctx.orgId, svc.actor, id ? "savings.product_updated" : "savings.product_created", "savings_product", id ?? null, v);
    });
    return "Savings product saved";
  });
}
export async function setScheduleAction(_p: FormState, fd: FormData) {
  return act("savings.products", async (ctx, svc) => {
    const accountId = S(fd, "accountId");
    const [a] = await db.select().from(savingsAccounts).where(and(eq(savingsAccounts.id, accountId), eq(savingsAccounts.orgId, ctx.orgId)));
    if (!a) throw new AppError("Account not found", 404);
    const v = { amount: String(I(fd, "amount", "Amount")), frequency: oneOf(S(fd, "frequency"), ["daily", "weekly", "monthly", "custom"] as const, "frequency"), intervalDays: OI(fd, "intervalDays") ?? null, nextDue: isoDate(S(fd, "nextDue"), "Next due date") ?? todayEAT() };
    await db.transaction(async (tx) => {
      await tx.delete(contributionSchedules).where(eq(contributionSchedules.accountId, accountId));
      await tx.insert(contributionSchedules).values({ ...v, orgId: ctx.orgId, memberId: a.memberId, accountId, active: true });
      await audit(tx, ctx.orgId, svc.actor, "savings.schedule_set", "savings_account", accountId, v);
    });
    return "Contribution schedule saved";
  });
}
export async function runContributionAlertsAction(_p: FormState, _fd: FormData) {
  return act("notifications.send", async (ctx, svc) => {
    const a = await runContributionAlerts(ctx.orgId);
    const b = await Ln.sendRepaymentReminders(ctx.orgId);
    const c = await Ln.accruePenalties(ctx.orgId);
    const d = await dispatchQueued(svc.orgId);
    return `Automation run: ${a} contribution alert(s), ${b} repayment reminder(s), ${c.overdueLoans} overdue loan alert(s), penalties charged UGX ${c.charged.toLocaleString("en-UG")}. Delivery: ${d.sent} sent, ${d.simulated} simulated (not delivered), ${d.failed} failed.`;
  });
}

/* ------------------------------- loans ------------------------------- */
export async function applyLoanAction(_p: FormState, fd: FormData) {
  return act("loans.apply", async (_c, svc) => {
    const g = (i: number) => ({ memberId: S(fd, `g${i}`), amount: OI(fd, `ga${i}`) ?? 0 });
    const a = await Ln.applyForLoan(svc, {
      memberId: S(fd, "memberId"), productId: S(fd, "productId"), amount: I(fd, "amount", "Amount"), termMonths: I(fd, "termMonths", "Term"), purpose: O(fd, "purpose"),
      guarantors: [g(1), g(2)], collateral: [{ description: S(fd, "collateral"), value: OI(fd, "collateralValue") ?? 0 }],
    });
    return { message: `Application ${a.applicationNo} submitted`, redirect: "/loans/applications" };
  });
}
export async function addGuarantorAction(_p: FormState, fd: FormData) {
  return act("loans.review", async (_c, svc) => { await Ln.addGuarantor(svc, S(fd, "applicationId"), S(fd, "memberId"), I(fd, "amount", "Amount")); return "Guarantor added"; });
}
export async function guarantorStatusAction(_p: FormState, fd: FormData) {
  return act("loans.review", async (_c, svc) => { await Ln.setGuarantorStatus(svc, S(fd, "id"), oneOf(S(fd, "status"), ["accepted", "declined"] as const, "status")); return "Guarantor updated"; });
}
export async function addCollateralAction(_p: FormState, fd: FormData) {
  return act("loans.review", async (_c, svc) => { await Ln.addCollateral(svc, S(fd, "applicationId"), S(fd, "description"), OI(fd, "value") ?? 0); return "Collateral recorded"; });
}
export async function reviewApplicationAction(_p: FormState, fd: FormData) {
  return act("loans.review", async (ctx, svc) => {
    const d = oneOf(S(fd, "decision"), ["under_review", "approved", "rejected"] as const, "decision");
    await Ln.reviewApplication(svc, S(fd, "id"), d, O(fd, "reason"), can(ctx.role, "loans.approve"));
    void dispatchQueued(svc.orgId);
    return d === "approved" ? "Application approved" : d === "rejected" ? "Application rejected" : "Application moved to review";
  });
}
export async function disburseAction(_p: FormState, fd: FormData) {
  return act("loans.disburse", async (_c, svc) => {
    const r = await Ln.disburseLoan(svc, S(fd, "id"), { channel: oneOf(S(fd, "channel"), CH, "channel"), date: isoDate(O(fd, "date")) });
    void dispatchQueued(svc.orgId);
    return { message: `Loan ${r.loan.loanNo} disbursed. Ref ${r.reference}`, redirect: `/loans/${r.loan.id}` };
  });
}
export async function repayAction(_p: FormState, fd: FormData) {
  return act("loans.repay", async (_c, svc) => {
    const r = await Ln.repayLoan(svc, S(fd, "id"), { amount: I(fd, "amount", "Amount"), channel: oneOf(S(fd, "channel"), CH, "channel"), externalRef: O(fd, "externalRef"), date: isoDate(O(fd, "date")), confirmDuplicate: B(fd, "confirmDuplicate") });
    void dispatchQueued(svc.orgId);
    return `Repayment recorded (principal ${r.principal.toLocaleString("en-UG")}, interest ${r.interest.toLocaleString("en-UG")}, penalty ${r.penalty.toLocaleString("en-UG")}). ${r.closed ? "Loan fully repaid." : "Balance " + r.remaining.toLocaleString("en-UG")}`;
  });
}
export async function settleLoanAction(_p: FormState, fd: FormData) {
  return act("loans.repay", async (_c, svc) => {
    const r = await Ln.settleLoanEarly(svc, S(fd, "id"), oneOf(S(fd, "channel"), CH, "channel"));
    return `Loan settled early. Future interest rebated: UGX ${r.rebate.toLocaleString("en-UG")}`;
  });
}
export async function restructureAction(_p: FormState, fd: FormData) {
  return act("loans.restructure", async (_c, svc) => {
    const nl = await Ln.restructureLoan(svc, S(fd, "id"), { newTermMonths: I(fd, "term", "New term"), newRatePct: OI(fd, "rate"), waiveArrears: B(fd, "waive"), reason: S(fd, "reason") });
    return { message: `Restructured as ${nl.loanNo}`, redirect: `/loans/${nl.id}` };
  });
}
export async function saveLoanProductAction(_p: FormState, fd: FormData) {
  return act("loans.products", async (ctx, svc) => {
    const id = O(fd, "id");
    const v = {
      name: S(fd, "name"), interestRate: String(I(fd, "interestRate", "Interest rate")), interestMethod: oneOf(S(fd, "interestMethod"), ["flat", "reducing"] as const, "method"),
      frequency: oneOf(S(fd, "frequency"), ["monthly", "weekly"] as const, "frequency"), minAmount: String(I(fd, "minAmount", "Minimum amount")), maxAmount: String(I(fd, "maxAmount", "Maximum amount")),
      minTermMonths: I(fd, "minTerm", "Minimum term"), maxTermMonths: I(fd, "maxTerm", "Maximum term"), savingsMultiple: String(I(fd, "savingsMultiple", "Savings multiple")),
      minMembershipMonths: I(fd, "minMembership", "Minimum membership"), guarantorsRequired: I(fd, "guarantors", "Guarantors"), processingFeePct: String(I(fd, "fee", "Processing fee")),
      penaltyRatePct: String(I(fd, "penalty", "Penalty rate")), graceDays: I(fd, "grace", "Grace days"), active: !id || B(fd, "active"),
    };
    if (!v.name) throw new AppError("Name is required");
    if (Number(v.interestRate) < 0 || Number(v.interestRate) > 100) throw new AppError("Interest rate must be between 0 and 100");
    if (Number(v.maxAmount) < Number(v.minAmount) || v.maxTermMonths < v.minTermMonths) throw new AppError("Maximum values must not be below minimum values");
    await db.transaction(async (tx) => {
      if (id) await tx.update(loanProducts).set(v).where(and(eq(loanProducts.id, id), eq(loanProducts.orgId, ctx.orgId)));
      else await tx.insert(loanProducts).values({ ...v, orgId: ctx.orgId });
      await audit(tx, ctx.orgId, svc.actor, id ? "loan.product_updated" : "loan.product_created", "loan_product", id ?? null, v);
    });
    return "Loan product saved";
  });
}

/* ------------------------------- accounting ------------------------------- */
export async function cashbookAction(_p: FormState, fd: FormData) {
  return act("accounting.post", async (_c, svc) => {
    const t = await Sv.recordCashbook(svc, { kind: oneOf(S(fd, "kind"), ["income", "expense"] as const, "type"), glCode: S(fd, "glCode"), amount: I(fd, "amount", "Amount"), channel: oneOf(S(fd, "channel"), CH, "channel"), description: S(fd, "description"), date: isoDate(O(fd, "date")), payee: O(fd, "payee") });
    return `Recorded. Reference ${t.reference}`;
  });
}
export async function journalAction(_p: FormState, fd: FormData) {
  return act("accounting.post", async (_c, svc) => {
    const lines = [1, 2, 3, 4].map((i) => ({ code: S(fd, `acc${i}`), debit: OI(fd, `dr${i}`) ?? 0, credit: OI(fd, `cr${i}`) ?? 0, memo: O(fd, `memo${i}`) })).filter((l) => l.code && (l.debit || l.credit));
    const je = await Sv.postManualJournal(svc, { date: isoDate(S(fd, "date")) ?? todayEAT(), description: S(fd, "description"), lines, kind: oneOf(S(fd, "kind"), ["manual", "adjustment"] as const, "type") });
    return `Journal ${je.entryNo} posted`;
  });
}
export async function reverseJournalAction(_p: FormState, fd: FormData) {
  return act("accounting.reverse", async (_c, svc) => { const je = await Sv.reverseJournal(svc, S(fd, "id"), S(fd, "reason")); return `Reversed by ${je.entryNo}`; });
}
export async function createGlAccountAction(_p: FormState, fd: FormData) {
  return act("accounting.post", async (ctx, svc) => {
    const code = S(fd, "code"), name = S(fd, "name"), type = oneOf(S(fd, "type"), ["asset", "liability", "equity", "income", "expense"] as const, "type");
    if (!/^\d{4,6}$/.test(code)) throw new AppError("Account code must be 4-6 digits");
    if (!name) throw new AppError("Name is required");
    await db.transaction(async (tx) => {
      await tx.insert(glAccounts).values({ orgId: ctx.orgId, code, name, type });
      await audit(tx, ctx.orgId, svc.actor, "gl.account_created", "gl_account", code, { name, type });
    });
    return "Ledger account created";
  });
}
export async function payableAction(_p: FormState, fd: FormData) {
  return act("accounting.post", async (ctx, svc) => {
    await db.transaction(async (tx) => {
      const [r] = await tx.insert(payablesReceivables).values({ orgId: ctx.orgId, kind: oneOf(S(fd, "kind"), ["payable", "receivable"] as const, "type"), party: S(fd, "party"), description: O(fd, "description"), amount: String(I(fd, "amount", "Amount")), dueDate: isoDate(S(fd, "dueDate"), "Due date") ?? todayEAT() }).returning({ id: payablesReceivables.id });
      await audit(tx, ctx.orgId, svc.actor, "ledger.item_created", "payable_receivable", r.id, {});
    });
    return "Recorded";
  });
}
export async function settleItemAction(_p: FormState, fd: FormData) {
  return act("accounting.post", async (ctx, svc) => {
    const id = S(fd, "id"), amount = I(fd, "amount", "Amount");
    const [it] = await db.select().from(payablesReceivables).where(and(eq(payablesReceivables.id, id), eq(payablesReceivables.orgId, ctx.orgId)));
    if (!it) throw new AppError("Item not found", 404);
    const remaining = Number(it.amount) - Number(it.settled);
    if (amount <= 0 || amount > remaining) throw new AppError(`Amount must be between 1 and ${remaining}`);
    const channel = oneOf(S(fd, "channel"), CH, "channel");
    // Settlement is a real cash movement: it is posted through the cashbook so the ledger stays balanced.
    if (it.kind === "payable") await Sv.recordCashbook(svc, { kind: "expense", glCode: "5020", amount, channel, description: `Payment to ${it.party}: ${it.description ?? ""}`, payee: it.party });
    else await Sv.recordCashbook(svc, { kind: "income", glCode: "4030", amount, channel, description: `Receipt from ${it.party}: ${it.description ?? ""}` });
    await db.update(payablesReceivables).set({ settled: String(Number(it.settled) + amount), status: amount === remaining ? "settled" : "open" }).where(eq(payablesReceivables.id, id));
    return "Settlement recorded";
  });
}

/* ------------------------------- payments ------------------------------- */
export async function requestCollectionAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (_c, svc) => {
    const purpose = oneOf(S(fd, "purpose"), ["deposit", "loan_repayment"] as const, "purpose");
    const r = await Pay.requestCollection(svc, { provider: oneOf(S(fd, "provider"), ["mtn_momo", "airtel_money"] as const, "provider"), purpose, memberId: S(fd, "memberId"), accountId: O(fd, "accountId"), loanId: O(fd, "loanId"), amount: I(fd, "amount", "Amount"), msisdn: S(fd, "msisdn") });
    return r.status === "failed" ? `Provider rejected the request: ${r.providerStatusRaw}` : r.status === "pending_provider" ? "Request sent to provider. Ask the member to approve on their phone." : `Request ${r.reference} created. Provider API is not configured, so confirm manually once the money is received.`;
  });
}
export async function confirmPaymentAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (_c, svc) => { const r = await Pay.confirmPayment(svc, S(fd, "id"), S(fd, "providerTxnId")); return `Payment confirmed and posted${r.reference ? ". Ref " + r.reference : ""}`; });
}
export async function refreshPaymentAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (_c, svc) => { const r = await Pay.refreshProviderStatus(svc, S(fd, "id")); return `Provider status: ${r.status}`; });
}
export async function cancelPaymentAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (_c, svc) => { await Pay.cancelPayment(svc, S(fd, "id")); return "Request cancelled"; });
}
export async function testConnectionAction(_p: FormState, fd: FormData) {
  return act("payments.manage", async (_c, svc) => Pay.testConnection(svc, oneOf(S(fd, "provider"), ["mtn_momo", "airtel_money"] as const, "provider")));
}
