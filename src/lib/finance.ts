/**
 * Pure financial calculations (no I/O). All amounts are whole Uganda Shillings held as
 * JS integers and rounded explicitly at every step (UGX has no practical minor unit).
 * The database stores them as numeric(18,2); sums are always done in SQL on numeric.
 * Integer arithmetic keeps results exact and reproducible - no float drift accumulates
 * because every intermediate monetary value is rounded to an integer.
 */

export type InterestMethod = "flat" | "reducing";
export type LoanFrequency = "weekly" | "monthly";

export const round = (n: number) => Math.round(n);
export const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/* ---------------- dates (ISO yyyy-mm-dd, UTC arithmetic, no timezone drift) ---------------- */
export function parseISO(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
export function toISO(d: Date) {
  return d.toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
export function addMonths(iso: string, n: number) {
  const d = parseISO(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toISO(d);
}
export function daysBetween(fromISO: string, toISOStr: string) {
  return Math.round((parseISO(toISOStr).getTime() - parseISO(fromISO).getTime()) / 86400000);
}
export function monthsBetween(fromISO: string, toISOStr: string) {
  const a = parseISO(fromISO), b = parseISO(toISOStr);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}
/** Today's date in East Africa Time (Africa/Kampala, UTC+3) as ISO date */
export function todayEAT(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/* ---------------- loan schedules ---------------- */
export function installmentCount(termMonths: number, frequency: LoanFrequency) {
  return frequency === "weekly" ? Math.max(1, Math.round((termMonths * 52) / 12)) : termMonths;
}

export type ScheduleRow = { installmentNo: number; dueDate: string; principalDue: number; interestDue: number };

export function buildSchedule(p: {
  principal: number; annualRatePct: number; method: InterestMethod; termMonths: number; frequency: LoanFrequency; startDate: string;
}): ScheduleRow[] {
  const P = round(p.principal);
  if (P <= 0) throw new Error("Principal must be positive");
  if (p.termMonths <= 0) throw new Error("Term must be positive");
  const n = installmentCount(p.termMonths, p.frequency);
  const ppy = p.frequency === "weekly" ? 52 : 12;
  const due = (k: number) => (p.frequency === "weekly" ? addDays(p.startDate, 7 * k) : addMonths(p.startDate, k));
  const rows: ScheduleRow[] = [];

  if (p.method === "flat") {
    const totalInterest = round((P * p.annualRatePct * p.termMonths) / 1200);
    const basePrin = Math.floor(P / n), baseInt = Math.floor(totalInterest / n);
    for (let k = 1; k <= n; k++) {
      rows.push({
        installmentNo: k, dueDate: due(k),
        principalDue: k === n ? P - basePrin * (n - 1) : basePrin,
        interestDue: k === n ? totalInterest - baseInt * (n - 1) : baseInt,
      });
    }
    return rows;
  }
  // reducing balance (annuity)
  const i = p.annualRatePct / 100 / ppy;
  const payment = i === 0 ? P / n : (P * i) / (1 - Math.pow(1 + i, -n));
  let bal = P;
  for (let k = 1; k <= n; k++) {
    const interest = round(bal * i);
    let principal = k === n ? bal : round(payment) - interest;
    if (principal > bal) principal = bal;
    if (principal < 0) principal = 0;
    rows.push({ installmentNo: k, dueDate: due(k), principalDue: principal, interestDue: interest });
    bal -= principal;
  }
  return rows;
}

export type DueRow = {
  id: string; installmentNo: number; dueDate: string;
  principalDue: number; interestDue: number; principalPaid: number; interestPaid: number;
  penaltyAccrued: number; penaltyPaid: number;
};
export type Allocation = { scheduleId: string; principal: number; interest: number; penalty: number };

export const rowOutstanding = (r: DueRow) => ({
  principal: r.principalDue - r.principalPaid,
  interest: r.interestDue - r.interestPaid,
  penalty: r.penaltyAccrued - r.penaltyPaid,
});

/** Oldest installment first; within an installment: penalty -> interest -> principal. Supports partial and advance (early) payments. */
export function allocateRepayment(rows: DueRow[], amount: number) {
  let left = round(amount);
  const allocations: Allocation[] = [];
  for (const r of [...rows].sort((a, b) => a.installmentNo - b.installmentNo)) {
    if (left <= 0) break;
    const o = rowOutstanding(r);
    const penalty = Math.min(left, Math.max(0, o.penalty)); left -= penalty;
    const interest = Math.min(left, Math.max(0, o.interest)); left -= interest;
    const principal = Math.min(left, Math.max(0, o.principal)); left -= principal;
    if (penalty + interest + principal > 0) allocations.push({ scheduleId: r.id, principal, interest, penalty });
  }
  const sum = (k: "principal" | "interest" | "penalty") => allocations.reduce((s, a) => s + a[k], 0);
  return { allocations, principal: sum("principal"), interest: sum("interest"), penalty: sum("penalty"), unallocated: left };
}

export function totalOutstanding(rows: DueRow[]) {
  return rows.reduce((t, r) => {
    const o = rowOutstanding(r);
    return { principal: t.principal + o.principal, interest: t.interest + o.interest, penalty: t.penalty + o.penalty };
  }, { principal: 0, interest: 0, penalty: 0 });
}

/** Early settlement: all principal + penalties + interest only on installments already due; future interest is rebated. */
export function earlySettlement(rows: DueRow[], today: string) {
  let principal = 0, interest = 0, penalty = 0, rebate = 0;
  for (const r of rows) {
    const o = rowOutstanding(r);
    principal += o.principal; penalty += o.penalty;
    if (r.dueDate <= today) interest += o.interest; else rebate += o.interest;
  }
  return { principal, interest, penalty, rebate, total: principal + interest + penalty };
}

/** Penalty accrual: charged once per 30-day overdue period after grace. Never double-charges (uses periodsCharged). */
export function penaltyCharge(p: { unpaid: number; ratePct: number; daysOverdue: number; graceDays: number; periodsCharged: number }) {
  if (p.unpaid <= 0 || p.ratePct <= 0 || p.daysOverdue <= p.graceDays) return { newPeriods: 0, amount: 0 };
  const periods = Math.floor((p.daysOverdue - p.graceDays - 1) / 30) + 1;
  const newPeriods = Math.max(0, periods - p.periodsCharged);
  return { newPeriods, amount: newPeriods * round((p.unpaid * p.ratePct) / 100) };
}

export function parBucket(daysOverdue: number) {
  if (daysOverdue <= 0) return "Current";
  if (daysOverdue <= 30) return "1-30 days";
  if (daysOverdue <= 60) return "31-60 days";
  if (daysOverdue <= 90) return "61-90 days";
  return "90+ days (NPL)";
}

/* ---------------- eligibility ---------------- */
export function assessEligibility(p: {
  memberStatus: string; savingsBalance: number; outstandingPrincipal: number; membershipMonths: number; overdueLoans: number;
  amount: number; termMonths: number; guarantorCover: number;
  product: { minAmount: number; maxAmount: number; minTermMonths: number; maxTermMonths: number; savingsMultiple: number; minMembershipMonths: number; guarantorsRequired: number };
  guarantorCount: number;
}) {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const pr = p.product;
  const savingsLimit = Math.max(0, round(p.savingsBalance * pr.savingsMultiple) - p.outstandingPrincipal);
  const maxAmount = Math.min(pr.maxAmount, savingsLimit);
  if (p.memberStatus !== "active") reasons.push("Member is not active");
  if (p.membershipMonths < pr.minMembershipMonths) reasons.push(`Membership must be at least ${pr.minMembershipMonths} months (currently ${p.membershipMonths})`);
  if (p.overdueLoans > 0) reasons.push("Member has overdue loan(s)");
  if (p.amount < pr.minAmount) reasons.push("Amount is below the product minimum");
  if (p.amount > pr.maxAmount) reasons.push("Amount exceeds the product maximum");
  if (p.termMonths < pr.minTermMonths || p.termMonths > pr.maxTermMonths) reasons.push(`Term must be ${pr.minTermMonths}-${pr.maxTermMonths} months`);
  const shortfall = Math.max(0, p.amount - savingsLimit);
  if (shortfall > 0) {
    if (p.guarantorCover >= shortfall) warnings.push("Amount exceeds savings-based limit but is covered by guarantors");
    else reasons.push(`Amount exceeds savings-based limit (${savingsLimit.toLocaleString("en-UG")}) and guarantor cover is insufficient`);
  }
  if (p.guarantorCount < pr.guarantorsRequired) warnings.push(`${pr.guarantorsRequired} guarantor(s) required; ${p.guarantorCount} added`);
  return { eligible: reasons.length === 0, reasons, warnings, savingsLimit, maxAmount, shortfall };
}

/* ---------------- savings interest & VSLA share-out ---------------- */
export function savingsInterest(balance: number, annualRatePct: number, days: number) {
  return round((balance * annualRatePct * days) / 36500);
}

/** Share-out: each member gets their contributions back plus a pro-rata share of fund income. Remainder goes to the largest saver so totals reconcile exactly. */
export function shareOut(members: { memberId: string; contributions: number }[], income: number) {
  const total = members.reduce((s, m) => s + m.contributions, 0);
  const rows = members.map((m) => ({
    memberId: m.memberId,
    contributions: m.contributions,
    profit: total > 0 ? Math.floor((income * m.contributions) / total) : 0,
  }));
  const distributed = rows.reduce((s, r) => s + r.profit, 0);
  let rem = round(income) - distributed;
  if (rem !== 0 && rows.length) {
    const top = rows.reduce((a, b) => (b.contributions > a.contributions ? b : a));
    top.profit += rem; rem = 0;
  }
  return rows.map((r) => ({ ...r, payout: r.contributions + r.profit }));
}

/* ---------------- accounting helpers ---------------- */
export type Line = { accountId: string; debit: number; credit: number; memo?: string };
export function validateJournal(lines: Line[]) {
  if (lines.length < 2) return "A journal entry needs at least two lines";
  let d = 0, c = 0;
  for (const l of lines) {
    if (l.debit < 0 || l.credit < 0) return "Negative amounts are not allowed";
    if ((l.debit > 0) === (l.credit > 0)) return "Each line must have exactly one of debit or credit";
    d += l.debit; c += l.credit;
  }
  return d === c ? null : `Entry does not balance: debits ${d} vs credits ${c}`;
}
export const reverseLines = (lines: Line[]): Line[] => lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit, memo: `Reversal: ${l.memo ?? ""}`.trim() }));
