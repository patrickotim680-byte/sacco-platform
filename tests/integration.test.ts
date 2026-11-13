/**
 * Integration tests against the real PostgreSQL schema + triggers.
 * They create throw-away organisations (flagged is_demo) and never touch other tenants' data.
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "@/db";
import { loanApplications, loanGuarantors, savingsAccounts, transactions, users } from "@/db/schema";
import { SETUP_SQL } from "@/db/setup-sql";
import { AppError, getSettings, verifyAuditChain } from "@/lib/core";
import { createMember, createOrganisation } from "@/lib/services/org";
import * as Sv from "@/lib/services/savings";
import * as Ln from "@/lib/services/loans";
import type { Svc } from "@/lib/services/savings";
import { addMonths, todayEAT } from "@/lib/finance";

async function mkOrg(name: string, makerChecker = false) {
  return db.transaction(async (tx) => {
    const org = await createOrganisation(tx, { name: `${name} ${randomUUID().slice(0, 6)}`, type: "sacco", makerChecker, isDemo: true, planCode: "professional" });
    const mk = async (n: string) => (await tx.insert(users).values({ email: `${randomUUID()}@t.test`, fullName: n, passwordHash: "x" }).returning())[0];
    const a = await mk("Officer A"), b = await mk("Officer B");
    const svc = (u: typeof a): Svc => ({ orgId: org.id, org, actor: { userId: u.id, name: u.fullName } });
    return { org, A: svc(a), B: svc(b) };
  });
}
const gl = async (orgId: string, code: string) => Number((await db.execute(sql`select coalesce(sum(l.debit - l.credit),0) b from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.code=${code}`)).rows[0].b);
const member = async (svc: Svc, name: string, phone: string, months = 12) => {
  const m = await createMember(svc, { fullName: name, phone, joinedAt: addMonths(todayEAT(), -months) });
  const [acc] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.memberId, m.id));
  return { m, acc };
};
const rnd = () => `0772${String(Math.floor(Math.random() * 900000) + 100000)}`;

beforeAll(async () => { await pool.query(SETUP_SQL); });

describe("accounting integrity", () => {
  it("deposits post balanced journals and move the balance; ledger reconciles with sub-ledger", async () => {
    const { org, A } = await mkOrg("Acct");
    const { acc } = await member(A, "Test Saver", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 250_000, channel: "cash" });
    await Sv.deposit(A, { accountId: acc.id, amount: 100_000, channel: "mtn_momo", externalRef: "MTN-1" });
    const [row] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.id, acc.id));
    expect(Number(row.balance)).toBe(350_000);
    expect(await gl(org.id, "2000")).toBe(-350_000);
    expect(await gl(org.id, "1000")).toBe(250_000);
    expect(await gl(org.id, "1020")).toBe(100_000);
    const diff = (await db.execute(sql`select coalesce(sum(debit) - sum(credit),0) d from journal_lines where org_id=${org.id}`)).rows[0].d;
    expect(Number(diff)).toBe(0);
  });

  it("blocks duplicates unless confirmed, and duplicate provider references", async () => {
    const { A } = await mkOrg("Dup");
    const { acc } = await member(A, "Dup Saver", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 50_000, channel: "mtn_momo", externalRef: "REF-X" });
    await expect(Sv.deposit(A, { accountId: acc.id, amount: 50_000, channel: "cash" })).rejects.toThrow(/duplicate/i);
    await expect(Sv.deposit(A, { accountId: acc.id, amount: 70_000, channel: "mtn_momo", externalRef: "REF-X" })).rejects.toThrow(/already exists|duplicate/i);
    await expect(Sv.deposit(A, { accountId: acc.id, amount: 50_000, channel: "cash", confirmDuplicate: true })).resolves.toBeTruthy();
  });

  it("rejects invalid amounts and amounts above the configured transaction limit", async () => {
    const { A } = await mkOrg("Limit");
    const { acc } = await member(A, "Limit Saver", rnd());
    await expect(Sv.deposit(A, { accountId: acc.id, amount: -5, channel: "cash" })).rejects.toThrow();
    await expect(Sv.deposit(A, { accountId: acc.id, amount: 10.5, channel: "cash" })).rejects.toThrow(/whole/);
    await expect(Sv.deposit(A, { accountId: acc.id, amount: getSettings(A.org).singleTxnLimit + 1, channel: "cash" })).rejects.toThrow(/limit/);
  });

  it("withdrawals cannot exceed balance or available cash, and need approval", async () => {
    const { A } = await mkOrg("Wd");
    const { acc } = await member(A, "Wd Saver", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 100_000, channel: "cash" });
    await expect(Sv.requestWithdrawal(A, { accountId: acc.id, amount: 150_000, channel: "cash" })).rejects.toThrow(/Insufficient/);
    const r = await Sv.requestWithdrawal(A, { accountId: acc.id, amount: 60_000, channel: "cash" });
    await expect(Sv.requestWithdrawal(A, { accountId: acc.id, amount: 60_000, channel: "cash" })).rejects.toThrow(/Insufficient/); // pending request reserves funds
    await Sv.reviewWithdrawal(A, r.id, "approve");
    const [row] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.id, acc.id));
    expect(Number(row.balance)).toBe(40_000);
    await expect(Sv.reviewWithdrawal(A, r.id, "approve")).rejects.toThrow(/already/);
  });

  it("maker-checker: a user cannot approve their own withdrawal; a second officer can", async () => {
    const { org, A, B } = await mkOrg("MC", true);
    expect(getSettings(org).makerChecker).toBe(true);
    const { acc } = await member(A, "MC Saver", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 100_000, channel: "cash" });
    const r = await Sv.requestWithdrawal(A, { accountId: acc.id, amount: 30_000, channel: "cash" });
    await expect(Sv.reviewWithdrawal(A, r.id, "approve")).rejects.toThrow(/Maker-checker/);
    await expect(Sv.reviewWithdrawal(B, r.id, "approve")).resolves.toBeTruthy();
  });

  it("reversal restores balances via an equal-and-opposite journal and cannot be repeated", async () => {
    const { org, A, B } = await mkOrg("Rev", true);
    const { acc } = await member(A, "Rev Saver", rnd());
    const t = await Sv.deposit(A, { accountId: acc.id, amount: 80_000, channel: "cash" });
    await expect(Sv.reverseTransaction(A, t.id, "mistake entered")).rejects.toThrow(/Maker-checker/);
    await Sv.reverseTransaction(B, t.id, "entered on wrong account");
    const [row] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.id, acc.id));
    expect(Number(row.balance)).toBe(0);
    expect(await gl(org.id, "2000")).toBe(0);
    expect(await gl(org.id, "1000")).toBe(0);
    const [orig] = await db.select().from(transactions).where(eq(transactions.id, t.id));
    expect(orig.status).toBe("reversed");
    await expect(Sv.reverseTransaction(B, t.id, "again please")).rejects.toThrow(/already reversed/);
  });

  it("database refuses direct balance edits, deletes of journal lines/transactions, and unbalanced entries", async () => {
    const { org, A } = await mkOrg("Guard");
    const { acc } = await member(A, "Guard Saver", rnd());
    const t = await Sv.deposit(A, { accountId: acc.id, amount: 10_000, channel: "cash" });
    await expect(db.execute(sql`update savings_accounts set balance = 99999999 where id = ${acc.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from journal_lines where org_id = ${org.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from transactions where id = ${t.id}`)).rejects.toThrow();
    await expect(db.execute(sql`update transactions set amount = 1 where id = ${t.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_logs where org_id = ${org.id}`)).rejects.toThrow();
    const cash = (await db.execute(sql`select id from gl_accounts where org_id=${org.id} and code='1000'`)).rows[0].id as string;
    const inc = (await db.execute(sql`select id from gl_accounts where org_id=${org.id} and code='4030'`)).rows[0].id as string;
    let msg = "";
    try {
      await db.transaction(async (tx) => {
        const e = (await tx.execute(sql`insert into journal_entries (org_id, entry_no, entry_date, description) values (${org.id}, 'JE-BAD', current_date, 'unbalanced') returning id`)).rows[0].id as string;
        await tx.execute(sql`insert into journal_lines (org_id, entry_id, account_id, debit, credit) values (${org.id}, ${e}, ${cash}, 100, 0), (${org.id}, ${e}, ${inc}, 0, 90)`);
      });
    } catch (e) { const x = e as { message: string; cause?: { message?: string } }; msg = `${x.message} ${x.cause?.message ?? ""}`; }
    expect(msg).toMatch(/unbalanced/i);
  });

  it("manual journals must balance and cannot touch control accounts", async () => {
    const { A } = await mkOrg("Man");
    await expect(Sv.postManualJournal(A, { date: todayEAT(), description: "bad", kind: "adjustment", lines: [{ code: "5020", debit: 100, credit: 0 }, { code: "4030", debit: 0, credit: 90 }] })).rejects.toThrow(/balance/);
    await expect(Sv.postManualJournal(A, { date: todayEAT(), description: "sneaky", kind: "adjustment", lines: [{ code: "2000", debit: 100, credit: 0 }, { code: "4030", debit: 0, credit: 100 }] })).rejects.toThrow(/control/);
    await expect(Sv.postManualJournal(A, { date: todayEAT(), description: "accrual", kind: "adjustment", lines: [{ code: "5020", debit: 100, credit: 0 }, { code: "2100", debit: 0, credit: 100 }] })).resolves.toBeTruthy();
  });

  it("audit trail forms a verifiable hash chain", async () => {
    const { org, A } = await mkOrg("Audit");
    const { acc } = await member(A, "Audit Saver", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 20_000, channel: "cash" });
    const v = await verifyAuditChain(org.id);
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(1);
  });
});

describe("loan lifecycle", () => {
  it("apply, guarantee, approve, disburse, repay, settle: ledger and sub-ledger agree throughout", async () => {
    const { org, A } = await mkOrg("Loan");
    await Sv.recordCashbook(A, { kind: "income", glCode: "4030", amount: 5_000_000, channel: "cash", description: "Seed liquidity" });
    const { m, acc } = await member(A, "Borrower One", rnd());
    const { m: g } = await member(A, "Guarantor One", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 1_000_000, channel: "cash" });
    const [prod] = (await db.execute(sql`select id from loan_products where org_id=${org.id}`)).rows as { id: string }[];
    await expect(Ln.applyForLoan(A, { memberId: m.id, productId: prod.id, amount: 9_000_000, termMonths: 6 })).rejects.toThrow(/Not eligible/);
    const app = await Ln.applyForLoan(A, { memberId: m.id, productId: prod.id, amount: 2_000_000, termMonths: 6, guarantors: [{ memberId: g.id, amount: 1_000_000 }] });
    await expect(Ln.reviewApplication(A, app.id, "approved", undefined, true)).rejects.toThrow(/guarantor/);
    const [gr] = await db.select().from(loanGuarantors).where(eq(loanGuarantors.applicationId, app.id));
    await Ln.setGuarantorStatus(A, gr.id, "accepted");
    await expect(Ln.reviewApplication(A, app.id, "approved", undefined, false)).rejects.toThrow(/permission/);
    await Ln.reviewApplication(A, app.id, "approved", "ok", true);
    const { loan } = await Ln.disburseLoan(A, app.id, { channel: "cash" });
    expect(await gl(org.id, "1100")).toBe(2_000_000);
    expect(await gl(org.id, "4020")).toBe(-20_000);
    await expect(Ln.disburseLoan(A, app.id, { channel: "cash" })).rejects.toThrow(/approved/);
    const b0 = await Ln.loanBalances(loan.id);
    expect(b0.outstanding.principal).toBe(2_000_000);
    const first = b0.rows[0];
    const r1 = await Ln.repayLoan(A, loan.id, { amount: first.principalDue + first.interestDue, channel: "cash" });
    expect(r1.principal).toBe(first.principalDue);
    expect(r1.interest).toBe(first.interestDue);
    await expect(Ln.repayLoan(A, loan.id, { amount: 99_999_999, channel: "cash" })).rejects.toThrow(/exceeds/);
    const bal = await Ln.loanBalances(loan.id);
    expect(await gl(org.id, "1100")).toBe(bal.outstanding.principal);
    const settled = await Ln.settleLoanEarly(A, loan.id, "cash");
    expect(settled.closed).toBe(true);
    expect(await gl(org.id, "1100")).toBe(0);
    const after = await Ln.loanBalances(loan.id);
    expect(after.total).toBe(0);
  });

  it("penalties accrue once per period and are collected before interest", async () => {
    const { org, A } = await mkOrg("Pen");
    await Sv.recordCashbook(A, { kind: "income", glCode: "4030", amount: 5_000_000, channel: "cash", description: "Seed liquidity" });
    const { m, acc } = await member(A, "Late Payer", rnd());
    const { m: g } = await member(A, "Backer", rnd());
    await Sv.deposit(A, { accountId: acc.id, amount: 1_000_000, channel: "cash" });
    const [prod] = (await db.execute(sql`select id from loan_products where org_id=${org.id}`)).rows as { id: string }[];
    const app = await Ln.applyForLoan(A, { memberId: m.id, productId: prod.id, amount: 600_000, termMonths: 3, guarantors: [{ memberId: g.id, amount: 300_000 }] });
    const [gr] = await db.select().from(loanGuarantors).where(eq(loanGuarantors.applicationId, app.id));
    await Ln.setGuarantorStatus(A, gr.id, "accepted");
    await Ln.reviewApplication(A, app.id, "approved", "ok", true);
    const { loan } = await Ln.disburseLoan(A, app.id, { channel: "cash", date: addMonths(todayEAT(), -2) });
    const first = await Ln.accruePenalties(org.id);
    expect(first.charged).toBeGreaterThan(0);
    const again = await Ln.accruePenalties(org.id);
    expect(again.charged).toBe(0); // idempotent same day
    const b = await Ln.loanBalances(loan.id);
    expect(b.daysOverdue).toBeGreaterThan(0);
    const pen = b.outstanding.penalty;
    const r = await Ln.repayLoan(A, loan.id, { amount: pen + 1000, channel: "cash" });
    expect(r.penalty).toBe(pen);
    expect(r.interest).toBe(1000);
  });
});

describe("tenant isolation", () => {
  it("one organisation cannot read or change another organisation's records through the service layer", async () => {
    const one = await mkOrg("TenantA");
    const two = await mkOrg("TenantB");
    const { acc } = await member(one.A, "Tenant A Member", rnd());
    const t = await Sv.deposit(one.A, { accountId: acc.id, amount: 40_000, channel: "cash" });
    await expect(Sv.deposit(two.A, { accountId: acc.id, amount: 1_000, channel: "cash" })).rejects.toBeInstanceOf(AppError);
    await expect(Sv.requestWithdrawal(two.A, { accountId: acc.id, amount: 1_000, channel: "cash" })).rejects.toThrow(/not found/i);
    await expect(Sv.reverseTransaction(two.A, t.id, "attempted cross tenant")).rejects.toThrow(/not found/i);
    await expect(Ln.repayLoan(two.A, randomUUID(), { amount: 1000, channel: "cash" })).rejects.toThrow(/not found/i);
    const [row] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.id, acc.id));
    expect(Number(row.balance)).toBe(40_000);
    expect(await gl(two.org.id, "2000")).toBe(0);
    // membership numbers are per-tenant sequences
    const m2 = await member(two.A, "Tenant B Member", rnd());
    expect(m2.m.memberNo).toBe("M00001");
    // data isolation on applications
    const apps = await db.select().from(loanApplications).where(eq(loanApplications.orgId, two.org.id));
    expect(apps).toHaveLength(0);
  });
});
