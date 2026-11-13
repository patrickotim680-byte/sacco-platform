import { and, eq, sql, inArray, gte } from "drizzle-orm";
import { db } from "@/db";
import {
  contributionSchedules, fraudFlags, journalEntries, journalLines, loanRepayments, loanSchedule, loans, members, savingsAccounts,
  savingsProducts, transactions, withdrawalRequests, glAccounts,
} from "@/db/schema";
import {
  AppError, accountMap, allowLedgerWrite, audit, CHANNEL_ACCOUNT, getSettings, newRef, postJournal, type Actor, type Org, type Tx,
} from "@/lib/core";
import { addDays, addMonths, reverseLines, savingsInterest, todayEAT, daysBetween, type Line } from "@/lib/finance";
import { queueNotification } from "@/lib/services/notify";
import { ugx } from "@/lib/format";

export type Svc = { orgId: string; org: Org; actor: Actor };
export const CHANNELS = ["cash", "bank", "mtn_momo", "airtel_money", "manual"] as const;

function checkChannel(c: string) {
  if (!(CHANNELS as readonly string[]).includes(c)) throw new AppError("Unknown payment channel");
}
function checkAmount(svc: Svc, amount: number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError("Amount must be greater than zero");
  if (!Number.isInteger(amount)) throw new AppError("Amount must be a whole number of shillings");
  const s = getSettings(svc.org);
  if (amount > s.singleTxnLimit) throw new AppError(`Amount exceeds the single-transaction limit of ${ugx(s.singleTxnLimit)} set by this organisation`);
}
export async function flag(orgId: string, kind: string, detail: string, severity = "medium", transactionId?: string) {
  await db.insert(fraudFlags).values({ orgId, kind, detail, severity, transactionId });
}
async function duplicateCheck(tx: Tx, svc: Svc, f: { type: string; accountId?: string | null; loanId?: string | null; amount: number }, confirm: boolean) {
  const mins = getSettings(svc.org).duplicateWindowMinutes;
  const since = new Date(Date.now() - mins * 60000);
  const cond = [eq(transactions.orgId, svc.orgId), eq(transactions.type, f.type), eq(transactions.amount, String(f.amount)), gte(transactions.createdAt, since), eq(transactions.status, "completed")];
  if (f.accountId) cond.push(eq(transactions.accountId, f.accountId));
  if (f.loanId) cond.push(eq(transactions.loanId, f.loanId));
  const [dup] = await tx.select({ ref: transactions.reference }).from(transactions).where(and(...cond)).limit(1);
  if (dup && !confirm) throw new AppError(`Possible duplicate of ${dup.ref} (same amount within ${mins} minutes). Tick "confirm duplicate" if this is intentional.`);
  return dup?.ref ?? null;
}
export async function cashBalance(tx: Tx, orgId: string, code: string) {
  const r = await tx.execute(sql`select coalesce(sum(l.debit - l.credit),0) as bal from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.code=${code}`);
  return Number(r.rows[0].bal);
}
export async function assertFunds(tx: Tx, orgId: string, channel: string, amount: number) {
  const code = CHANNEL_ACCOUNT[channel];
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId + code}))`);
  const bal = await cashBalance(tx, orgId, code);
  if (bal < amount) throw new AppError(`Insufficient funds in the ${channel.replace("_", " ")} account (available ${ugx(bal)})`);
}

export async function insertTxn(tx: Tx, svc: Svc, v: {
  type: string; memberId?: string | null; accountId?: string | null; loanId?: string | null; amount: number; channel: string; externalRef?: string | null;
  description?: string; date?: string; metadata?: Record<string, unknown>; reversalOfId?: string;
}) {
  const reference = newRef("TX");
  const [t] = await tx.insert(transactions).values({
    orgId: svc.orgId, reference, type: v.type, memberId: v.memberId ?? null, accountId: v.accountId ?? null, loanId: v.loanId ?? null,
    amount: String(v.amount), channel: v.channel, externalRef: v.externalRef || null, description: v.description, txnDate: v.date ?? todayEAT(),
    metadata: v.metadata ?? {}, createdBy: svc.actor.userId, reversalOfId: v.reversalOfId,
  }).returning({ id: transactions.id });
  const flagLarge = v.amount >= getSettings(svc.org).largeTxnFlag && v.type !== "reversal";
  if (flagLarge) await tx.insert(fraudFlags).values({ orgId: svc.orgId, transactionId: t.id, kind: "large_amount", severity: "medium", detail: `${v.type} of ${ugx(v.amount)} (${reference}) at or above the large-transaction threshold` });
  return { id: t.id, reference };
}
export const linkJournal = (tx: Tx, txnId: string, entryId: string) => tx.update(transactions).set({ journalEntryId: entryId }).where(eq(transactions.id, txnId));

function nextDueAfter(from: string, freq: string, interval: number | null) {
  return freq === "daily" ? addDays(from, 1) : freq === "weekly" ? addDays(from, 7) : freq === "monthly" ? addMonths(from, 1) : addDays(from, interval ?? 30);
}

/* ---------------------------------- deposits ---------------------------------- */
export async function deposit(svc: Svc, i: { accountId: string; amount: number; channel: string; externalRef?: string; description?: string; date?: string; confirmDuplicate?: boolean }) {
  checkChannel(i.channel); checkAmount(svc, i.amount);
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [acc] = await tx.select().from(savingsAccounts).where(and(eq(savingsAccounts.id, i.accountId), eq(savingsAccounts.orgId, svc.orgId))).for("update");
      if (!acc) throw new AppError("Savings account not found", 404);
      if (acc.status !== "active") throw new AppError("This savings account is not active");
      const [m] = await tx.select({ status: members.status, name: members.fullName }).from(members).where(eq(members.id, acc.memberId));
      if (m.status === "exited") throw new AppError("Member has exited the organisation");
      const dup = await duplicateCheck(tx, svc, { type: "deposit", accountId: acc.id, amount: i.amount }, !!i.confirmDuplicate);
      const date = i.date ?? todayEAT();
      const t = await insertTxn(tx, svc, { type: "deposit", memberId: acc.memberId, accountId: acc.id, amount: i.amount, channel: i.channel, externalRef: i.externalRef, description: i.description || "Savings deposit", date });
      if (dup) await tx.insert(fraudFlags).values({ orgId: svc.orgId, transactionId: t.id, kind: "duplicate_override", severity: "high", detail: `Deposit ${t.reference} confirmed as intentional duplicate of ${dup}` });
      const acct = await accountMap(tx, svc.orgId);
      const je = await postJournal(tx, { orgId: svc.orgId, date, description: `Deposit ${t.reference} - ${m.name}`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId,
        lines: [{ accountId: acct(CHANNEL_ACCOUNT[i.channel]), debit: i.amount, credit: 0 }, { accountId: acct("2000"), debit: 0, credit: i.amount }] });
      await linkJournal(tx, t.id, je.id);
      await tx.update(savingsAccounts).set({ balance: sql`${savingsAccounts.balance} + ${i.amount}` }).where(eq(savingsAccounts.id, acc.id));
      // advance contribution schedule when the scheduled amount is covered
      const [sch] = await tx.select().from(contributionSchedules).where(and(eq(contributionSchedules.accountId, acc.id), eq(contributionSchedules.active, true))).for("update");
      if (sch && Number(sch.amount) > 0 && i.amount >= Number(sch.amount)) {
        const periods = Math.min(12, Math.floor(i.amount / Number(sch.amount)));
        let nd = sch.nextDue;
        for (let k = 0; k < periods; k++) nd = nextDueAfter(nd, sch.frequency, sch.intervalDays);
        await tx.update(contributionSchedules).set({ nextDue: nd }).where(eq(contributionSchedules.id, sch.id));
      }
      await audit(tx, svc.orgId, svc.actor, "savings.deposit", "transaction", t.id, { reference: t.reference, amount: i.amount, channel: i.channel, account: acc.accountNo });
      await queueNotification(tx, svc.orgId, { memberId: acc.memberId, kind: "contribution_receipt", title: "Deposit received", body: `We received ${ugx(i.amount)} into account ${acc.accountNo}. Ref ${t.reference}.` });
      return t;
    });
  } catch (e) { throw friendly(e); }
}

/* --------------------------------- withdrawals --------------------------------- */
export async function requestWithdrawal(svc: Svc, i: { accountId: string; amount: number; channel: string; reason?: string; memberIdMustBe?: string }) {
  checkChannel(i.channel); checkAmount(svc, i.amount);
  return db.transaction(async (tx) => {
    const [acc] = await tx.select().from(savingsAccounts).where(and(eq(savingsAccounts.id, i.accountId), eq(savingsAccounts.orgId, svc.orgId))).for("update");
    if (!acc || (i.memberIdMustBe && acc.memberId !== i.memberIdMustBe)) throw new AppError("Savings account not found", 404);
    if (acc.status !== "active") throw new AppError("Account is not active");
    const [m] = await tx.select({ status: members.status }).from(members).where(eq(members.id, acc.memberId));
    if (m.status !== "active") throw new AppError("Withdrawals are blocked while the member is suspended or exited");
    const [prod] = await tx.select().from(savingsProducts).where(eq(savingsProducts.id, acc.productId));
    if (prod.planType === "fixed" && acc.maturityDate && acc.maturityDate > todayEAT()) throw new AppError(`Fixed savings are locked until ${acc.maturityDate}`);
    const [pend] = await tx.select({ s: sql<string>`coalesce(sum(${withdrawalRequests.amount}),0)` }).from(withdrawalRequests).where(and(eq(withdrawalRequests.accountId, acc.id), eq(withdrawalRequests.status, "pending")));
    const available = Number(acc.balance) - Number(pend.s);
    if (i.amount > available) throw new AppError(`Insufficient balance. Available after pending requests: ${ugx(available)}`);
    const [r] = await tx.insert(withdrawalRequests).values({ orgId: svc.orgId, memberId: acc.memberId, accountId: acc.id, amount: String(i.amount), channel: i.channel, reason: i.reason, requestedBy: svc.actor.userId! }).returning({ id: withdrawalRequests.id });
    await audit(tx, svc.orgId, svc.actor, "withdrawal.requested", "withdrawal_request", r.id, { amount: i.amount, account: acc.accountNo });
    return r;
  });
}

export async function reviewWithdrawal(svc: Svc, id: string, decision: "approve" | "reject", note?: string) {
  const [pre] = await db.select().from(withdrawalRequests).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.orgId, svc.orgId)));
  if (!pre) throw new AppError("Request not found", 404);
  if (decision === "approve" && getSettings(svc.org).makerChecker && pre.requestedBy === svc.actor.userId) {
    await flag(svc.orgId, "self_approval_blocked", `User attempted to approve their own withdrawal request ${id}`, "high");
    throw new AppError("Maker-checker: you cannot approve a withdrawal you requested yourself");
  }
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [r] = await tx.select().from(withdrawalRequests).where(and(eq(withdrawalRequests.id, id), eq(withdrawalRequests.orgId, svc.orgId))).for("update");
      if (r.status !== "pending") throw new AppError("This request has already been processed");
      if (decision === "reject") {
        await tx.update(withdrawalRequests).set({ status: "rejected", reviewedBy: svc.actor.userId, reviewNote: note, reviewedAt: new Date() }).where(eq(withdrawalRequests.id, id));
        await audit(tx, svc.orgId, svc.actor, "withdrawal.rejected", "withdrawal_request", id, { note });
        await queueNotification(tx, svc.orgId, { memberId: r.memberId, kind: "withdrawal_update", title: "Withdrawal declined", body: `Your withdrawal request of ${ugx(r.amount)} was declined.${note ? " Reason: " + note : ""}` });
        return { reference: null };
      }
      const amount = Number(r.amount);
      const [acc] = await tx.select().from(savingsAccounts).where(eq(savingsAccounts.id, r.accountId)).for("update");
      if (Number(acc.balance) < amount) throw new AppError("Insufficient account balance to approve this withdrawal");
      await assertFunds(tx, svc.orgId, r.channel, amount);
      const t = await insertTxn(tx, svc, { type: "withdrawal", memberId: r.memberId, accountId: acc.id, amount, channel: r.channel, description: r.reason || "Savings withdrawal", metadata: { requestId: r.id } });
      const acct = await accountMap(tx, svc.orgId);
      const je = await postJournal(tx, { orgId: svc.orgId, date: todayEAT(), description: `Withdrawal ${t.reference}`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId,
        lines: [{ accountId: acct("2000"), debit: amount, credit: 0 }, { accountId: acct(CHANNEL_ACCOUNT[r.channel]), debit: 0, credit: amount }] });
      await linkJournal(tx, t.id, je.id);
      await tx.update(savingsAccounts).set({ balance: sql`${savingsAccounts.balance} - ${amount}` }).where(eq(savingsAccounts.id, acc.id));
      await tx.update(withdrawalRequests).set({ status: "approved", reviewedBy: svc.actor.userId, reviewNote: note, reviewedAt: new Date(), transactionId: t.id }).where(eq(withdrawalRequests.id, id));
      // rapid withdrawal pattern
      const [c] = await tx.select({ n: sql<number>`count(*)` }).from(transactions).where(and(eq(transactions.memberId, r.memberId), eq(transactions.type, "withdrawal"), gte(transactions.createdAt, new Date(Date.now() - 864e5))));
      if (Number(c.n) >= 3) await tx.insert(fraudFlags).values({ orgId: svc.orgId, transactionId: t.id, kind: "rapid_withdrawals", severity: "high", detail: `${c.n} withdrawals by the same member within 24 hours` });
      await audit(tx, svc.orgId, svc.actor, "withdrawal.approved", "withdrawal_request", id, { reference: t.reference, amount });
      await queueNotification(tx, svc.orgId, { memberId: r.memberId, kind: "withdrawal_update", title: "Withdrawal approved", body: `Your withdrawal of ${ugx(amount)} was approved and paid via ${r.channel.replace("_", " ")}. Ref ${t.reference}.` });
      return t;
    });
  } catch (e) { throw friendly(e); }
}

/* --------------------------------- reversal --------------------------------- */
export async function reverseTransaction(svc: Svc, txnId: string, reason: string) {
  if (!reason || reason.trim().length < 5) throw new AppError("A reason of at least 5 characters is required to reverse a transaction");
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [t] = await tx.select().from(transactions).where(and(eq(transactions.id, txnId), eq(transactions.orgId, svc.orgId))).for("update");
      if (!t) throw new AppError("Transaction not found", 404);
      if (t.status !== "completed") throw new AppError("Transaction is already reversed");
      if (t.type === "reversal") throw new AppError("A reversal cannot itself be reversed");
      if (t.type === "loan_disbursement") throw new AppError("Disbursements cannot be reversed. Use loan restructuring or write-off.");
      if (getSettings(svc.org).makerChecker && t.createdBy === svc.actor.userId) {
        await flag(svc.orgId, "self_approval_blocked", `User attempted to reverse their own transaction ${t.reference}`, "high", t.id);
        throw new AppError("Maker-checker: a different officer must reverse a transaction you posted");
      }
      const orig = await tx.select({ l: journalLines }).from(journalLines).where(eq(journalLines.entryId, t.journalEntryId!));
      const lines: Line[] = orig.map(({ l }) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined }));
      const amount = Number(t.amount);
      // cash going back out must exist
      const cashDebitedOriginally = t.type === "deposit" || t.type === "loan_repayment" || t.type === "income";
      if (cashDebitedOriginally) await assertFunds(tx, svc.orgId, t.channel, amount);
      const rev = await insertTxn(tx, svc, { type: "reversal", memberId: t.memberId, accountId: t.accountId, loanId: t.loanId, amount, channel: t.channel, description: `Reversal of ${t.reference}: ${reason}`, reversalOfId: t.id, metadata: { originalType: t.type, reason } });
      const je = await postJournal(tx, { orgId: svc.orgId, date: todayEAT(), description: `Reversal of ${t.reference}: ${reason}`, source: "reversal", sourceType: "transaction", sourceId: rev.id, reversalOfId: t.journalEntryId ?? undefined, createdBy: svc.actor.userId, lines: reverseLines(lines) });
      await linkJournal(tx, rev.id, je.id);
      if (t.accountId && ["deposit", "interest"].includes(t.type)) {
        await tx.update(savingsAccounts).set({ balance: sql`${savingsAccounts.balance} - ${amount}` }).where(eq(savingsAccounts.id, t.accountId));
      } else if (t.accountId && t.type === "withdrawal") {
        await tx.update(savingsAccounts).set({ balance: sql`${savingsAccounts.balance} + ${amount}` }).where(eq(savingsAccounts.id, t.accountId));
      } else if (t.type === "loan_repayment" && t.loanId) {
        const [rep] = await tx.select().from(loanRepayments).where(eq(loanRepayments.transactionId, t.id));
        if (rep) {
          for (const a of rep.allocation) {
            await tx.update(loanSchedule).set({
              principalPaid: sql`${loanSchedule.principalPaid} - ${a.principal}`, interestPaid: sql`${loanSchedule.interestPaid} - ${a.interest}`,
              penaltyPaid: sql`${loanSchedule.penaltyPaid} - ${a.penalty}`, status: "partial",
            }).where(eq(loanSchedule.id, a.scheduleId));
          }
          await tx.update(loanSchedule).set({ status: "pending" }).where(and(eq(loanSchedule.loanId, t.loanId), eq(loanSchedule.principalPaid, "0"), eq(loanSchedule.interestPaid, "0"), eq(loanSchedule.penaltyPaid, "0"), eq(loanSchedule.status, "partial")));
          await tx.update(loans).set({
            principalPaid: sql`${loans.principalPaid} - ${rep.principal}`, interestPaid: sql`${loans.interestPaid} - ${rep.interest}`, penaltyPaid: sql`${loans.penaltyPaid} - ${rep.penalty}`,
            status: sql`case when ${loans.status} = 'closed' then 'active' else ${loans.status} end`,
          }).where(eq(loans.id, t.loanId));
          await tx.update(loanRepayments).set({ reversed: true }).where(eq(loanRepayments.id, rep.id));
        }
      }
      await tx.update(transactions).set({ status: "reversed" }).where(eq(transactions.id, t.id));
      await audit(tx, svc.orgId, svc.actor, "transaction.reversed", "transaction", t.id, { reference: t.reference, reason, reversal: rev.reference, amount });
      return rev;
    });
  } catch (e) { throw friendly(e); }
}

/* --------------------------------- interest on savings --------------------------------- */
export async function postSavingsInterest(svc: Svc, period: string) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError("Period must be YYYY-MM");
  const [y, mo] = period.split("-").map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const periodEnd = `${period}-${String(days).padStart(2, "0")}`;
  if (periodEnd > todayEAT()) throw new AppError("Interest can only be posted after the period has ended");
  return db.transaction(async (tx) => {
    await allowLedgerWrite(tx);
    const accs = await tx.select({ a: savingsAccounts, rate: savingsProducts.interestRate }).from(savingsAccounts)
      .innerJoin(savingsProducts, eq(savingsProducts.id, savingsAccounts.productId))
      .where(and(eq(savingsAccounts.orgId, svc.orgId), eq(savingsAccounts.status, "active"), sql`${savingsProducts.interestRate} > 0`, sql`${savingsAccounts.balance} > 0`)).for("update", { of: savingsAccounts });
    const acct = await accountMap(tx, svc.orgId);
    let count = 0, total = 0;
    for (const { a, rate } of accs) {
      const ref = `INT-${a.id}-${period}`;
      const [exists] = await tx.select({ id: transactions.id }).from(transactions).where(and(eq(transactions.orgId, svc.orgId), eq(transactions.externalRef, ref), eq(transactions.status, "completed"))).limit(1);
      if (exists) continue;
      const amt = savingsInterest(Number(a.balance), Number(rate), days);
      if (amt <= 0) continue;
      const t = await insertTxn(tx, svc, { type: "interest", memberId: a.memberId, accountId: a.id, amount: amt, channel: "manual", externalRef: ref, description: `Savings interest ${period}`, date: periodEnd });
      const je = await postJournal(tx, { orgId: svc.orgId, date: periodEnd, description: `Savings interest ${period} ${a.accountNo}`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId,
        lines: [{ accountId: acct("5030"), debit: amt, credit: 0 }, { accountId: acct("2000"), debit: 0, credit: amt }] });
      await linkJournal(tx, t.id, je.id);
      await tx.update(savingsAccounts).set({ balance: sql`${savingsAccounts.balance} + ${amt}` }).where(eq(savingsAccounts.id, a.id));
      count++; total += amt;
    }
    await audit(tx, svc.orgId, svc.actor, "savings.interest_posted", "period", period, { accounts: count, total });
    return { count, total };
  });
}

/* --------------------------------- cashbook & journals --------------------------------- */
export async function recordCashbook(svc: Svc, i: { kind: "income" | "expense"; glCode: string; amount: number; channel: string; description: string; date?: string; payee?: string }) {
  checkChannel(i.channel); checkAmount(svc, i.amount);
  if (!i.description.trim()) throw new AppError("Description is required");
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [gl] = await tx.select().from(glAccounts).where(and(eq(glAccounts.orgId, svc.orgId), eq(glAccounts.code, i.glCode)));
      if (!gl || gl.type !== i.kind) throw new AppError(`Select a valid ${i.kind} account`);
      if (i.kind === "expense") await assertFunds(tx, svc.orgId, i.channel, i.amount);
      const date = i.date ?? todayEAT();
      const t = await insertTxn(tx, svc, { type: i.kind, amount: i.amount, channel: i.channel, description: i.description, date, metadata: { payee: i.payee ?? null, glCode: i.glCode } });
      const acct = await accountMap(tx, svc.orgId);
      const cash = acct(CHANNEL_ACCOUNT[i.channel]);
      const lines: Line[] = i.kind === "income"
        ? [{ accountId: cash, debit: i.amount, credit: 0 }, { accountId: gl.id, debit: 0, credit: i.amount }]
        : [{ accountId: gl.id, debit: i.amount, credit: 0 }, { accountId: cash, debit: 0, credit: i.amount }];
      const je = await postJournal(tx, { orgId: svc.orgId, date, description: `${i.description} (${t.reference})`, sourceType: "transaction", sourceId: t.id, createdBy: svc.actor.userId, lines });
      await linkJournal(tx, t.id, je.id);
      await audit(tx, svc.orgId, svc.actor, `cashbook.${i.kind}`, "transaction", t.id, { reference: t.reference, amount: i.amount, glCode: i.glCode });
      return t;
    });
  } catch (e) { throw friendly(e); }
}

export async function postManualJournal(svc: Svc, i: { date: string; description: string; lines: { code: string; debit: number; credit: number; memo?: string }[]; kind: "manual" | "adjustment" }) {
  if (!i.description.trim()) throw new AppError("Description is required");
  return db.transaction(async (tx) => {
    const PROTECTED = ["1000", "1010", "1020", "1030", "2000", "1100", "1150"];
    const touched = i.lines.filter((l) => l.debit > 0 || l.credit > 0).map((l) => l.code);
    if (touched.some((c) => PROTECTED.includes(c))) throw new AppError("Cash, member savings and loan control accounts cannot be adjusted by manual journals. Use deposits, withdrawals, repayments or the cashbook so sub-ledgers stay reconciled.");
    const acct = await accountMap(tx, svc.orgId);
    const lines: Line[] = i.lines.filter((l) => l.debit > 0 || l.credit > 0).map((l) => ({ accountId: acct(l.code), debit: l.debit, credit: l.credit, memo: l.memo }));
    for (const l of lines) if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit)) throw new AppError("Amounts must be whole shillings");
    const je = await postJournal(tx, { orgId: svc.orgId, date: i.date, description: i.description, source: i.kind, createdBy: svc.actor.userId, lines });
    await audit(tx, svc.orgId, svc.actor, `journal.${i.kind}`, "journal_entry", je.id, { entryNo: je.entryNo, lines: i.lines.length });
    return je;
  });
}

export async function reverseJournal(svc: Svc, entryId: string, reason: string) {
  if (reason.trim().length < 5) throw new AppError("A reason is required");
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(journalEntries).where(and(eq(journalEntries.id, entryId), eq(journalEntries.orgId, svc.orgId)));
    if (!e) throw new AppError("Entry not found", 404);
    if (e.sourceType === "transaction") throw new AppError("This entry belongs to a transaction. Reverse the transaction instead.");
    if (e.reversalOfId) throw new AppError("A reversal cannot be reversed");
    const [already] = await tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.reversalOfId, entryId));
    if (already) throw new AppError("Entry has already been reversed");
    const ls = await tx.select().from(journalLines).where(eq(journalLines.entryId, entryId));
    const je = await postJournal(tx, { orgId: svc.orgId, date: todayEAT(), description: `Reversal of ${e.entryNo}: ${reason}`, source: "reversal", reversalOfId: e.id, createdBy: svc.actor.userId,
      lines: reverseLines(ls.map((l) => ({ accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit), memo: l.memo ?? undefined }))) });
    await audit(tx, svc.orgId, svc.actor, "journal.reversed", "journal_entry", e.id, { entryNo: e.entryNo, reason, reversal: je.entryNo });
    return je;
  });
}

/* --------------------------------- automation: contribution alerts --------------------------------- */
export async function runContributionAlerts(orgId: string) {
  const today = todayEAT();
  const rows = await db.select({ s: contributionSchedules, name: members.fullName }).from(contributionSchedules)
    .innerJoin(members, eq(members.id, contributionSchedules.memberId))
    .where(and(eq(contributionSchedules.orgId, orgId), eq(contributionSchedules.active, true), sql`${contributionSchedules.nextDue} <= ${today}`, eq(members.status, "active")));
  let n = 0;
  await db.transaction(async (tx) => {
    for (const { s } of rows) {
      const missed = s.nextDue < today;
      const days = daysBetween(s.nextDue, today);
      await queueNotification(tx, orgId, {
        memberId: s.memberId, kind: missed ? "missed_payment" : "contribution_reminder",
        title: missed ? "Missed contribution" : "Contribution due today",
        body: missed ? `Your contribution of ${ugx(s.amount)} was due on ${s.nextDue} (${days} day(s) ago). Please pay to stay in good standing.` : `Your contribution of ${ugx(s.amount)} is due today.`,
        dedupeKey: `contrib:${s.id}:${today}`,
      });
      n++;
    }
  });
  return n;
}

/** Map low-level DB errors to messages that are safe and helpful to display. */
export function friendly(e: unknown): Error {
  if (e instanceof AppError) return e;
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string; constraint?: string } };
  const code = err.code ?? err.cause?.code;
  const msg = err.cause?.message ?? err.message ?? "";
  if (code === "23505") return new AppError("A record with this unique reference already exists (possible duplicate).");
  if (code === "23514") {
    if (/sa_balance_nonneg/.test(msg + (err.cause?.constraint ?? ""))) return new AppError("Operation would make the savings balance negative.");
    return new AppError("Operation violates a financial integrity rule.");
  }
  if (code === "P0001") return new AppError(msg.replace(/^error: /i, ""));
  return e as Error;
}
