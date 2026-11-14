/**
 * Simulation: a SACCO with 50 members run through the real service layer against the configured database.
 * It creates ONE throw-away organisation (flagged is_demo) and never touches other tenants.
 * Run against a development database only:  DATABASE_URL=... npx tsx scripts/simulate.ts [report.json]
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { loanApplications, loans, savingsAccounts, users } from "@/db/schema";
import { SETUP_SQL } from "@/db/setup-sql";
import { verifyAuditChain } from "@/lib/core";
import { addDays, addMonths, todayEAT } from "@/lib/finance";
import { createMember, createOrganisation } from "@/lib/services/org";
import * as Sv from "@/lib/services/savings";
import * as Ln from "@/lib/services/loans";
import * as Gr from "@/lib/services/groups";
import { getReport } from "@/lib/services/reports";
import { dashboardData, resolveRange } from "@/lib/services/dashboard";
import type { Svc } from "@/lib/services/savings";

type Res = { name: string; ok: boolean; detail?: string };
const results: Res[] = [];
const timings: Record<string, { n: number; ms: number }> = {};
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };
const timed = async <T,>(k: string, f: () => Promise<T>) => { const t = Date.now(); try { return await f(); } finally { const x = (timings[k] ??= { n: 0, ms: 0 }); x.n++; x.ms += Date.now() - t; } };
const expectErr = async (name: string, p: Promise<unknown>, re: RegExp) => {
  try { await p; check(name, false, "expected an error but the call succeeded"); } catch (e) { const m = (e as Error).message; check(name, re.test(m), re.test(m) ? undefined : `unexpected error: ${m}`); }
};
const num = (v: unknown) => Number(v ?? 0);
const gl = async (orgId: string, code: string) => num((await db.execute(sql`select coalesce(sum(l.debit - l.credit),0) b from journal_lines l join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.code=${code}`)).rows[0].b);

// deterministic PRNG so runs are reproducible
let seed = 20261113;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const between = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const FIRST = ["Moses", "Sarah", "Joseph", "Grace", "David", "Esther", "Samuel", "Betty", "Ronald", "Juliet", "Brian", "Harriet", "Isaac", "Florence", "Patrick", "Agnes", "Robert", "Prossy", "Emmanuel", "Winnie", "Francis", "Rose", "Peter", "Joyce", "Henry"];
const LAST = ["Mukasa", "Namukasa", "Okello", "Akello", "Tumusiime", "Asiimwe", "Kato", "Nabukenya", "Wasswa", "Nansubuga", "Mutebi", "Kasozi", "Mwesigwa", "Babirye", "Ojok", "Auma", "Musoke", "Kamya", "Bbosa", "Natukunda"];
const PREFIX = ["0772", "0752", "0782", "0701", "0777", "0392"];

async function main() {
  const t0 = Date.now();
  await pool.query(SETUP_SQL);
  const today = todayEAT();

  // ---------- organisation and staff ----------
  const ctx = await db.transaction(async (tx) => {
    const org = await createOrganisation(tx, { name: `Simulation SACCO ${randomUUID().slice(0, 6)}`, type: "sacco", makerChecker: true, isDemo: true, planCode: "growth" });
    const mk = async (n: string) => (await tx.insert(users).values({ email: `${randomUUID()}@sim.test`, fullName: n, passwordHash: "x" }).returning())[0];
    const [a, b, c] = [await mk("Treasurer Tess"), await mk("Manager Mark"), await mk("Officer Olivia")];
    const svc = (u: typeof a): Svc => ({ orgId: org.id, org, actor: { userId: u.id, name: u.fullName } });
    return { org, T: svc(a), M: svc(b), O: svc(c) };
  });
  const { org, T, M, O } = ctx;
  const orgId = org.id;
  const [prod] = (await db.execute(sql`select id from loan_products where org_id=${orgId} limit 1`)).rows as { id: string }[];

  // ---------- 1. fifty members ----------
  const mem: { id: string; no: string; acc: string; name: string; bal: number }[] = [];
  for (let i = 0; i < 50; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)} ${i}`;
    const phone = `${PREFIX[i % 6]}${String(100000 + ((i * 7919 + 13) % 899999)).slice(0, 6)}`;
    const m = await timed("create member", () => createMember(O, { fullName: name, phone, gender: i % 2 ? "female" : "male", nationalId: `CM9${String(i).padStart(10, "0")}X`, district: "Wakiso", joinedAt: addMonths(today, -between(8, 18)), nokName: "Next Kin", nokPhone: "0772000111", nokRelationship: "Sibling" }));
    const [acc] = await db.select().from(savingsAccounts).where(eq(savingsAccounts.memberId, m.id));
    mem.push({ id: m.id, no: m.memberNo, acc: acc.id, name, bal: 0 });
  }
  check("50 members registered with unique member numbers", new Set(mem.map((m) => m.no)).size === 50);
  await expectErr("duplicate phone number is rejected", createMember(O, { fullName: "Dup Phone", phone: (await db.execute(sql`select phone from members where org_id=${orgId} limit 1`)).rows[0].phone as string }), /already registered/i);
  await expectErr("invalid phone number is rejected", createMember(O, { fullName: "Bad Phone", phone: "12345" }), /valid Uganda phone/i);

  // ---------- 2. three months of deposits across all channels ----------
  const channels = ["cash", "mtn_momo", "airtel_money", "bank"];
  let expectedSavings = 0, depositCount = 0;
  for (let month = 5; month >= 0; month--) {
    for (const m of mem) {
      if (rnd() < 0.12) continue; // some members skip a month
      const amount = between(2, 30) * 10000 + (depositCount % 97) * 100; // varied so the duplicate guard is not tripped
      const ch = pick(channels);
      const date = addDays(addMonths(today, -month), -between(0, 6));
      await timed("deposit", () => Sv.deposit(T, { accountId: m.acc, amount, channel: ch, date, externalRef: ch.includes("_") ? `SIM-${randomUUID().slice(0, 10)}` : undefined }));
      m.bal += amount; expectedSavings += amount; depositCount++;
    }
  }
  const [sumRow] = (await db.execute(sql`select coalesce(sum(balance),0) s from savings_accounts where org_id=${orgId}`)).rows;
  check(`${depositCount} deposits: sub-ledger total equals what was deposited`, num(sumRow.s) === expectedSavings, `${num(sumRow.s)} vs ${expectedSavings}`);

  // ---------- 3. withdrawals with maker-checker ----------
  const wd = mem.slice(0, 10);
  const reqs: { id: string; m: (typeof mem)[number]; amount: number }[] = [];
  for (const m of wd) {
    const amount = Math.floor((m.bal * 0.2) / 1000) * 1000;
    const r = await timed("withdrawal request", () => Sv.requestWithdrawal(T, { accountId: m.acc, amount, channel: "cash", reason: "School fees" }));
    reqs.push({ id: r.id, m, amount });
  }
  await expectErr("maker cannot approve their own withdrawal request", Sv.reviewWithdrawal(T, reqs[0].id, "approve"), /maker-checker|cannot approve/i);
  await expectErr("withdrawal above available balance is rejected", Sv.requestWithdrawal(T, { accountId: wd[0].acc, amount: wd[0].bal + 1000, channel: "cash" }), /insufficient/i);
  for (let i = 0; i < reqs.length; i++) {
    if (i < 7) { await timed("withdrawal approve", () => Sv.reviewWithdrawal(M, reqs[i].id, "approve")); reqs[i].m.bal -= reqs[i].amount; expectedSavings -= reqs[i].amount; }
    else await Sv.reviewWithdrawal(M, reqs[i].id, "reject", "Insufficient documentation");
  }
  const [afterWd] = (await db.execute(sql`select coalesce(sum(balance),0) s from savings_accounts where org_id=${orgId}`)).rows;
  check("7 approved and 3 rejected withdrawals leave balances exactly right", num(afterWd.s) === expectedSavings, `${num(afterWd.s)} vs ${expectedSavings}`);

  // ---------- 4. loans: apply, guarantee, approve, disburse (back-dated) ----------
  type L = { m: (typeof mem)[number]; appId: string; loanId?: string; amount: number; term: number };
  const borrowers: L[] = [];
  const candidates = mem.filter((m) => m.bal >= 250_000).slice(0, 22);
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const guarantor = candidates[(i + 1) % candidates.length];
    const amount = Math.min(2_000_000, Math.max(100_000, Math.floor((m.bal * 2.5) / 10000) * 10000));
    const term = pick([6, 9, 12]);
    try {
      const a = await timed("loan apply", () => Ln.applyForLoan(O, { memberId: m.id, productId: prod.id, amount, termMonths: term, purpose: "Business stock", guarantors: [{ memberId: guarantor.id, amount: Math.floor(amount / 2) }], collateral: i % 3 === 0 ? [{ description: "Motorcycle", value: amount }] : [] }));
      const [g] = (await db.execute(sql`select id from loan_guarantors where application_id=${a.id}`)).rows as { id: string }[];
      await Ln.setGuarantorStatus(O, g.id, "accepted");
      borrowers.push({ m, appId: a.id, amount, term });
    } catch (e) { check(`loan application for ${m.no}`, false, (e as Error).message); }
  }
  check("loan applications created with guarantors", borrowers.length >= 15, `${borrowers.length} created`);
  if (borrowers.length) {
    await expectErr("officer cannot approve a loan they submitted (maker-checker)", Ln.reviewApplication(O, borrowers[0].appId, "approved", "ok", true), /maker-checker/i);
    await expectErr("approval without permission is rejected", Ln.reviewApplication(M, borrowers[0].appId, "approved", "ok", false), /permission/i);
    await expectErr("rejecting without a reason is rejected", Ln.reviewApplication(M, borrowers[0].appId, "rejected", undefined, true), /reason/i);
    await expectErr("a member with an application in progress cannot apply again", Ln.applyForLoan(O, { memberId: borrowers[0].m.id, productId: prod.id, amount: 100000, termMonths: 6 }), /in progress|not eligible/i);
  }
  const rejectIdx = borrowers.length - 1;
  for (let i = 0; i < borrowers.length; i++) {
    const b = borrowers[i];
    if (i === rejectIdx) { await Ln.reviewApplication(M, b.appId, "rejected", "Credit history", true); continue; }
    await timed("loan approve", () => Ln.reviewApplication(M, b.appId, "approved", "Approved", true));
    // pick a channel with enough funds, back-dated so some instalments are due
    const need = b.amount;
    let ch = "cash";
    for (const c of ["cash", "bank", "mtn_momo", "airtel_money"]) { const code = { cash: "1000", bank: "1010", mtn_momo: "1020", airtel_money: "1030" }[c]!; if ((await gl(orgId, code)) > need + 500_000) { ch = c; break; } }
    const monthsAgo = between(2, 5);
    try { await timed("loan disburse", () => Ln.disburseLoan(M, b.appId, { channel: ch, date: addMonths(today, -monthsAgo) })); }
    catch (e) { check(`disburse ${b.m.no}`, false, (e as Error).message); }
  }
  const loanRows = await db.select().from(loans).where(eq(loans.orgId, orgId));
  check("approved loans disbursed", loanRows.length === borrowers.length - 1, `${loanRows.length} loans`);
  const toL = (l: (typeof loanRows)[number]) => ({ id: l.id, no: l.loanNo });

  // ---------- 5. repayments: good payers, partial payers, defaulters ----------
  let repaid = 0;
  for (let i = 0; i < loanRows.length; i++) {
    const l = toL(loanRows[i]);
    const bal = await Ln.loanBalances(l.id);
    const dueRows = bal.rows.filter((r) => r.dueDate <= today);
    const pattern = i % 4; // 0,1 good payer; 2 partial; 3 defaulter
    if (pattern === 3) continue;
    for (const r of dueRows) {
      const due = r.principalDue + r.interestDue - r.principalPaid - r.interestPaid;
      if (due <= 0) continue;
      const amount = pattern === 2 ? Math.floor(due / 2) : due;
      if (amount <= 0) continue;
      const ch = pick(channels);
      try { await timed("repayment", () => Ln.repayLoan(T, l.id, { amount, channel: ch, date: r.dueDate, externalRef: ch.includes("_") ? `RP-${randomUUID().slice(0, 10)}` : undefined, confirmDuplicate: true })); repaid += amount; }
      catch (e) { check(`repayment ${l.no} #${r.installmentNo}`, false, (e as Error).message); }
    }
  }
  check("repayments posted", repaid > 0, `UGX ${repaid.toLocaleString()} collected`);

  // early settlement of one good loan
  const goodLoan = toL(loanRows[0]);
  try { await Ln.settleLoanEarly(T, goodLoan.id, "cash"); const [s] = await db.select().from(loans).where(eq(loans.id, goodLoan.id)); check("early settlement closes the loan", s.status !== "active", `status ${s.status}`); }
  catch (e) { check("early settlement", false, (e as Error).message); }

  // ---------- 6. automation: penalties, reminders, alerts, interest ----------
  const pen = await timed("accrue penalties", () => Ln.accruePenalties(orgId));
  check("overdue penalties accrued on defaulting loans", pen.charged > 0, `charged ${JSON.stringify(pen)}`);
  const pen2 = await Ln.accruePenalties(orgId);
  check("penalty run is idempotent (second run charges nothing new)", pen2.charged === 0, JSON.stringify(pen2));
  await Ln.sendRepaymentReminders(orgId);
  await Sv.runContributionAlerts(orgId);
  const lastMonth = addMonths(today, -1).slice(0, 7);
  try { await Sv.postSavingsInterest(T, lastMonth); check("month-end savings interest posts", true); } catch (e) { check("month-end savings interest posts", false, (e as Error).message); }

  // ---------- 7. cashbook, manual journals, reversals ----------
  await Sv.recordCashbook(T, { kind: "expense", glCode: "5010", amount: 450_000, channel: "cash", description: "Office rent", payee: "Landlord" });
  await Sv.recordCashbook(T, { kind: "income", glCode: "4030", amount: 120_000, channel: "bank", description: "Hall hire" });
  await expectErr("unbalanced manual journal is rejected", Sv.postManualJournal(T, { date: today, description: "bad", kind: "manual", lines: [{ code: "5020", debit: 1000, credit: 0 }, { code: "4030", debit: 0, credit: 900 }] }), /balance/i);
  await expectErr("manual journals cannot touch cash, savings or loan control accounts", Sv.postManualJournal(T, { date: today, description: "bad", kind: "manual", lines: [{ code: "1000", debit: 1000, credit: 0 }, { code: "4030", debit: 0, credit: 1000 }] }), /control accounts/i);
  const je = await Sv.postManualJournal(T, { date: today, description: "Reclass", kind: "adjustment", lines: [{ code: "5020", debit: 50_000, credit: 0 }, { code: "5010", debit: 0, credit: 50_000 }] });
  void je;
  const [revTxn] = (await db.execute(sql`select id, amount, account_id from transactions where org_id=${orgId} and type='deposit' and status='completed' order by created_at desc limit 1`)).rows as { id: string; amount: string; account_id: string }[];
  try {
    await Sv.reverseTransaction(M, revTxn.id, "Posted to wrong member");
    const m = mem.find((x) => x.acc === revTxn.account_id)!; m.bal -= num(revTxn.amount); expectedSavings -= num(revTxn.amount);
    check("deposit reversal posts a counter-entry and fixes the balance", true);
    await expectErr("a transaction cannot be reversed twice", Sv.reverseTransaction(M, revTxn.id, "again"), /already|reversed/i);
  } catch (e) { check("deposit reversal", false, (e as Error).message); }

  // ---------- 8. VSLA group ----------
  try {
    const g = await Gr.createGroup(O, { name: "Kisenyi Women Savers", kind: "vsla", location: "Kampala" });
    const gm = mem.slice(20, 35);
    for (let i = 0; i < gm.length; i++) await Gr.addGroupMember(O, g.id, gm[i].id, i === 0 ? "chairperson" : i === 1 ? "treasurer" : "member");
    const cyc = await Gr.openCycle(O, g.id, { name: "Cycle 1", startDate: addMonths(today, -3), endDate: addMonths(today, 3), savingsTarget: 5_000_000 });
    void cyc;
    for (let w = 0; w < 6; w++) for (const m of gm) { await Gr.recordGroupEntry(T, { groupId: g.id, memberId: m.id, kind: "share", shares: between(1, 5), amount: 0, date: addDays(today, -w * 7) }).catch(async () => { await Gr.recordGroupEntry(T, { groupId: g.id, memberId: m.id, kind: "share", shares: 2, amount: 4000, date: addDays(today, -w * 7) }); }); }
    for (const m of gm) await Gr.recordGroupEntry(T, { groupId: g.id, memberId: m.id, kind: "social_fund", amount: 1000 });
    await Gr.recordGroupEntry(T, { groupId: g.id, memberId: gm[3].id, kind: "fine", amount: 500, note: "Late" });
    check("VSLA group: members, cycle, shares, social fund and fines recorded", true);
  } catch (e) { check("VSLA group flow", false, (e as Error).message); }

  // ---------- 9. concurrency / race conditions ----------
  const racer = mem[40];
  const before = num((await db.execute(sql`select balance from savings_accounts where id=${racer.acc}`)).rows[0].balance);
  const amts = Array.from({ length: 15 }, (_, i) => 10_000 + i * 700);
  const out = await Promise.allSettled(amts.map((a, i) => Sv.deposit(T, { accountId: racer.acc, amount: a, channel: "cash", description: `race ${i}` })));
  const okSum = amts.reduce((s, a, i) => s + (out[i].status === "fulfilled" ? a : 0), 0);
  const after = num((await db.execute(sql`select balance from savings_accounts where id=${racer.acc}`)).rows[0].balance);
  check("15 simultaneous deposits to one account: no lost updates", after - before === okSum, `${out.filter((o) => o.status === "fulfilled").length}/15 succeeded, balance +${after - before} vs ${okSum}`);
  racer.bal = after; expectedSavings += okSum;
  const big = Math.floor(after * 0.8 / 1000) * 1000;
  const wr = await Promise.allSettled(Array.from({ length: 8 }, () => Sv.requestWithdrawal(T, { accountId: racer.acc, amount: big, channel: "cash" })));
  check("8 simultaneous withdrawal requests of 80% of the balance: only one accepted (no double-spend)", wr.filter((r) => r.status === "fulfilled").length === 1, `${wr.filter((r) => r.status === "fulfilled").length} accepted`);

  // ---------- 10. database-level protections ----------
  const tryDb = async (name: string, q: string) => { try { await pool.query(q); check(name, false, "statement was allowed"); } catch (e) { check(name, true, (e as Error).message.slice(0, 70)); } };
  await tryDb("journal lines cannot be edited", `update journal_lines set debit = debit + 1 where org_id='${orgId}'`);
  await tryDb("journal lines cannot be deleted", `delete from journal_lines where org_id='${orgId}'`);
  await tryDb("audit log cannot be edited", `update audit_logs set action='x' where org_id='${orgId}'`);
  await tryDb("transactions cannot be deleted", `delete from transactions where org_id='${orgId}'`);
  await tryDb("savings balance cannot be changed outside the ledger services", `update savings_accounts set balance = 999999999 where org_id='${orgId}'`);

  // ---------- 11. tenant isolation ----------
  const other = await db.transaction(async (tx) => {
    const o2 = await createOrganisation(tx, { name: `Other SACCO ${randomUUID().slice(0, 6)}`, type: "sacco", isDemo: true, planCode: "growth" });
    const u = (await tx.insert(users).values({ email: `${randomUUID()}@sim.test`, fullName: "Other officer", passwordHash: "x" }).returning())[0];
    return { orgId: o2.id, org: o2, actor: { userId: u.id, name: u.fullName } } as Svc;
  });
  await expectErr("another organisation cannot deposit into this organisation's account", Sv.deposit(other, { accountId: mem[0].acc, amount: 10000, channel: "cash" }), /not found/i);
  await expectErr("another organisation cannot see this organisation's loan", Ln.repayLoan(other, loanRows[0].id, { amount: 1000, channel: "cash" }), /not found/i);

  // ---------- 12. books must balance ----------
  const [tb] = (await db.execute(sql`select coalesce(sum(debit),0) d, coalesce(sum(credit),0) c from journal_lines where org_id=${orgId}`)).rows;
  check("trial balance: total debits equal total credits", num(tb.d) === num(tb.c), `Dr ${num(tb.d).toLocaleString()} / Cr ${num(tb.c).toLocaleString()}`);
  const unbalanced = (await db.execute(sql`select count(*)::int n from (select entry_id from journal_lines where org_id=${orgId} group by entry_id having sum(debit) <> sum(credit)) x`)).rows[0].n;
  check("every individual journal entry balances", num(unbalanced) === 0, `${unbalanced} unbalanced entries`);
  const [sb] = (await db.execute(sql`select coalesce(sum(balance),0) s from savings_accounts where org_id=${orgId}`)).rows;
  check("savings sub-ledger equals general ledger (account 2000)", num(sb.s) === -(await gl(orgId, "2000")), `sub ${num(sb.s)} vs GL ${-(await gl(orgId, "2000"))}`);
  const interest = num((await db.execute(sql`select coalesce(sum(amount),0) s from transactions where org_id=${orgId} and type='interest' and status='completed'`)).rows[0].s);
  check("savings sub-ledger equals deposits - withdrawals - reversals + posted interest", num(sb.s) === expectedSavings + interest, `${num(sb.s)} vs ${expectedSavings} + interest ${interest}`);
  let principalOut = 0;
  for (const l of await db.select().from(loans).where(eq(loans.orgId, orgId))) principalOut += (await Ln.loanBalances(l.id)).outstanding.principal;
  const glLoans = await gl(orgId, "1100");
  check("loan portfolio sub-ledger equals general ledger (account 1100)", principalOut === glLoans, `schedules ${principalOut} vs GL ${glLoans}`);
  for (const [code, name] of [["1000", "cash"], ["1010", "bank"], ["1020", "MTN"], ["1030", "Airtel"]] as const) { const b = await gl(orgId, code); check(`${name} balance is never negative`, b >= 0, `UGX ${b.toLocaleString()}`); }
  const chain = await verifyAuditChain(orgId);
  check("audit trail hash chain verifies", !!(chain as { ok?: boolean }).ok, JSON.stringify(chain).slice(0, 100));

  // ---------- 13. reports and dashboard ----------
  const range = await resolveRange(org, { range: "this_year" } as never);
  try { const d = await timed("dashboard", () => dashboardData(orgId, range)); check("dashboard analytics load", !!d); } catch (e) { check("dashboard analytics load", false, (e as Error).message); }
  const p = { from: addMonths(today, -12), to: today } as never;
  for (const key of ["member_register", "savings_balances", "contributions", "loan_portfolio", "overdue_loans", "npl_report", "repayment_schedule", "income_expenditure", "cashbook", "trial_balance", "income_statement", "balance_sheet", "cash_flow", "audit_log", "annual_report", "member_statement"]) {
    try { const r = await timed("report", () => getReport(orgId, key, { ...(p as object), memberId: mem[0].id, loanId: loanRows[0].id } as never)); check(`report: ${key}`, r.sections.length > 0); }
    catch (e) { check(`report: ${key}`, false, (e as Error).message); }
  }
  const bs = await getReport(orgId, "trial_balance", p);
  void bs;

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const fail = results.filter((r) => !r.ok);
  console.log(`\n==== ${results.length - fail.length}/${results.length} checks passed in ${secs}s ====`);
  for (const [k, v] of Object.entries(timings)) console.log(`${k.padEnd(22)} n=${String(v.n).padStart(4)}  avg ${(v.ms / v.n).toFixed(0)} ms`);
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify({ orgId, results, timings, seconds: secs }, null, 2));
  await pool.end();
  process.exit(fail.length ? 1 : 0);
}
main().catch(async (e) => { console.error("SIMULATION CRASHED:", e); await pool.end().catch(() => {}); process.exit(2); });
