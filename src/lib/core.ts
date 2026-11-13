import { createHash, randomBytes } from "crypto";
import { and, eq, sql, desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, counters, glAccounts, journalEntries, journalLines, organisations } from "@/db/schema";
import { validateJournal, type Line } from "@/lib/finance";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Org = typeof organisations.$inferSelect;

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

/* ---------------- policies ---------------- */
export type OrgSettings = {
  makerChecker: boolean;          // approver must differ from requester/applicant
  singleTxnLimit: number;         // hard limit per transaction (UGX) - above this is blocked
  largeTxnFlag: number;           // flag as suspicious at/above this amount
  duplicateWindowMinutes: number; // identical txn inside window is blocked unless confirmed
  membershipFee: number;
  smsEnabled: boolean;
  emailEnabled: boolean;
  whatsappEnabled: boolean;
  repaymentReminderDays: number;
  allowEarlySettlement: boolean;
};
export const DEFAULT_SETTINGS: OrgSettings = {
  makerChecker: true, singleTxnLimit: 20_000_000, largeTxnFlag: 3_000_000, duplicateWindowMinutes: 10, membershipFee: 20_000,
  smsEnabled: true, emailEnabled: false, whatsappEnabled: false, repaymentReminderDays: 3, allowEarlySettlement: true,
};
export const getSettings = (org: Pick<Org, "settings">): OrgSettings => ({ ...DEFAULT_SETTINGS, ...(org.settings as Partial<OrgSettings>) });

/* ---------------- references & counters ---------------- */
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRef(prefix: string, date = new Date()) {
  const b = randomBytes(6);
  let s = "";
  for (const x of b) s += B32[x % 32];
  const yymmdd = date.toISOString().slice(2, 10).replace(/-/g, "");
  return `${prefix}-${yymmdd}-${s}`;
}

export async function nextSeq(tx: Tx, orgId: string, key: string) {
  const r = await tx.insert(counters).values({ orgId, key, value: 1 })
    .onConflictDoUpdate({ target: [counters.orgId, counters.key], set: { value: sql`${counters.value} + 1` } })
    .returning({ value: counters.value });
  return r[0].value;
}

/* ---------------- audit (hash-chained, append-only) ---------------- */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const hashOf = (prev: string | null, f: { orgId: string | null; userId: string | null; action: string; entityType: string | null; entityId: string | null; detail: unknown; at: string }) =>
  createHash("sha256").update(prev ?? "GENESIS").update(stable([f.orgId, f.userId, f.action, f.entityType, f.entityId, f.detail, f.at])).digest("hex");

export type Actor = { userId: string | null; name?: string | null };

export async function audit(tx: Tx, orgId: string | null, actor: Actor, action: string, entityType?: string | null, entityId?: string | null, detail: Record<string, unknown> = {}) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId ?? "platform"}))`);
  const prev = await tx.select({ hash: auditLogs.hash }).from(auditLogs)
    .where(orgId ? eq(auditLogs.orgId, orgId) : sql`${auditLogs.orgId} is null`).orderBy(desc(auditLogs.id)).limit(1);
  const at = new Date();
  const safeDetail = JSON.parse(JSON.stringify(detail));
  const hash = hashOf(prev[0]?.hash ?? null, { orgId, userId: actor.userId, action, entityType: entityType ?? null, entityId: entityId ?? null, detail: safeDetail, at: at.toISOString() });
  await tx.insert(auditLogs).values({
    orgId, userId: actor.userId, userName: actor.name ?? null, action, entityType: entityType ?? null, entityId: entityId ?? null,
    detail: safeDetail, prevHash: prev[0]?.hash ?? null, hash, createdAt: at,
  });
}

export async function auditStandalone(orgId: string | null, actor: Actor, action: string, entityType?: string, entityId?: string, detail: Record<string, unknown> = {}) {
  await db.transaction((tx) => audit(tx, orgId, actor, action, entityType, entityId, detail));
}

export async function verifyAuditChain(orgId: string) {
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.orgId, orgId)).orderBy(auditLogs.id);
  let prev: string | null = null;
  for (const r of rows) {
    const h = hashOf(prev, { orgId: r.orgId, userId: r.userId, action: r.action, entityType: r.entityType, entityId: r.entityId, detail: r.detail, at: r.createdAt.toISOString() });
    if (h !== r.hash || r.prevHash !== prev) return { ok: false, checked: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, checked: rows.length, brokenAt: null as number | null };
}

/* ---------------- chart of accounts & journal ---------------- */
export const COA: { code: string; name: string; type: "asset" | "liability" | "equity" | "income" | "expense"; isCash?: boolean }[] = [
  { code: "1000", name: "Cash on Hand", type: "asset", isCash: true },
  { code: "1010", name: "Bank Account", type: "asset", isCash: true },
  { code: "1020", name: "MTN Mobile Money Wallet", type: "asset", isCash: true },
  { code: "1030", name: "Airtel Money Wallet", type: "asset", isCash: true },
  { code: "1100", name: "Loans Receivable - Members", type: "asset" },
  { code: "1150", name: "Group Loans Receivable", type: "asset" },
  { code: "1200", name: "Accounts Receivable", type: "asset" },
  { code: "1500", name: "Fixed Assets (Furniture & Equipment)", type: "asset" },
  { code: "2000", name: "Member Savings Deposits", type: "liability" },
  { code: "2100", name: "Accounts Payable", type: "liability" },
  { code: "2200", name: "Group Share Funds Payable", type: "liability" },
  { code: "2300", name: "Group Social & Emergency Funds", type: "liability" },
  { code: "3000", name: "Share Capital", type: "equity" },
  { code: "3100", name: "Reserves & Retained Earnings", type: "equity" },
  { code: "4000", name: "Loan Interest Income", type: "income" },
  { code: "4010", name: "Penalty & Fine Income", type: "income" },
  { code: "4020", name: "Fees Income (Processing & Membership)", type: "income" },
  { code: "4030", name: "Other Income", type: "income" },
  { code: "5000", name: "Salaries & Allowances", type: "expense" },
  { code: "5010", name: "Rent & Utilities", type: "expense" },
  { code: "5020", name: "Administration & Stationery", type: "expense" },
  { code: "5030", name: "Interest on Member Savings", type: "expense" },
  { code: "5040", name: "Mobile Money & Bank Charges", type: "expense" },
  { code: "5050", name: "Bad Debts Written Off", type: "expense" },
  { code: "5060", name: "Meetings & Transport", type: "expense" },
];
export const CHANNEL_ACCOUNT: Record<string, string> = { cash: "1000", manual: "1000", bank: "1010", mtn_momo: "1020", airtel_money: "1030" };

export async function seedChartOfAccounts(tx: Tx, orgId: string) {
  await tx.insert(glAccounts).values(COA.map((a) => ({ orgId, code: a.code, name: a.name, type: a.type, isCash: !!a.isCash, isSystem: true }))).onConflictDoNothing();
}

export async function accountMap(tx: Tx, orgId: string) {
  const rows = await tx.select({ id: glAccounts.id, code: glAccounts.code }).from(glAccounts).where(eq(glAccounts.orgId, orgId));
  const m = new Map(rows.map((r) => [r.code, r.id]));
  return (code: string) => {
    const id = m.get(code);
    if (!id) throw new AppError(`GL account ${code} is missing from the chart of accounts`, 500);
    return id;
  };
}

export type JournalInput = {
  orgId: string; date: string; description: string; lines: Line[];
  source?: "system" | "manual" | "adjustment" | "reversal"; sourceType?: string; sourceId?: string; createdBy?: string | null; reversalOfId?: string;
};
/** Posts a balanced journal entry. Unbalanced entries are rejected here AND by a deferred DB trigger. */
export async function postJournal(tx: Tx, j: JournalInput) {
  const err = validateJournal(j.lines);
  if (err) throw new AppError(err);
  const n = await nextSeq(tx, j.orgId, "journal");
  const entryNo = `JE-${String(n).padStart(6, "0")}`;
  const [e] = await tx.insert(journalEntries).values({
    orgId: j.orgId, entryNo, entryDate: j.date, description: j.description, source: j.source ?? "system",
    sourceType: j.sourceType, sourceId: j.sourceId, createdBy: j.createdBy ?? null, reversalOfId: j.reversalOfId,
  }).returning({ id: journalEntries.id });
  await tx.insert(journalLines).values(j.lines.map((l) => ({
    orgId: j.orgId, entryId: e.id, accountId: l.accountId, debit: String(l.debit), credit: String(l.credit), memo: l.memo ?? null,
  })));
  return { id: e.id, entryNo };
}

export const allowLedgerWrite = (tx: Tx) => tx.execute(sql`select set_config('app.ledger_write', 'on', true)`);

export const orgScope = <T extends { orgId: unknown }>(table: T, orgId: string) => eq(table.orgId as never, orgId);
export { and, eq };
