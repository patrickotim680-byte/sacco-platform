import { and, eq, sql, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  fraudFlags, organisations, loanApplications, loanCollaterals, loanGuarantors, loanProducts, loanRepayments, loanSchedule, loans, members, savingsAccounts, transactions,
} from "@/db/schema";
import { AppError, accountMap, allowLedgerWrite, audit, CHANNEL_ACCOUNT, getSettings, nextSeq, postJournal, type Tx } from "@/lib/core";
import {
  allocateRepayment, assessEligibility, buildSchedule, daysBetween, earlySettlement, monthsBetween, penaltyCharge, round, todayEAT, totalOutstanding,
  type DueRow, type InterestMethod, type LoanFrequency,
} from "@/lib/finance";
import { assertFunds, flag, friendly, insertTxn, linkJournal, type Svc } from "@/lib/services/savings";
import { queueNotification } from "@/lib/services/notify";
import { ugx } from "@/lib/format";

const n = (v: string | number | null) => Number(v ?? 0);
const toDue = (r: typeof loanSchedule.$inferSelect): DueRow => ({
  id: r.id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: n(r.principalDue), interestDue: n(r.interestDue),
  principalPaid: n(r.principalPaid), interestPaid: n(r.interestPaid), penaltyAccrued: n(r.penaltyAccrued), penaltyPaid: n(r.penaltyPaid),
});

/* ---------------- eligibility (read-only helper, also used on the UI) ---------------- */
export async function memberEligibility(orgId: string, memberId: string, productId: string, amount: number, termMonths: number, guarantors: { amount: number }[] = []) {
  const [m] = await db.select().from(members).where(and(eq(members.id, memberId), eq(members.orgId, orgId)));
  const [p] = await db.select().from(loanProducts).where(and(eq(loanProducts.id, productId), eq(loanProducts.orgId, orgId)));
  if (!m || !p) throw new AppError("Member or loan product not found", 404);
  const [sv] = await db.select({ s: sql<string>`coalesce(sum(${savingsAccounts.balance}),0)` }).from(savingsAccounts).where(and(eq(savingsAccounts.memberId, memberId), eq(savingsAccounts.status, "active")));
  const [ol] = await db.select({ s: sql<string>`coalesce(sum(${loans.principal} - ${loans.principalPaid}),0)` }).from(loans).where(and(eq(loans.memberId, memberId), eq(loans.status, "active")));
  const today = todayEAT();
  const [od] = await db.select({ c: sql<number>`count(distinct ${loanSchedule.loanId})` }).from(loanSchedule)
    .innerJoin(loans, eq(loans.id, loanSchedule.loanId))
    .where(and(eq(loans.memberId, memberId), eq(loans.status, "active"), lt(loanSchedule.dueDate, today), sql`${loanSchedule.principalPaid} + ${loanSchedule.interestPaid} < ${loanSchedule.principalDue} + ${loanSchedule.interestDue}`));
  const result = assessEligibility({
    memberStatus: m.status, savingsBalance: n(sv.s), outstandingPrincipal: n(ol.s), membershipMonths: monthsBetween(m.joinedAt, today), overdueLoans: Number(od.c),
    amount, termMonths, guarantorCover: guarantors.reduce((s, g) => s + g.amount, 0), guarantorCount: guarantors.length,
    product: { minAmount: n(p.minAmount), maxAmount: n(p.maxAmount), minTermMonths: p.minTermMonths, maxTermMonths: p.maxTermMonths, savingsMultiple: n(p.savingsMultiple), minMembershipMonths: p.minMembershipMonths, guarantorsRequired: p.guarantorsRequired },
  });
  return { ...result, savings: n(sv.s), outstanding: n(ol.s), member: m, product: p };
}

/* ---------------- applications ---------------- */
export async function applyForLoan(svc: Svc, i: {
  memberId: string; productId: string; amount: number; termMonths: number; purpose?: string;
  guarantors?: { memberId: string; amount: number }[]; collateral?: { description: string; value: number }[];
}) {
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new AppError("Enter a valid whole-shilling loan amount");
  const gs = (i.guarantors ?? []).filter((g) => g.memberId && g.amount > 0);
  if (gs.some((g) => g.memberId === i.memberId)) throw new AppError("A member cannot guarantee their own loan");
  const el = await memberEligibility(svc.orgId, i.memberId, i.productId, i.amount, i.termMonths, gs);
  if (!el.eligible) throw new AppError("Not eligible: " + el.reasons.join("; "));
  return db.transaction(async (tx) => {
    const [pending] = await tx.select({ c: sql<number>`count(*)` }).from(loanApplications).where(and(eq(loanApplications.memberId, i.memberId), inArray(loanApplications.status, ["pending", "under_review", "approved"])));
    if (Number(pending.c) > 0) throw new AppError("This member already has an application in progress");
    const seq = await nextSeq(tx, svc.orgId, "loan_application");
    const [a] = await tx.insert(loanApplications).values({
      orgId: svc.orgId, applicationNo: `LA-${String(seq).padStart(5, "0")}`, memberId: i.memberId, productId: i.productId, amount: String(i.amount),
      termMonths: i.termMonths, purpose: i.purpose, eligibility: { ...el, member: undefined, product: undefined }, appliedBy: svc.actor.userId,
    }).returning();
    if (gs.length) await tx.insert(loanGuarantors).values(gs.map((g) => ({ orgId: svc.orgId, applicationId: a.id, guarantorMemberId: g.memberId, amountGuaranteed: String(g.amount) })));
    const cs = (i.collateral ?? []).filter((c) => c.description.trim());
    if (cs.length) await tx.insert(loanCollaterals).values(cs.map((c) => ({ orgId: svc.orgId, applicationId: a.id, description: c.description, estimatedValue: String(c.value || 0) })));
    await audit(tx, svc.orgId, svc.actor, "loan.application_submitted", "loan_application", a.id, { no: a.applicationNo, amount: i.amount });
    return a;
  });
}

export async function addGuarantor(svc: Svc, applicationId: string, memberId: string, amount: number) {
  const [a] = await db.select().from(loanApplications).where(and(eq(loanApplications.id, applicationId), eq(loanApplications.orgId, svc.orgId)));
  if (!a || !["pending", "under_review"].includes(a.status)) throw new AppError("Application cannot be changed");
  if (a.memberId === memberId) throw new AppError("A member cannot guarantee their own loan");
  if (!(amount > 0)) throw new AppError("Guaranteed amount is required");
  const [m] = await db.select({ id: members.id }).from(members).where(and(eq(members.id, memberId), eq(members.orgId, svc.orgId), eq(members.status, "active")));
  if (!m) throw new AppError("Guarantor must be an active member");
  await db.transaction(async (tx) => {
    await tx.insert(loanGuarantors).values({ orgId: svc.orgId, applicationId, guarantorMemberId: memberId, amountGuaranteed: String(amount) });
    await audit(tx, svc.orgId, svc.actor, "loan.guarantor_added", "loan_application", applicationId, { memberId, amount });
  });
}
export async function setGuarantorStatus(svc: Svc, id: string, status: "accepted" | "declined") {
  const r = await db.update(loanGuarantors).set({ status }).where(and(eq(loanGuarantors.id, id), eq(loanGuarantors.orgId, svc.orgId))).returning({ a: loanGuarantors.applicationId });
  if (!r[0]) throw new AppError("Guarantor not found", 404);
  await db.transaction((tx) => audit(tx, svc.orgId, svc.actor, `loan.guarantor_${status}`, "loan_application", r[0].a, { id }));
}
export async function addCollateral(svc: Svc, applicationId: string, description: string, value: number) {
  const [a] = await db.select({ id: loanApplications.id }).from(loanApplications).where(and(eq(loanApplications.id, applicationId), eq(loanApplications.orgId, svc.orgId)));
  if (!a) throw new AppError("Application not found", 404);
  if (!description.trim()) throw new AppError("Collateral description is required");
  await db.insert(loanCollaterals).values({ orgId: svc.orgId, applicationId, description, estimatedValue: String(value || 0) });
}

export async function reviewApplication(svc: Svc, id: string, decision: "under_review" | "approved" | "rejected", note: string | undefined, canApprove: boolean) {
  if ((decision === "approved" || decision === "rejected") && !canApprove) throw new AppError("You do not have permission to approve or reject loans", 403);
  const [a] = await db.select().from(loanApplications).where(and(eq(loanApplications.id, id), eq(loanApplications.orgId, svc.orgId)));
  if (!a) throw new AppError("Application not found", 404);
  if (!["pending", "under_review"].includes(a.status)) throw new AppError("This application has already been decided");
  if (decision === "rejected" && !note?.trim()) throw new AppError("A reason is required when rejecting an application");
  if (decision === "approved" && getSettings(svc.org).makerChecker && a.appliedBy === svc.actor.userId) {
    await flag(svc.orgId, "self_approval_blocked", `User attempted to approve loan application ${a.applicationNo} they submitted`, "high");
    throw new AppError("Maker-checker: you cannot approve an application you submitted");
  }
  return db.transaction(async (tx) => {
    if (decision === "approved") {
      const gs = await tx.select().from(loanGuarantors).where(eq(loanGuarantors.applicationId, id));
      const accepted = gs.filter((g) => g.status === "accepted");
      const el = await memberEligibility(svc.orgId, a.memberId, a.productId, n(a.amount), a.termMonths, accepted.map((g) => ({ amount: n(g.amountGuaranteed) })));
      if (!el.eligible) throw new AppError("Eligibility re-check failed: " + el.reasons.join("; "));
      if (accepted.length < el.product.guarantorsRequired) throw new AppError(`${el.product.guarantorsRequired} accepted guarantor(s) required (${accepted.length} accepted)`);
    }
    await tx.update(loanApplications).set({ status: decision, reviewedBy: svc.actor.userId, reviewNote: note, reviewedAt: new Date() }).where(eq(loanApplications.id, id));
    await audit(tx, svc.orgId, svc.actor, `loan.application_${decision}`, "loan_application", id, { no: a.applicationNo, note });
    if (decision !== "under_review") {
      await queueNotification(tx, svc.orgId, {
        memberId: a.memberId, kind: "loan_decision", title: decision === "approved" ? "Loan approved" : "Loan application declined",
        body: decision === "approved" ? `Your loan application ${a.applicationNo} for ${ugx(a.amount)} has been approved and awaits disbursement.` : `Your loan application ${a.applicationNo} was declined.${note ? " Reason: " + note : ""}`,
      });
    }
  });
}

/* ---------------- disbursement ---------------- */
export async function disburseLoan(svc: Svc, applicationId: string, i: { channel: string; date?: string }) {
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [a] = await tx.select().from(loanApplications).where(and(eq(loanApplications.id, applicationId), eq(loanApplications.orgId, svc.orgId))).for("update");
      if (!a) throw new AppError("Application not found", 404);
      if (a.status !== "approved") throw new AppError("Only approved applications can be disbursed");
      const [m] = await tx.select().from(members).where(eq(members.id, a.memberId));
      if (m.status !== "active") throw new AppError("Member is not active");
      const [p] = await tx.select().from(loanProducts).where(eq(loanProducts.id, a.productId));
      const principal = n(a.amount);
      const fee = round((principal * n(p.processingFeePct)) / 100);
      const net = principal - fee;
      await assertFunds(tx, svc.orgId, i.channel, net);
      const date = i.date ?? todayEAT();
      const seq = await nextSeq(tx, svc.orgId, "loan");
      const [loan] = await tx.insert(loans).values({
        orgId: svc.orgId, loanNo: `LN-${String(seq).padStart(5, "0")}`, memberId: a.memberId, productId: a.productId, applicationId: a.id, principal: String(principal),
        interestRate: p.interestRate, interestMethod: p.interestMethod, frequency: p.frequency, termMonths: a.termMonths, penaltyRatePct: p.penaltyRatePct,
        graceDays: p.graceDays, disbursedAt: date, channel: i.channel, disbursedBy: svc.actor.userId,
      }).returning();
      const sched = buildSchedule({ principal, annualRatePct: n(p.interestRate), method: p.interestMethod as InterestMethod, termMonths: a.termMonths, frequency: p.frequency as LoanFrequency, startDate: date });
      await tx.insert(loanSchedule).values(sched.map((r) => ({ orgId: svc.orgId, loanId: loan.id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: String(r.principalDue), interestDue: String(r.interestDue) })));
      const t = await insertTxn(tx, svc, { type: "loan_disbursement", memberId: a.memberId, loanId: loan.id, amount: principal, channel: i.channel, description: `Loan disbursement ${loan.loanNo}`, date, metadata: { fee, net } });
      const acct = await accountMap(tx, svc.orgId);
      const lines = [{ accountId: acct("1100"), debit: principal, credit: 0 }, { accountId: acct(CHANNEL_ACCOUNT[i.channel]), debit: 0, credit: net }];
      if (fee > 0) lines.push({ accountId: acct("4020"), debit: 0, credit: fee });
      const je = await postJournal(tx, { orgId: svc.orgId, date, description: `Loan disbursement ${loan.loanNo} to ${m.fullName}`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId, lines });
      await linkJournal(tx, t.id, je.id);
      await tx.update(loanApplications).set({ status: "disbursed", loanId: loan.id }).where(eq(loanApplications.id, a.id));
      await audit(tx, svc.orgId, svc.actor, "loan.disbursed", "loan", loan.id, { loanNo: loan.loanNo, principal, fee, channel: i.channel, reference: t.reference });
      await queueNotification(tx, svc.orgId, { memberId: a.memberId, kind: "loan_decision", title: "Loan disbursed", body: `${ugx(net)} (after ${ugx(fee)} fee) has been disbursed for loan ${loan.loanNo}. First installment due ${sched[0].dueDate}.` });
      return { loan, reference: t.reference };
    });
  } catch (e) { throw friendly(e); }
}

/* ---------------- repayment ---------------- */
async function repayInTx(tx: Tx, svc: Svc, loanId: string, i: { amount: number; channel: string; externalRef?: string; date?: string; kind?: "regular" | "early_settlement"; confirmDuplicate?: boolean }) {
  const [loan] = await tx.select().from(loans).where(and(eq(loans.id, loanId), eq(loans.orgId, svc.orgId))).for("update");
  if (!loan) throw new AppError("Loan not found", 404);
  if (loan.status !== "active") throw new AppError("Loan is not active");
  const rows = (await tx.select().from(loanSchedule).where(and(eq(loanSchedule.loanId, loanId), sql`${loanSchedule.status} <> 'superseded'`)).for("update")).map(toDue);
  const outstanding = totalOutstanding(rows);
  const total = outstanding.principal + outstanding.interest + outstanding.penalty;
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new AppError("Amount must be a positive whole number of shillings");
  if (i.amount > getSettings(svc.org).singleTxnLimit) throw new AppError("Amount exceeds the single-transaction limit");
  if (i.amount > total) throw new AppError(`Amount exceeds the outstanding balance of ${ugx(total)}`);
  const date = i.date ?? todayEAT();
  const mins = getSettings(svc.org).duplicateWindowMinutes;
  const [dup] = await tx.select({ r: transactions.reference }).from(transactions).where(and(eq(transactions.orgId, svc.orgId), eq(transactions.loanId, loanId), eq(transactions.type, "loan_repayment"), eq(transactions.amount, String(i.amount)), eq(transactions.status, "completed"), sql`${transactions.createdAt} > now() - (${mins} * interval '1 minute')`)).limit(1);
  if (dup && !i.confirmDuplicate) throw new AppError(`Possible duplicate of ${dup.r} (same amount within ${mins} minutes). Tick "confirm duplicate" if intentional.`);
  const alloc = allocateRepayment(rows, i.amount);
  const t = await insertTxn(tx, svc, { type: "loan_repayment", memberId: loan.memberId, loanId, amount: i.amount, channel: i.channel, externalRef: i.externalRef, description: `Repayment ${loan.loanNo}`, date, metadata: { kind: i.kind ?? "regular" } });
  if (dup) await tx.insert(fraudFlags).values({ orgId: svc.orgId, transactionId: t.id, kind: "duplicate_override", severity: "high", detail: `Repayment ${t.reference} confirmed as duplicate of ${dup.r}` });
  const acct = await accountMap(tx, svc.orgId);
  const lines = [{ accountId: acct(CHANNEL_ACCOUNT[i.channel]), debit: i.amount, credit: 0 }];
  if (alloc.principal) lines.push({ accountId: acct("1100"), debit: 0, credit: alloc.principal });
  if (alloc.interest) lines.push({ accountId: acct("4000"), debit: 0, credit: alloc.interest });
  if (alloc.penalty) lines.push({ accountId: acct("4010"), debit: 0, credit: alloc.penalty });
  const je = await postJournal(tx, { orgId: svc.orgId, date, description: `Loan repayment ${loan.loanNo} (${t.reference})`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId, lines });
  await linkJournal(tx, t.id, je.id);
  for (const a of alloc.allocations) {
    const r = rows.find((x) => x.id === a.scheduleId)!;
    const pp = r.principalPaid + a.principal, ip = r.interestPaid + a.interest, pen = r.penaltyPaid + a.penalty;
    const done = pp >= r.principalDue && ip >= r.interestDue && pen >= r.penaltyAccrued;
    await tx.update(loanSchedule).set({ principalPaid: String(pp), interestPaid: String(ip), penaltyPaid: String(pen), status: done ? "paid" : "partial" }).where(eq(loanSchedule.id, a.scheduleId));
  }
  const remaining = total - i.amount;
  await tx.update(loans).set({
    principalPaid: sql`${loans.principalPaid} + ${alloc.principal}`, interestPaid: sql`${loans.interestPaid} + ${alloc.interest}`, penaltyPaid: sql`${loans.penaltyPaid} + ${alloc.penalty}`,
    status: remaining === 0 ? "closed" : "active",
  }).where(eq(loans.id, loanId));
  await tx.insert(loanRepayments).values({ orgId: svc.orgId, loanId, transactionId: t.id, amount: String(i.amount), principal: String(alloc.principal), interest: String(alloc.interest), penalty: String(alloc.penalty), allocation: alloc.allocations, kind: i.kind ?? "regular", paidAt: date });
  await audit(tx, svc.orgId, svc.actor, "loan.repayment", "loan", loanId, { reference: t.reference, amount: i.amount, ...alloc, allocations: undefined, closed: remaining === 0 });
  await queueNotification(tx, svc.orgId, { memberId: loan.memberId, kind: "loan_reminder", title: "Repayment received", body: `We received ${ugx(i.amount)} on loan ${loan.loanNo}. Balance remaining: ${ugx(remaining)}.` });
  return { reference: t.reference, remaining, closed: remaining === 0, ...alloc };
}

export async function repayLoan(svc: Svc, loanId: string, i: { amount: number; channel: string; externalRef?: string; date?: string; confirmDuplicate?: boolean }) {
  try {
    return await db.transaction(async (tx) => { await allowLedgerWrite(tx); return repayInTx(tx, svc, loanId, i); });
  } catch (e) { throw friendly(e); }
}

export async function settleLoanEarly(svc: Svc, loanId: string, channel: string) {
  if (!getSettings(svc.org).allowEarlySettlement) throw new AppError("Early settlement is disabled by this organisation's policy");
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const rows = (await tx.select().from(loanSchedule).where(and(eq(loanSchedule.loanId, loanId), eq(loanSchedule.orgId, svc.orgId), sql`${loanSchedule.status} <> 'superseded'`)).for("update")).map(toDue);
      const today = todayEAT();
      const s = earlySettlement(rows, today);
      if (s.total <= 0) throw new AppError("Nothing to settle");
      // rebate interest on installments not yet due
      for (const r of rows.filter((x) => x.dueDate > today && x.interestDue > x.interestPaid)) {
        await tx.update(loanSchedule).set({ interestDue: String(r.interestPaid) }).where(eq(loanSchedule.id, r.id));
      }
      // after the rebate the full remaining balance = principal + due interest + penalties
      const res = await repayInTx(tx, svc, loanId, { amount: s.total, channel, kind: "early_settlement", confirmDuplicate: true });
      await audit(tx, svc.orgId, svc.actor, "loan.early_settlement", "loan", loanId, { total: s.total, interestRebated: s.rebate });
      return { ...res, rebate: s.rebate };
    });
  } catch (e) { throw friendly(e); }
}

/* ---------------- penalties & overdue automation ---------------- */
export async function accruePenalties(orgId: string, today = todayEAT()) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ s: loanSchedule, l: loans }).from(loanSchedule).innerJoin(loans, eq(loans.id, loanSchedule.loanId))
      .where(and(eq(loanSchedule.orgId, orgId), eq(loans.status, "active"), lt(loanSchedule.dueDate, today), sql`${loanSchedule.status} in ('pending','partial')`)).for("update", { of: loanSchedule });
    let charged = 0, installments = 0;
    const notified = new Set<string>();
    for (const { s, l } of rows) {
      const unpaid = n(s.principalDue) + n(s.interestDue) - n(s.principalPaid) - n(s.interestPaid);
      if (unpaid <= 0) continue;
      const days = daysBetween(s.dueDate, today);
      const c = penaltyCharge({ unpaid, ratePct: n(l.penaltyRatePct), daysOverdue: days, graceDays: l.graceDays, periodsCharged: s.penaltyPeriods });
      if (c.newPeriods > 0) {
        await tx.update(loanSchedule).set({ penaltyAccrued: sql`${loanSchedule.penaltyAccrued} + ${c.amount}`, penaltyPeriods: s.penaltyPeriods + c.newPeriods }).where(eq(loanSchedule.id, s.id));
        charged += c.amount; installments++;
      }
      if (days > l.graceDays && !notified.has(l.id)) {
        notified.add(l.id);
        await queueNotification(tx, orgId, { memberId: l.memberId, kind: "missed_payment", title: "Loan payment overdue", body: `Installment ${s.installmentNo} of loan ${l.loanNo} was due ${s.dueDate} (${days} days overdue). Please pay ${ugx(unpaid)} to avoid further penalties.`, dedupeKey: `overdue:${l.id}:${today}` });
      }
    }
    return { charged, installments, overdueLoans: notified.size };
  });
}

export async function sendRepaymentReminders(orgId: string, today = todayEAT()) {
  const [org] = await db.select().from(organisations).where(eq(organisations.id, orgId));
  const days = getSettings(org).repaymentReminderDays;
  const rows = await db.select({ s: loanSchedule, l: loans }).from(loanSchedule).innerJoin(loans, eq(loans.id, loanSchedule.loanId))
    .where(and(eq(loanSchedule.orgId, orgId), eq(loans.status, "active"), sql`${loanSchedule.status} in ('pending','partial')`, sql`${loanSchedule.dueDate} between ${today} and (${today}::date + ${days}::int)`));
  let c = 0;
  await db.transaction(async (tx) => {
    for (const { s, l } of rows) {
      const due = n(s.principalDue) + n(s.interestDue) - n(s.principalPaid) - n(s.interestPaid);
      if (due <= 0) continue;
      await queueNotification(tx, orgId, { memberId: l.memberId, kind: "loan_reminder", title: "Loan repayment due soon", body: `Installment ${s.installmentNo} of loan ${l.loanNo} (${ugx(due)}) is due on ${s.dueDate}.`, dedupeKey: `remind:${s.id}` });
      c++;
    }
  });
  return c;
}

/* ---------------- restructuring ---------------- */
export async function restructureLoan(svc: Svc, loanId: string, i: { newTermMonths: number; newRatePct?: number; waiveArrears: boolean; reason: string }) {
  if (i.reason.trim().length < 5) throw new AppError("A reason is required");
  if (!(i.newTermMonths >= 1 && i.newTermMonths <= 60)) throw new AppError("Term must be between 1 and 60 months");
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [loan] = await tx.select().from(loans).where(and(eq(loans.id, loanId), eq(loans.orgId, svc.orgId))).for("update");
      if (!loan || loan.status !== "active") throw new AppError("Only active loans can be restructured");
      const rows = (await tx.select().from(loanSchedule).where(and(eq(loanSchedule.loanId, loanId), sql`${loanSchedule.status} <> 'superseded'`)).for("update")).map(toDue);
      const today = todayEAT();
      const o = totalOutstanding(rows);
      const arrearsInterest = rows.filter((r) => r.dueDate <= today).reduce((s, r) => s + (r.interestDue - r.interestPaid), 0);
      if (!i.waiveArrears && (arrearsInterest > 0 || o.penalty > 0)) throw new AppError(`Arrears must be paid or explicitly waived first (interest ${ugx(arrearsInterest)}, penalties ${ugx(o.penalty)})`);
      if (o.principal <= 0) throw new AppError("No outstanding principal");
      for (const r of rows) {
        await tx.update(loanSchedule).set({ interestDue: r.dueDate <= today && i.waiveArrears ? String(r.interestPaid) : String(r.interestDue), penaltyAccrued: i.waiveArrears ? String(r.penaltyPaid) : String(r.penaltyAccrued), status: "superseded" }).where(eq(loanSchedule.id, r.id));
      }
      const seq = await nextSeq(tx, svc.orgId, "loan");
      const rate = i.newRatePct ?? n(loan.interestRate);
      const [nl] = await tx.insert(loans).values({
        orgId: svc.orgId, loanNo: `LN-${String(seq).padStart(5, "0")}`, memberId: loan.memberId, productId: loan.productId, principal: String(o.principal), interestRate: String(rate),
        interestMethod: loan.interestMethod, frequency: loan.frequency, termMonths: i.newTermMonths, penaltyRatePct: loan.penaltyRatePct, graceDays: loan.graceDays,
        disbursedAt: today, channel: loan.channel, restructuredFromId: loan.id, disbursedBy: svc.actor.userId,
      }).returning();
      const sched = buildSchedule({ principal: o.principal, annualRatePct: rate, method: loan.interestMethod as InterestMethod, termMonths: i.newTermMonths, frequency: loan.frequency as LoanFrequency, startDate: today });
      await tx.insert(loanSchedule).values(sched.map((r) => ({ orgId: svc.orgId, loanId: nl.id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: String(r.principalDue), interestDue: String(r.interestDue) })));
      await tx.update(loans).set({ status: "restructured" }).where(eq(loans.id, loan.id));
      await audit(tx, svc.orgId, svc.actor, "loan.restructured", "loan", loan.id, { from: loan.loanNo, to: nl.loanNo, principal: o.principal, term: i.newTermMonths, rate, waivedArrears: i.waiveArrears ? { interest: arrearsInterest, penalty: o.penalty } : null, reason: i.reason });
      await queueNotification(tx, svc.orgId, { memberId: loan.memberId, kind: "loan_decision", title: "Loan restructured", body: `Loan ${loan.loanNo} was restructured into ${nl.loanNo}: ${ugx(o.principal)} over ${i.newTermMonths} months.` });
      return nl;
    });
  } catch (e) { throw friendly(e); }
}

/** Loan summary used by pages and reports */
export async function loanBalances(loanId: string) {
  const rows = (await db.select().from(loanSchedule).where(and(eq(loanSchedule.loanId, loanId), sql`${loanSchedule.status} <> 'superseded'`)).orderBy(loanSchedule.installmentNo)).map(toDue);
  const today = todayEAT();
  const o = totalOutstanding(rows);
  const overdueRows = rows.filter((r) => r.dueDate < today && r.principalDue + r.interestDue > r.principalPaid + r.interestPaid);
  const overdueAmount = overdueRows.reduce((s, r) => s + (r.principalDue + r.interestDue - r.principalPaid - r.interestPaid), 0);
  const daysOverdue = overdueRows.length ? daysBetween(overdueRows[0].dueDate, today) : 0;
  return { rows, outstanding: o, total: o.principal + o.interest + o.penalty, overdueAmount, daysOverdue };
}
