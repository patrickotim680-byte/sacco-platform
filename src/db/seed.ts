/**
 * DEMO DATA - every person, phone number and ID below is fictional and generated.
 * Organisation: "Uganda Community Development SACCO" (flagged is_demo = true).
 * Deterministic (seeded PRNG) so test runs are reproducible. Idempotent: skips if the demo org exists.
 */
import { randomUUID } from "crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as S from "@/db/schema";
import { allowLedgerWrite, audit, CHANNEL_ACCOUNT, newRef, type Tx } from "@/lib/core";
import { addDays, addMonths, allocateRepayment, buildSchedule, penaltyCharge, daysBetween, todayEAT, type DueRow, type InterestMethod, type LoanFrequency } from "@/lib/finance";
import { hashPassword } from "@/lib/password";
import { createOrganisation, ensurePlans } from "@/lib/services/org";
import { DEFAULT_RULES } from "@/lib/services/groups";

export const DEMO_SLUG = "uganda-community-development-sacco";
export const DEMO_PASSWORD = "Demo@12345";
export const DEMO_LOGINS = [
  { email: "admin@softronics.demo", role: "Platform owner (Softronics)", path: "/admin" },
  { email: "owner@ucdsacco.demo", role: "Super Admin (organisation owner)", path: "/dashboard" },
  { email: "chair@ucdsacco.demo", role: "Chairperson", path: "/dashboard" },
  { email: "manager@ucdsacco.demo", role: "Manager", path: "/dashboard" },
  { email: "treasurer@ucdsacco.demo", role: "Treasurer", path: "/dashboard" },
  { email: "secretary@ucdsacco.demo", role: "Secretary", path: "/dashboard" },
  { email: "officer@ucdsacco.demo", role: "Loan Officer", path: "/dashboard" },
  { email: "auditor@ucdsacco.demo", role: "Auditor (read-only)", path: "/dashboard" },
  { email: "member@ucdsacco.demo", role: "Member (self-service portal)", path: "/portal" },
];

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MALE = ["Moses", "Joseph", "David", "Samuel", "Ronald", "Brian", "Isaac", "Patrick", "Robert", "Emmanuel", "Francis", "Peter", "Henry", "Denis", "Geoffrey", "Ivan", "Julius", "Kenneth", "Allan", "Richard", "Fred", "Charles", "Godfrey", "Jonathan", "Simon", "Paul", "Andrew", "Vincent", "Edward", "Hassan", "Ibrahim", "Yusuf", "Mugisha", "Okello", "Opio", "Kato"];
const FEMALE = ["Sarah", "Grace", "Esther", "Mary", "Betty", "Juliet", "Harriet", "Florence", "Agnes", "Prossy", "Winnie", "Rose", "Joyce", "Immaculate", "Racheal", "Annet", "Doreen", "Christine", "Patience", "Peninah", "Josephine", "Gladys", "Irene", "Norah", "Scovia", "Susan", "Margaret", "Eunice", "Lydia", "Hajara", "Aisha", "Zainab", "Akello", "Atim", "Nabirye", "Namuli"];
const LAST = ["Mukasa", "Ssebunya", "Namukasa", "Nakimera", "Okello", "Opio", "Akello", "Atim", "Byaruhanga", "Tumusiime", "Kyomuhendo", "Mugisha", "Asiimwe", "Kato", "Lubega", "Nabukenya", "Nansubuga", "Ssemwogerere", "Kiggundu", "Wasswa", "Mutebi", "Nakabugo", "Kabanda", "Tusiime", "Ochieng", "Wamala", "Namatovu", "Nalubega", "Kasozi", "Mwesigwa", "Babirye", "Nantongo", "Ojok", "Auma", "Kisakye", "Musoke", "Kamya", "Ssali", "Bbosa", "Zziwa", "Muhumuza", "Atuhaire", "Natukunda", "Birungi", "Namugga", "Kizza", "Lutalo", "Tendo"];
const DISTRICTS = ["Kampala", "Wakiso", "Mukono", "Jinja", "Mbale", "Gulu", "Masaka", "Mbarara", "Lira", "Entebbe", "Iganga", "Kasese"];
const OCC = ["Teacher", "Trader", "Farmer", "Boda boda rider", "Nurse", "Tailor", "Mechanic", "Shopkeeper", "Salon owner", "Market vendor", "Accountant", "Driver", "Carpenter", "Fisherman"];
const NOK_REL = ["Spouse", "Sibling", "Parent", "Child"];

type JE = typeof S.journalEntries.$inferInsert;
type JL = typeof S.journalLines.$inferInsert;

async function bulk<T extends Record<string, unknown>>(tx: Tx, table: never, rows: T[], size = 800) {
  for (let i = 0; i < rows.length; i += size) await tx.insert(table as never).values(rows.slice(i, i + size) as never);
}

export async function seedDemo() {
  const [existing] = await db.select({ id: S.organisations.id }).from(S.organisations).where(eq(S.organisations.slug, DEMO_SLUG));
  if (existing) return { skipped: true };
  const R = rng(20240611);
  const pick = <T,>(a: T[]) => a[Math.floor(R() * a.length)];
  const between = (a: number, b: number) => a + Math.floor(R() * (b - a + 1));
  const today = todayEAT();
  const pw = await hashPassword(DEMO_PASSWORD);
  const at = (d: string, h = 9) => new Date(`${d}T${String(h).padStart(2, "0")}:${String(between(0, 59)).padStart(2, "0")}:00+03:00`);

  await db.transaction(async (tx) => {
    await allowLedgerWrite(tx);
    await ensurePlans(tx);
    /* ---------- platform admin & org ---------- */
    const [platformAdmin] = await tx.insert(S.users).values({ email: "admin@softronics.demo", fullName: "Softronics Platform Admin", passwordHash: pw, isPlatformAdmin: true }).onConflictDoNothing().returning();
    void platformAdmin;
    const org = await createOrganisation(tx, { name: "Uganda Community Development SACCO", type: "sacco", regulatoryStatus: "registered_cooperative", phone: "+256414000111", email: "info@ucdsacco.demo", district: "Kampala", planCode: "professional", isDemo: true });
    await tx.update(S.organisations).set({ registrationNo: "DEMO-COOP-0001 (fictional)", address: "Plot 12, Demo Road, Kampala (fictional)" }).where(eq(S.organisations.id, org.id));
    const orgId = org.id;
    const acct = new Map((await tx.select({ id: S.glAccounts.id, code: S.glAccounts.code }).from(S.glAccounts).where(eq(S.glAccounts.orgId, orgId))).map((a) => [a.code, a.id]));
    const staff = [
      ["owner@ucdsacco.demo", "Demo Owner (Super Admin)", "super_admin"], ["chair@ucdsacco.demo", "Demo Chairperson", "chairperson"], ["manager@ucdsacco.demo", "Demo Manager", "manager"],
      ["treasurer@ucdsacco.demo", "Demo Treasurer", "treasurer"], ["secretary@ucdsacco.demo", "Demo Secretary", "secretary"], ["officer@ucdsacco.demo", "Demo Loan Officer", "loan_officer"], ["auditor@ucdsacco.demo", "Demo Auditor", "auditor"],
    ] as const;
    const uid: Record<string, string> = {};
    for (const [email, name, role] of staff) {
      const [u] = await tx.insert(S.users).values({ email, fullName: name, passwordHash: pw }).returning();
      await tx.insert(S.orgUsers).values({ orgId, userId: u.id, role });
      uid[role] = u.id;
    }
    const treasurer = uid.treasurer, chair = uid.chairperson, officer = uid.loan_officer;

    /* ---------- products ---------- */
    const sp = await tx.select().from(S.savingsProducts).where(eq(S.savingsProducts.orgId, orgId));
    const prodMandatory = sp.find((p) => p.category === "mandatory")!, prodOrdinary = sp.find((p) => p.name === "Ordinary Savings")!;
    const [prodFixed, prodEdu, prodDaily] = await tx.insert(S.savingsProducts).values([
      { orgId, name: "Fixed Deposit (12 months)", category: "voluntary", planType: "fixed", frequency: "custom", minContribution: "500000", interestRate: "9", lockMonths: 12 },
      { orgId, name: "Education Savings", category: "voluntary", planType: "flexible", frequency: "monthly", minContribution: "30000", interestRate: "4" },
      { orgId, name: "Daily Susu Savings", category: "voluntary", planType: "flexible", frequency: "daily", minContribution: "2000", interestRate: "2" },
    ]).returning();
    const lpStd = (await tx.select().from(S.loanProducts).where(eq(S.loanProducts.orgId, orgId)))[0];
    const [lpEmerg, lpDev, lpAgri] = await tx.insert(S.loanProducts).values([
      { orgId, name: "Emergency Loan", interestRate: "18", interestMethod: "flat", minAmount: "50000", maxAmount: "2000000", minTermMonths: 1, maxTermMonths: 6, savingsMultiple: "2", minMembershipMonths: 2, guarantorsRequired: 0, processingFeePct: "1", penaltyRatePct: "5", graceDays: 3 },
      { orgId, name: "Development Loan", interestRate: "22", interestMethod: "reducing", minAmount: "500000", maxAmount: "15000000", minTermMonths: 6, maxTermMonths: 24, savingsMultiple: "3", minMembershipMonths: 6, guarantorsRequired: 2, processingFeePct: "1.5", penaltyRatePct: "5", graceDays: 5 },
      { orgId, name: "Agricultural Seasonal Loan", interestRate: "20", interestMethod: "reducing", minAmount: "200000", maxAmount: "8000000", minTermMonths: 3, maxTermMonths: 12, savingsMultiple: "3", minMembershipMonths: 4, guarantorsRequired: 1, processingFeePct: "1", penaltyRatePct: "4", graceDays: 3 },
    ]).returning();
    await tx.update(S.loanProducts).set({ minTermMonths: 3, maxTermMonths: 18 }).where(eq(S.loanProducts.id, lpStd.id));
    const lps = [lpStd, lpEmerg, lpDev, lpAgri];

    /* ---------- ledger buffers ---------- */
    const jes: JE[] = [], jls: JL[] = [];
    let jeSeq = 0;
    const post = (date: string, desc: string, lines: [string, number, number][], sourceId?: string, sourceType = "transaction") => {
      const id = randomUUID();
      jeSeq++;
      jes.push({ id, orgId, entryNo: `JE-${String(jeSeq).padStart(6, "0")}`, entryDate: date, description: desc, source: "system", sourceType, sourceId, createdBy: treasurer, createdAt: at(date) });
      for (const [code, d, c] of lines) if (d || c) jls.push({ orgId, entryId: id, accountId: acct.get(code)!, debit: String(d), credit: String(c) });
      return id;
    };
    const refs = new Set<string>();
    const ref = (p: string, d: string) => { let r = newRef(p, new Date(d)); while (refs.has(r)) r = newRef(p, new Date(d)); refs.add(r); return r; };
    const txns: (typeof S.transactions.$inferInsert)[] = [];
    const addTxn = (t: Omit<typeof S.transactions.$inferInsert, "orgId" | "reference" | "createdBy" | "createdAt" | "id"> & { id?: string }, lines: [string, number, number][], desc: string, by = treasurer) => {
      const id = t.id ?? randomUUID();
      const je = post(t.txnDate, desc, lines, id);
      txns.push({ ...t, id, orgId, reference: ref("TX", t.txnDate), journalEntryId: je, createdBy: by, createdAt: at(t.txnDate) });
      return id;
    };
    const chanPick = () => { const x = R(); return x < 0.4 ? "cash" : x < 0.75 ? "mtn_momo" : x < 0.9 ? "airtel_money" : "bank"; };

    // opening share capital
    const capDate = addMonths(today, -30);
    addTxn({ type: "income", amount: "60000000", channel: "bank", txnDate: capDate, description: "Founders' share capital (demo)", metadata: { glCode: "3000" } }, [["1010", 60000000, 0], ["3000", 0, 60000000]], "Founders' share capital (demo opening)");

    /* ---------- members ---------- */
    const used = new Set<string>(), phones = new Set<string>();
    type M = { id: string; no: string; name: string; join: string; status: string; accounts: { id: string; no: string; prod: string; bal: number; opened: string }[] };
    const mems: M[] = [];
    const memberRows: (typeof S.members.$inferInsert)[] = [];
    for (let i = 0; i < 120; i++) {
      const female = R() < 0.55;
      let name = "";
      do { name = `${pick(female ? FEMALE : MALE)} ${pick(LAST)}`; } while (used.has(name));
      used.add(name);
      let phone = "";
      do { phone = `+256${pick(["77", "78", "75", "70", "76", "74"])}${String(between(1000000, 9999999))}`; } while (phones.has(phone));
      phones.add(phone);
      const joinOffset = Math.floor((1 - Math.pow(R(), 1.4)) * 29); // months ago
      const join = addDays(addMonths(today, -joinOffset), -between(0, 25));
      const id = randomUUID();
      const status = i % 20 === 7 ? "suspended" : "active";
      const nokMale = R() < 0.5;
      memberRows.push({
        id, orgId, memberNo: `M${String(i + 1).padStart(5, "0")}`, fullName: name, gender: female ? "female" : "male", dateOfBirth: `${between(1960, 2000)}-${String(between(1, 12)).padStart(2, "0")}-${String(between(1, 28)).padStart(2, "0")}`,
        nationalId: `CMDEMO${String(100000 + i * 7919).slice(0, 6)}${String(between(1000, 9999))}`, phone, email: R() < 0.3 ? `${name.toLowerCase().replace(/ /g, ".")}@example.com` : null,
        address: `Demo Village ${between(1, 40)}, ${pick(DISTRICTS)}`, district: pick(DISTRICTS), occupation: pick(OCC),
        nokName: `${pick(nokMale ? MALE : FEMALE)} ${pick(LAST)}`, nokPhone: `+256${pick(["77", "78", "75"])}${String(between(1000000, 9999999))}`, nokRelationship: pick(NOK_REL),
        status, statusReason: status === "suspended" ? "Missed contributions for 3 consecutive months (demo)" : null, joinedAt: join, isDemo: true, createdAt: at(join),
      });
      mems.push({ id, no: `M${String(i + 1).padStart(5, "0")}`, name, join, status, accounts: [] });
    }
    await bulk(tx, S.members as never, memberRows);
    await bulk(tx, S.notificationPrefs as never, mems.map((m) => ({ orgId, memberId: m.id, sms: true, email: false, whatsapp: R() < 0.2 })));
    // member portal login
    const portalMember = mems.find((m) => m.status === "active" && m.join < addMonths(today, -14))!;
    const [mu] = await tx.insert(S.users).values({ email: "member@ucdsacco.demo", fullName: portalMember.name, passwordHash: pw, phone: memberRows[mems.indexOf(portalMember)].phone }).returning();
    await tx.insert(S.orgUsers).values({ orgId, userId: mu.id, role: "member", memberId: portalMember.id });

    /* ---------- savings accounts & deposits ---------- */
    const accRows: (typeof S.savingsAccounts.$inferInsert)[] = [];
    const schedRows: (typeof S.contributionSchedules.$inferInsert)[] = [];
    const accBal = new Map<string, number>();
    const counters: Record<string, number> = {};
    const openAcc = (m: M, prod: typeof prodFixed, opened: string, maturity?: string) => {
      const n = m.accounts.length + 1;
      const id = randomUUID(), no = `${m.no}-${String(n).padStart(2, "0")}`;
      accRows.push({ id, orgId, memberId: m.id, productId: prod.id, accountNo: no, balance: "0", openedAt: opened, maturityDate: maturity ?? null, createdAt: at(opened) });
      m.accounts.push({ id, no, prod: prod.name, bal: 0, opened });
      accBal.set(id, 0);
      return id;
    };
    const deposit = (m: M, accId: string, date: string, amount: number, desc: string) => {
      const ch = chanPick();
      addTxn({ type: "deposit", memberId: m.id, accountId: accId, amount: String(amount), channel: ch, txnDate: date, description: desc, externalRef: ch === "mtn_momo" || ch === "airtel_money" ? `${ch === "mtn_momo" ? "MP" : "AM"}${String(between(10000000, 99999999))}${txns.length}` : null }, [[CHANNEL_ACCOUNT[ch], amount, 0], ["2000", 0, amount]], `Deposit - ${m.name}`);
      accBal.set(accId, accBal.get(accId)! + amount);
    };
    const monthsList = (join: string) => { const out: string[] = []; let d = join; while (d <= today) { out.push(d); d = addMonths(d, 1); } return out; };
    for (const m of mems) {
      const mand = openAcc(m, prodMandatory, m.join);
      const base = pick([20000, 30000, 50000, 75000, 100000]);
      const lastMissed = m.status === "suspended" ? 3 : R() < 0.1 ? 1 : 0;
      const ms = monthsList(m.join);
      ms.forEach((d, idx) => {
        if (idx >= ms.length - lastMissed) return;
        if (R() < 0.94) deposit(m, mand, addDays(d, between(0, 6)) > today ? today : addDays(d, between(0, 6)), base, "Monthly mandatory savings");
      });
      // membership fee
      addTxn({ type: "income", memberId: m.id, amount: "20000", channel: "cash", txnDate: m.join, description: `Membership fee - ${m.name}`, metadata: { glCode: "4020" } }, [["1000", 20000, 0], ["4020", 0, 20000]], `Membership fee ${m.no}`, uid.secretary);
      schedRows.push({ orgId, memberId: m.id, accountId: mand, amount: String(base), frequency: "monthly", nextDue: lastMissed ? addMonths(today.slice(0, 8) + "01", -lastMissed) : addMonths(today.slice(0, 8) + "01", 1), active: m.status === "active" });
      if (R() < 0.7) {
        const a = openAcc(m, prodOrdinary, m.join);
        ms.forEach((d) => { if (R() < 0.5) deposit(m, a, addDays(d, between(5, 20)) > today ? today : addDays(d, between(5, 20)), between(2, 40) * 5000, "Voluntary savings deposit"); });
      }
      if (R() < 0.15 && m.join < addMonths(today, -2)) {
        const open = addDays(m.join, 20);
        const a = openAcc(m, prodFixed, open, addMonths(open, 12));
        deposit(m, a, open, between(1, 10) * 500000, "Fixed deposit placement");
      }
      if (R() < 0.15) { const a = openAcc(m, prodEdu, m.join); ms.forEach((d) => { if (R() < 0.7) deposit(m, a, d > today ? today : d, between(1, 6) * 10000, "Education savings"); }); }
      if (R() < 0.05) { const a = openAcc(m, prodDaily, m.join); for (let k = 0; k < 40; k++) { const dd = addDays(today, -k * 3); if (dd >= m.join) deposit(m, a, dd, between(1, 8) * 2500, "Daily susu collection"); } }
    }

    /* ---------- withdrawals ---------- */
    const wrRows: (typeof S.withdrawalRequests.$inferInsert)[] = [];
    let wcount = 0;
    for (const m of mems.filter((x) => x.status === "active")) {
      for (const a of m.accounts) {
        if (wcount >= 24 || a.prod !== "Ordinary Savings" || accBal.get(a.id)! < 250000 || R() < 0.7) continue;
        const amt = Math.floor((accBal.get(a.id)! * between(15, 50)) / 100 / 5000) * 5000;
        if (amt < 20000) continue;
        const date = addDays(today, -between(3, 200));
        if (date < addDays(a.opened, 30)) continue;
        const ch = pick(["cash", "mtn_momo", "cash"]);
        const tid = addTxn({ type: "withdrawal", memberId: m.id, accountId: a.id, amount: String(amt), channel: ch, txnDate: date, description: "Savings withdrawal" }, [["2000", amt, 0], [CHANNEL_ACCOUNT[ch], 0, amt]], `Withdrawal - ${m.name}`);
        accBal.set(a.id, accBal.get(a.id)! - amt);
        wrRows.push({ orgId, memberId: m.id, accountId: a.id, amount: String(amt), channel: ch, reason: pick(["School fees", "Medical bills", "Business stock", "Household needs"]), status: "approved", requestedBy: uid.manager, reviewedBy: treasurer, reviewedAt: at(date), transactionId: tid, createdAt: at(date) });
        wcount++;
      }
    }
    const pendingW = mems.filter((x) => x.status === "active").slice(5, 40).filter((m) => m.accounts.some((a) => accBal.get(a.id)! > 300000)).slice(0, 4);
    pendingW.forEach((m, i) => { const a = m.accounts.find((x) => accBal.get(x.id)! > 300000)!; wrRows.push({ orgId, memberId: m.id, accountId: a.id, amount: String([150000, 300000, 80000, 250000][i]), channel: i % 2 ? "mtn_momo" : "cash", reason: ["School fees for term 2", "Hospital bill", "Buy stock for shop", "Rent"][i], status: "pending", requestedBy: i === 0 ? mu.id : officer }); });

    /* ---------- monthly operating income & expense ---------- */
    for (let k = 14; k >= 0; k--) {
      const d = addDays(addMonths(today, -k), -(k === 0 ? 0 : 0));
      const date = k === 0 ? addDays(today, -Math.min(2, 0)) : d;
      const exp: [string, string, number, string][] = [["5000", "Staff salaries and allowances", between(33, 38) * 10000, "bank"], ["5010", "Office rent and utilities", 220000, "bank"], ["5020", "Stationery and office supplies", between(4, 9) * 10000, "cash"], ["5040", "Mobile money and bank charges", between(8, 14) * 2500, "bank"], ["5060", "Meetings, transport and refreshments", between(4, 9) * 10000, "cash"]];
      for (const [code, desc, amt, ch] of exp) addTxn({ type: "expense", amount: String(amt), channel: ch, txnDate: date, description: desc, metadata: { glCode: code, payee: "Demo supplier" } }, [[code, amt, 0], [CHANNEL_ACCOUNT[ch], 0, amt]], desc);
      if (true) addTxn({ type: "income", amount: "300000", channel: "bank", txnDate: date, description: "Bank interest and other income", metadata: { glCode: "4030" } }, [["1010", 300000, 0], ["4030", 0, 300000]], "Bank interest and other income");
    }

    /* ---------- loans ---------- */
    type L = { id: string; no: string; mem: M; status: string };
    const loanRows: (typeof S.loans.$inferInsert)[] = [], schedRowsDb: (typeof S.loanSchedule.$inferInsert)[] = [], repayRows: (typeof S.loanRepayments.$inferInsert)[] = [];
    const appRows: (typeof S.loanApplications.$inferInsert)[] = [], guarRows: (typeof S.loanGuarantors.$inferInsert)[] = [], collRows: (typeof S.loanCollaterals.$inferInsert)[] = [];
    const loanList: L[] = [];
    const eligible = mems.filter((m) => m.status === "active" && m.join < addMonths(today, -9) && m.accounts.some((a) => accBal.get(a.id)! > 400000));
    const flagRows: (typeof S.fraudFlags.$inferInsert)[] = [];
    const LOAN_PLAN: { kind: "closed" | "active" | "overdue" }[] = [...Array(7).fill({ kind: "closed" }), ...Array(17).fill({ kind: "active" }), ...Array(8).fill({ kind: "overdue" })];
    LOAN_PLAN.forEach(({ kind }, idx) => {
      const m = eligible[(idx * 3) % eligible.length];
      const savings = m.accounts.reduce((s, a) => s + accBal.get(a.id)!, 0);
      const prod = lps[idx % lps.length];
      const method = prod.interestMethod as InterestMethod, freq = prod.frequency as LoanFrequency;
      const term = Math.min(prod.maxTermMonths, Math.max(prod.minTermMonths, between(3, 18)));
      let principal = Math.min(Number(prod.maxAmount), Math.max(Number(prod.minAmount), Math.floor((savings * (1 + R() * 1.5)) / 50000) * 50000));
      principal = Math.max(100000, principal);
      const monthsAgo = kind === "closed" ? term + between(1, 6) : kind === "overdue" ? Math.min(term - 1, between(4, 8)) : Math.max(1, between(1, Math.max(1, term - 1)));
      const disbursed = addDays(addMonths(today, -monthsAgo), -between(0, 12));
      if (disbursed < addDays(m.join, 90)) return;
      const id = randomUUID(), appId = randomUUID(), no = `LN-${String(loanList.length + 1).padStart(5, "0")}`;
      const sched = buildSchedule({ principal, annualRatePct: Number(prod.interestRate), method, termMonths: term, frequency: freq, startDate: disbursed });
      const rows: DueRow[] = sched.map((s) => ({ id: randomUUID(), installmentNo: s.installmentNo, dueDate: s.dueDate, principalDue: s.principalDue, interestDue: s.interestDue, principalPaid: 0, interestPaid: 0, penaltyAccrued: 0, penaltyPaid: 0 }));
      const dueRows = rows.filter((r) => r.dueDate <= today);
      let payCount = kind === "closed" ? rows.length : dueRows.length;
      if (kind === "overdue") payCount = Math.max(0, dueRows.length - between(2, 3));
      if (kind === "active" && dueRows.length && R() < 0.3) payCount = Math.max(0, dueRows.length - 0);
      const fee = Math.round((principal * Number(prod.processingFeePct)) / 100), net = principal - fee;
      const dch = pick(["cash", "bank", "mtn_momo", "bank"]);
      const dTxn = addTxn({ type: "loan_disbursement", memberId: m.id, loanId: id, amount: String(principal), channel: dch, txnDate: disbursed, description: `Loan disbursement ${no}`, metadata: { fee, net } },
        [["1100", principal, 0], [CHANNEL_ACCOUNT[dch], 0, net], ["4020", 0, fee]], `Loan disbursement ${no} to ${m.name}`, treasurer);
      void dTxn;
      if (principal >= 3000000) flagRows.push({ orgId, kind: "large_amount", severity: "medium", detail: `loan_disbursement of UGX ${principal.toLocaleString("en-UG")} at or above the large-transaction threshold`, transactionId: dTxn, status: idx % 2 ? "reviewed" : "open" });
      let pp = 0, ip = 0, pen = 0;
      for (let k = 0; k < payCount; k++) {
        const r = rows[k];
        const payDate = kind === "closed" || kind === "active" ? addDays(r.dueDate, between(-2, 4)) : addDays(r.dueDate, between(0, 3));
        const date = payDate > today ? today : payDate;
        const amount = r.principalDue + r.interestDue - r.principalPaid - r.interestPaid;
        if (amount <= 0) continue;
        const al = allocateRepayment(rows, amount);
        for (const a of al.allocations) { const t = rows.find((x) => x.id === a.scheduleId)!; t.principalPaid += a.principal; t.interestPaid += a.interest; }
        pp += al.principal; ip += al.interest;
        const ch = chanPick();
        const tid = addTxn({ type: "loan_repayment", memberId: m.id, loanId: id, amount: String(amount), channel: ch, txnDate: date, description: `Repayment ${no}`, externalRef: ch === "mtn_momo" || ch === "airtel_money" ? `RP${between(10000000, 99999999)}${txns.length}` : null },
          [[CHANNEL_ACCOUNT[ch], amount, 0], ["1100", 0, al.principal], ["4000", 0, al.interest]], `Loan repayment ${no}`, officer);
        repayRows.push({ orgId, loanId: id, transactionId: tid, amount: String(amount), principal: String(al.principal), interest: String(al.interest), penalty: "0", allocation: al.allocations, paidAt: date });
      }
      // partial payment on the first unpaid due installment for some overdue loans
      if (kind === "overdue" && R() < 0.5 && payCount < dueRows.length) {
        const r = rows[payCount]; const part = Math.floor((r.interestDue + r.principalDue) * 0.3 / 1000) * 1000;
        if (part > 0) {
          const al = allocateRepayment(rows, part);
          for (const a of al.allocations) { const t = rows.find((x) => x.id === a.scheduleId)!; t.principalPaid += a.principal; t.interestPaid += a.interest; }
          pp += al.principal; ip += al.interest;
          const date = addDays(r.dueDate, 2) > today ? today : addDays(r.dueDate, 2);
          const tid = addTxn({ type: "loan_repayment", memberId: m.id, loanId: id, amount: String(part), channel: "cash", txnDate: date, description: `Part repayment ${no}` }, [["1000", part, 0], ["1100", 0, al.principal], ["4000", 0, al.interest]], `Loan repayment ${no}`, officer);
          repayRows.push({ orgId, loanId: id, transactionId: tid, amount: String(part), principal: String(al.principal), interest: String(al.interest), penalty: "0", allocation: al.allocations, paidAt: date });
        }
      }
      // penalties on overdue installments
      for (const r of rows) {
        const unpaid = r.principalDue + r.interestDue - r.principalPaid - r.interestPaid;
        if (r.dueDate < today && unpaid > 0) {
          const c = penaltyCharge({ unpaid, ratePct: Number(prod.penaltyRatePct), daysOverdue: daysBetween(r.dueDate, today), graceDays: prod.graceDays, periodsCharged: 0 });
          if (c.newPeriods) { r.penaltyAccrued = c.amount; (r as DueRow & { periods?: number }).periods = c.newPeriods; }
        }
      }
      const closed = rows.every((r) => r.principalPaid >= r.principalDue && r.interestPaid >= r.interestDue);
      loanRows.push({ id, orgId, loanNo: no, memberId: m.id, productId: prod.id, applicationId: appId, principal: String(principal), interestRate: prod.interestRate, interestMethod: method, frequency: freq, termMonths: term, penaltyRatePct: prod.penaltyRatePct, graceDays: prod.graceDays, disbursedAt: disbursed, channel: dch, status: closed ? "closed" : "active", principalPaid: String(pp), interestPaid: String(ip), penaltyPaid: "0", disbursedBy: treasurer, isDemo: true, createdAt: at(disbursed) });
      for (const r of rows) {
        const done = r.principalPaid >= r.principalDue && r.interestPaid >= r.interestDue;
        schedRowsDb.push({ id: r.id, orgId, loanId: id, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: String(r.principalDue), interestDue: String(r.interestDue), principalPaid: String(r.principalPaid), interestPaid: String(r.interestPaid), penaltyAccrued: String(r.penaltyAccrued), penaltyPeriods: (r as DueRow & { periods?: number }).periods ?? 0, status: done ? "paid" : r.principalPaid + r.interestPaid > 0 ? "partial" : "pending" });
      }
      appRows.push({ id: appId, orgId, applicationNo: `LA-${String(loanList.length + 1).padStart(5, "0")}`, memberId: m.id, productId: prod.id, amount: String(principal), termMonths: term, purpose: pick(["Business expansion", "School fees", "Farm inputs", "Buy motorcycle", "Home improvement", "Stock purchase"]), status: "disbursed", reviewedBy: chair, reviewedAt: at(addDays(disbursed, -3)), appliedBy: officer, loanId: id, createdAt: at(addDays(disbursed, -9)), eligibility: { eligible: true, demo: true } });
      const g = eligible[(idx * 3 + 7) % eligible.length];
      if (g.id !== m.id) guarRows.push({ orgId, applicationId: appId, guarantorMemberId: g.id, amountGuaranteed: String(Math.round(principal / 2)), status: "accepted" });
      if (principal > 2000000) collRows.push({ orgId, applicationId: appId, description: pick(["Motorcycle logbook (demo)", "Land title - Kyadondo (demo)", "Business stock inventory (demo)"]), estimatedValue: String(principal) });
      loanList.push({ id, no, mem: m, status: kind });
    });
    // pending / under review / rejected applications
    const pendingMembers = mems.filter((m) => m.status === "active" && !loanList.some((l) => l.mem.id === m.id) && m.join < addMonths(today, -7) && m.accounts.some((a) => accBal.get(a.id)! > 300000)).slice(0, 8);
    const pendSpec: [string, number, number, string, string][] = [["pending", 1500000, 6, "Expand tailoring shop", "Business"], ["pending", 800000, 4, "Pay school fees", "Education"], ["under_review", 3000000, 12, "Buy dairy cows", "Agriculture"], ["pending", 500000, 3, "Medical emergency", "Emergency"], ["under_review", 2500000, 10, "Roof repairs", "Housing"], ["rejected", 6000000, 12, "Land purchase", "Property"], ["rejected", 1200000, 6, "Boda boda purchase", "Transport"]];
    pendSpec.forEach(([st, amt, term, purpose], i) => {
      const m = pendingMembers[i]; if (!m) return;
      const lp = lps[(i % 3) + 1];
      appRows.push({ id: randomUUID(), orgId, applicationNo: `LA-${String(loanList.length + 1 + i).padStart(5, "0")}`, memberId: m.id, productId: lp.id, amount: String(amt), termMonths: Math.min(term, lp.maxTermMonths), purpose, status: st, appliedBy: officer, reviewedBy: st === "rejected" ? chair : st === "under_review" ? uid.manager : null, reviewNote: st === "rejected" ? "Exceeds savings-based limit and guarantor cover insufficient (demo)" : null, reviewedAt: st !== "pending" ? at(addDays(today, -2)) : null, createdAt: at(addDays(today, -between(1, 9))), eligibility: { eligible: st !== "rejected", demo: true } });
    });
    const appCount = appRows.length;

    /* ---------- groups / VSLA ---------- */
    const grpSpecs = [
      { name: "Kisenyi Women Savers VSLA", kind: "vsla", loc: "Kisenyi, Kampala", rules: { ...DEFAULT_RULES, sharePrice: 2000, maxSharesPerMeeting: 5 } },
      { name: "Mbale Farmers Rotating Savings Group", kind: "rotating", loc: "Mbale Municipality", rules: { ...DEFAULT_RULES, sharePrice: 5000, maxSharesPerMeeting: 4, socialFundContribution: 2000 } },
      { name: "Gulu Youth Investment Club", kind: "investment_club", loc: "Gulu City", rules: { ...DEFAULT_RULES, sharePrice: 5000, maxSharesPerMeeting: 10, loanInterestPct: 8 } },
    ];
    const grpIds: string[] = [];
    const gm: (typeof S.groupMembers.$inferInsert)[] = [], gcy: (typeof S.groupCycles.$inferInsert)[] = [], gmt: (typeof S.groupMeetings.$inferInsert)[] = [];
    const matt: (typeof S.meetingAttendance.$inferInsert)[] = [], gent: (typeof S.groupEntries.$inferInsert)[] = [], gloan: (typeof S.groupLoans.$inferInsert)[] = [], gres: (typeof S.groupResolutions.$inferInsert)[] = [];
    const grows: (typeof S.groups.$inferInsert)[] = [];
    grpSpecs.forEach((g, gi) => {
      const gid = randomUUID(); grpIds.push(gid);
      grows.push({ id: gid, orgId, name: g.name, kind: g.kind, location: g.loc, registrationNo: `DEMO-GRP-${gi + 1}`, constitution: "Demo constitution (fictional): Members meet weekly, buy shares up to the weekly maximum, contribute to the social fund, and may borrow up to the multiple of their savings at the group interest rate. Decisions are by majority vote; the cycle ends with a share-out of savings plus profits.", rules: g.rules, createdAt: at(addMonths(today, -8)) });
      const gMembers = mems.filter((m) => m.status === "active").slice(gi * 14, gi * 14 + 14);
      gMembers.forEach((m, i) => gm.push({ orgId, groupId: gid, memberId: m.id, role: i === 0 ? "chairperson" : i === 1 ? "secretary" : i === 2 ? "treasurer" : "member", joinedAt: addMonths(today, -8) }));
      const cid = randomUUID(), start = addDays(today, -84);
      gcy.push({ id: cid, orgId, groupId: gid, name: `Cycle ${today.slice(0, 4)}`, startDate: start, endDate: addDays(start, 280), status: "open", savingsTarget: String(gi === 2 ? 12000000 : 6000000) });
      const loansOut: { id: string; m: M; amt: number; date: string; interest: number }[] = [];
      for (let w = 0; w <= 14; w++) {
        const date = addDays(start, w * 7);
        const mid = randomUUID();
        const held = date <= today;
        gmt.push({ id: mid, orgId, groupId: gid, cycleId: cid, meetingDate: date, venue: g.loc.split(",")[0] + " Community Hall", agenda: "Savings, social fund, loans and AOB", minutes: held ? `Meeting opened with prayer. Attendance recorded. ${gMembers.length} members on register. Shares and social fund collected; loan requests considered and approved by majority. Meeting closed. (Demo minutes)` : null, status: held ? "held" : "scheduled" });
        if (!held) continue;
        for (const m of gMembers) {
          const r = R();
          const st = r < 0.84 ? "present" : r < 0.9 ? "late" : r < 0.96 ? "absent" : "apology";
          matt.push({ orgId, meetingId: mid, memberId: m.id, status: st });
          if (st === "absent" || st === "late") {
            const f = st === "absent" ? g.rules.absentFine : g.rules.lateFine;
            const rf = ref("GR", date);
            gent.push({ orgId, groupId: gid, cycleId: cid, memberId: m.id, meetingId: mid, kind: "fine", amount: String(f), reference: rf, entryDate: date, createdBy: uid.secretary, note: `${st} fine`, createdAt: at(date, 14) });
            post(date, `${g.name}: fine ${rf}`, [["1000", f, 0], ["4010", 0, f]], undefined, "group_entry");
          }
          if (st === "absent" || st === "apology") continue;
          const sh = between(1, Math.min(4, g.rules.maxSharesPerMeeting)), amt = sh * g.rules.sharePrice;
          if (g.kind === "rotating") {
            const contrib = 20000, rf = ref("GR", date);
            gent.push({ orgId, groupId: gid, cycleId: cid, memberId: m.id, meetingId: mid, kind: "rotating_contribution", amount: String(contrib), reference: rf, entryDate: date, createdBy: uid.secretary, createdAt: at(date, 14) });
            post(date, `${g.name}: rotating contribution ${rf}`, [["1000", contrib, 0], ["2200", 0, contrib]], undefined, "group_entry");
          } else {
            const rf = ref("GR", date);
            gent.push({ orgId, groupId: gid, cycleId: cid, memberId: m.id, meetingId: mid, kind: "share", amount: String(amt), shares: sh, reference: rf, entryDate: date, createdBy: uid.secretary, createdAt: at(date, 14) });
            post(date, `${g.name}: share purchase ${rf}`, [["1000", amt, 0], ["2200", 0, amt]], undefined, "group_entry");
          }
          const sf = g.rules.socialFundContribution, rf2 = ref("GR", date);
          gent.push({ orgId, groupId: gid, cycleId: cid, memberId: m.id, meetingId: mid, kind: "social_fund", amount: String(sf), reference: rf2, entryDate: date, createdBy: uid.secretary, createdAt: at(date, 14) });
          post(date, `${g.name}: social fund ${rf2}`, [["1000", sf, 0], ["2300", 0, sf]], undefined, "group_entry");
        }
        if (g.kind === "rotating") {
          const ben = gMembers[w % gMembers.length]; const total = 20000 * gMembers.length * 0.85;
          const pay = Math.floor(total / 1000) * 1000; const rf = ref("GR", date);
          gent.push({ orgId, groupId: gid, cycleId: cid, memberId: ben.id, meetingId: mid, kind: "rotating_payout", amount: String(pay), reference: rf, entryDate: date, createdBy: uid.treasurer ?? treasurer, note: `Round ${w + 1} beneficiary`, createdAt: at(date, 15) });
          post(date, `${g.name}: rotating payout ${rf}`, [["2200", pay, 0], ["1000", 0, pay]], undefined, "group_entry");
        } else if (w % 3 === 1 && w < 11) {
          const m = gMembers[(w * 2 + 3) % gMembers.length]; const amt = between(4, 15) * 50000;
          const interest = Math.round((amt * g.rules.loanInterestPct) / 100), rf = ref("GR", date), lid = randomUUID();
          loansOut.push({ id: lid, m: mems.find((x) => x.id === m.id)!, amt, date, interest });
          gloan.push({ id: lid, orgId, groupId: gid, cycleId: cid, memberId: m.id, principal: String(amt), interestDue: String(interest), repaid: "0", dueDate: addDays(date, 56), status: "active", createdAt: at(date, 15) });
          gent.push({ orgId, groupId: gid, cycleId: cid, memberId: m.id, meetingId: mid, kind: "loan_out", amount: String(amt), loanId: lid, reference: rf, entryDate: date, createdBy: treasurer, createdAt: at(date, 15) });
          post(date, `${g.name}: group loan ${rf}`, [["1150", amt, 0], ["1000", 0, amt]], undefined, "group_entry");
        }
      }
      // repay the oldest group loans
      loansOut.slice(0, 2).forEach((lo, k) => {
        const date = addDays(lo.date, 42 + k * 7); if (date > today) return;
        const total = lo.amt + lo.interest, rf = ref("GR", date), gl = gloan.find((x) => x.id === lo.id)!;
        gl.repaid = String(total); gl.status = "repaid";
        gent.push({ orgId, groupId: gid, cycleId: cid, memberId: lo.m.id, kind: "loan_repayment", amount: String(total), interestPortion: String(lo.interest), loanId: lo.id, reference: rf, entryDate: date, createdBy: treasurer, createdAt: at(date, 14) });
        post(date, `${g.name}: group loan repayment ${rf}`, [["1000", total, 0], ["1150", 0, lo.amt], ["4000", 0, lo.interest]], undefined, "group_entry");
      });
      gres.push({ orgId, groupId: gid, title: "Weekly share cap reaffirmed", body: `Resolved that members may buy at most ${g.rules.maxSharesPerMeeting} shares per meeting and that loans are repaid within 8 weeks. (Demo)`, resolvedOn: addDays(start, 14) });
      gres.push({ orgId, groupId: gid, title: "Emergency fund top-up", body: "Resolved to allocate UGX 5,000 per member per month to the emergency fund. (Demo)", resolvedOn: addDays(start, 35) });
    });

    /* ---------- misc: notifications, announcements, payments, AR/AP, tickets ---------- */
    const notif: (typeof S.notifications.$inferInsert)[] = [];
    const sample = mems.filter((m) => m.status === "active").slice(0, 30);
    sample.forEach((m, i) => {
      const body = i % 3 === 0 ? "Your monthly contribution is due on the 5th. Thank you for saving with us." : i % 3 === 1 ? "Reminder: your loan installment falls due within 3 days." : "Your savings statement for last month is ready in the portal.";
      notif.push({ orgId, memberId: m.id, kind: i % 3 === 0 ? "contribution_reminder" : i % 3 === 1 ? "loan_reminder" : "announcement", channel: "in_app", title: "Reminder", body, status: "delivered", sentAt: at(addDays(today, -i % 7)) });
      notif.push({ orgId, memberId: m.id, kind: i % 3 === 0 ? "contribution_reminder" : "loan_reminder", channel: "sms", title: "Reminder", body, status: i % 5 === 0 ? "queued" : "simulated", provider: i % 5 === 0 ? null : "none", error: i % 5 === 0 ? null : "SMS provider not configured - message was NOT delivered (demo data)" });
    });
    notif.push({ orgId, memberId: portalMember.id, kind: "announcement", channel: "in_app", title: "Annual General Meeting", body: "The AGM takes place on the last Saturday of next month at the SACCO hall. All members are encouraged to attend.", status: "delivered", sentAt: new Date() });
    notif.push({ orgId, memberId: portalMember.id, kind: "contribution_reminder", channel: "in_app", title: "Contribution reminder", body: "Your monthly contribution is due on the 5th.", status: "delivered", sentAt: new Date() });
    await bulk(tx, S.announcements as never, [
      { orgId, title: "Annual General Meeting", body: "The AGM takes place on the last Saturday of next month at the SACCO hall. All members are encouraged to attend. (Demo announcement)", createdBy: uid.chairperson, createdAt: at(addDays(today, -3)) },
      { orgId, title: "New Agricultural Seasonal Loan", body: "Applications are now open for the Agricultural Seasonal Loan at 20% p.a. reducing balance. (Demo announcement)", createdBy: uid.manager, createdAt: at(addDays(today, -12)) },
      { orgId, title: "Mobile money deposits", body: "Please always quote your member number as the payment reference when depositing by MTN or Airtel. (Demo announcement)", createdBy: uid.secretary, createdAt: at(addDays(today, -25)) },
    ]);
    const payReqs = mems.filter((m) => m.status === "active").slice(50, 54);
    await bulk(tx, S.paymentRequests as never, payReqs.map((m, i) => ({ orgId, reference: ref("PR", today), provider: i % 2 ? "airtel_money" : "mtn_momo", purpose: "deposit", memberId: m.id, accountId: m.accounts[0].id, amount: String([50000, 120000, 30000, 200000][i]), msisdn: memberRows[mems.indexOf(m)].phone, status: i === 3 ? "cancelled" : "awaiting_confirmation", providerStatusRaw: "Manual confirmation required: provider API not configured", createdBy: treasurer })));
    await bulk(tx, S.payablesReceivables as never, [
      { orgId, kind: "payable", party: "Demo Stationers Ltd", description: "Printing of passbooks", amount: "650000", settled: "0", dueDate: addDays(today, 10) },
      { orgId, kind: "payable", party: "Demo Power & Water", description: "Utility bills", amount: "280000", settled: "100000", dueDate: addDays(today, -4) },
      { orgId, kind: "receivable", party: "Demo Partner Cooperative Union", description: "Training facilitation fee", amount: "1500000", settled: "0", dueDate: addDays(today, 21) },
    ]);
    const [tk] = await tx.insert(S.supportTickets).values({ orgId, createdBy: uid.manager, subject: "How do I configure MTN MoMo sandbox credentials?", priority: "normal", status: "open" }).returning();
    await tx.insert(S.ticketMessages).values({ ticketId: tk.id, authorId: uid.manager, body: "We would like to test collections in the sandbox. Which environment variables are needed?" });

    /* ---------- flush buffers (order respects FKs) ---------- */
    await bulk(tx, S.savingsAccounts as never, accRows.map((a) => ({ ...a, balance: String(accBal.get(a.id as string)!) })));
    await bulk(tx, S.contributionSchedules as never, schedRows);
    await bulk(tx, S.journalEntries as never, jes);
    await bulk(tx, S.journalLines as never, jls, 1500);
    await bulk(tx, S.loans as never, loanRows);
    await bulk(tx, S.loanApplications as never, appRows);
    await bulk(tx, S.loanSchedule as never, schedRowsDb);
    await bulk(tx, S.loanGuarantors as never, guarRows);
    await bulk(tx, S.loanCollaterals as never, collRows);
    await bulk(tx, S.transactions as never, txns, 500);
    await bulk(tx, S.loanRepayments as never, repayRows);
    await bulk(tx, S.withdrawalRequests as never, wrRows);
    await bulk(tx, S.groups as never, grows);
    await bulk(tx, S.groupMembers as never, gm);
    await bulk(tx, S.groupCycles as never, gcy);
    await bulk(tx, S.groupMeetings as never, gmt);
    await bulk(tx, S.meetingAttendance as never, matt);
    await bulk(tx, S.groupLoans as never, gloan);
    await bulk(tx, S.groupEntries as never, gent, 500);
    await bulk(tx, S.groupResolutions as never, gres);
    await bulk(tx, S.notifications as never, notif);
    // suspicious activity examples
    const bigDeposit = txns.filter((t) => t.type === "deposit").sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    flagRows.push({ orgId, kind: "large_amount", severity: "medium", detail: `deposit of UGX ${Number(bigDeposit.amount).toLocaleString("en-UG")} (${bigDeposit.reference}) at or above the large-transaction threshold`, transactionId: bigDeposit.id as string });
    flagRows.push({ orgId, kind: "rapid_withdrawals", severity: "high", detail: "3 withdrawals by the same member within 24 hours (demo example)" });
    await bulk(tx, S.fraudFlags as never, flagRows);

    /* counters so new records continue the sequences */
    const cRows = [{ orgId, key: "member", value: mems.length }, { orgId, key: "loan", value: loanList.length }, { orgId, key: "loan_application", value: appCount + 5 }, { orgId, key: "journal", value: jeSeq },
      ...mems.map((m) => ({ orgId, key: `acct:${m.id}`, value: m.accounts.length }))];
    await bulk(tx, S.counters as never, cRows);
    void counters;

    /* hash-chained audit trail */
    await audit(tx, orgId, { userId: uid.super_admin, name: "Demo Owner (Super Admin)" }, "org.seeded", "organisation", orgId, { note: "Demo workspace created with fictional data" });
    for (const l of loanList.slice(0, 20)) await audit(tx, orgId, { userId: treasurer, name: "Demo Treasurer" }, "loan.disbursed", "loan", l.id, { loanNo: l.no, demo: true });
    for (const l of loanList.slice(0, 8)) await audit(tx, orgId, { userId: chair, name: "Demo Chairperson" }, "loan.application_approved", "loan", l.id, { loanNo: l.no, demo: true });
    await audit(tx, orgId, { userId: uid.manager, name: "Demo Manager" }, "member.created", "member", mems[0].id, { memberNo: mems[0].no, demo: true });

    /* ---------- small tenants so platform admin has real data ---------- */
    const smallOrgs = [
      { name: "Mukono Boda Boda Savings Group", type: "vsla", plan: "starter", status: "active", n: 9 },
      { name: "Jinja Fishermen Cooperative Society", type: "cooperative", plan: "growth", status: "active", n: 12 },
      { name: "Kampala Teachers Investment Club", type: "investment_club", plan: "starter", status: "suspended", n: 6 },
    ];
    for (const so of smallOrgs) {
      const o = await createOrganisation(tx, { name: so.name, type: so.type, planCode: so.plan, isDemo: true, email: `contact@${so.name.split(" ")[0].toLowerCase()}.demo` });
      const [adm] = await tx.insert(S.users).values({ email: `admin@${so.name.split(" ")[0].toLowerCase()}.demo`, fullName: `${so.name.split(" ")[0]} Group Admin`, passwordHash: pw }).returning();
      await tx.insert(S.orgUsers).values({ orgId: o.id, userId: adm.id, role: "super_admin" });
      const smallMembers = Array.from({ length: so.n }, (_, i) => ({
        orgId: o.id, memberNo: `M${String(i + 1).padStart(5, "0")}`, fullName: `${pick(i % 2 ? FEMALE : MALE)} ${pick(LAST)}`, phone: `+2567${pick(["7", "8", "5"])}${String(between(1000000, 9999999))}`,
        district: pick(DISTRICTS), joinedAt: addMonths(today, -between(1, 10)), isDemo: true,
      }));
      await bulk(tx, S.members as never, smallMembers);
      await tx.insert(S.counters).values({ orgId: o.id, key: "member", value: so.n });
      if (so.status !== "active") await tx.update(S.organisations).set({ status: so.status }).where(eq(S.organisations.id, o.id));
    }
    await tx.insert(S.platformSettings).values([{ key: "maintenance_mode", value: false }, { key: "signup_enabled", value: true }, { key: "support_email", value: "support@softronics.example" }]).onConflictDoNothing();
  });
  return { skipped: false };
}

export const _sqlHelper = sql;
