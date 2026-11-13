import { describe, expect, it } from "vitest";
import {
  addMonths, allocateRepayment, assessEligibility, buildSchedule, earlySettlement, installmentCount, parBucket, penaltyCharge, reverseLines, shareOut, totalOutstanding, validateJournal, savingsInterest, type DueRow,
} from "@/lib/finance";
import { detectNetwork, formatUgPhone, normalizeUgPhone } from "@/lib/format";

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const toRows = (s: ReturnType<typeof buildSchedule>): DueRow[] => s.map((r) => ({ id: `r${r.installmentNo}`, ...r, principalPaid: 0, interestPaid: 0, penaltyAccrued: 0, penaltyPaid: 0 }));

describe("loan schedules", () => {
  it("flat rate: interest = principal x rate x term, principal repaid exactly", () => {
    const s = buildSchedule({ principal: 1_200_000, annualRatePct: 24, method: "flat", termMonths: 12, frequency: "monthly", startDate: "2025-01-15" });
    expect(s).toHaveLength(12);
    expect(sum(s.map((r) => r.principalDue))).toBe(1_200_000);
    expect(sum(s.map((r) => r.interestDue))).toBe(288_000);
    expect(s[0].dueDate).toBe("2025-02-15");
    expect(s[11].dueDate).toBe("2026-01-15");
  });
  it("flat rate with indivisible amounts still sums exactly (remainder in last installment)", () => {
    const s = buildSchedule({ principal: 1_000_003, annualRatePct: 18, method: "flat", termMonths: 7, frequency: "monthly", startDate: "2025-03-31" });
    expect(sum(s.map((r) => r.principalDue))).toBe(1_000_003);
    expect(sum(s.map((r) => r.interestDue))).toBe(Math.round((1_000_003 * 18 * 7) / 1200));
  });
  it("reducing balance: principal fully amortised, interest declines, payments near-equal", () => {
    const s = buildSchedule({ principal: 5_000_000, annualRatePct: 24, method: "reducing", termMonths: 10, frequency: "monthly", startDate: "2025-01-01" });
    expect(sum(s.map((r) => r.principalDue))).toBe(5_000_000);
    expect(s[0].interestDue).toBe(100_000); // 5,000,000 x 2%
    for (let i = 1; i < s.length; i++) expect(s[i].interestDue).toBeLessThanOrEqual(s[i - 1].interestDue);
    const pays = s.slice(0, -1).map((r) => r.principalDue + r.interestDue);
    expect(Math.max(...pays) - Math.min(...pays)).toBeLessThanOrEqual(2);
  });
  it("reducing balance at 0% interest is straight-line", () => {
    const s = buildSchedule({ principal: 600_000, annualRatePct: 0, method: "reducing", termMonths: 6, frequency: "monthly", startDate: "2025-01-01" });
    expect(s.every((r) => r.interestDue === 0 && r.principalDue === 100_000)).toBe(true);
  });
  it("weekly schedules use 7-day steps and ~52/12 installments per month", () => {
    expect(installmentCount(3, "weekly")).toBe(13);
    const s = buildSchedule({ principal: 130_000, annualRatePct: 12, method: "flat", termMonths: 3, frequency: "weekly", startDate: "2025-01-01" });
    expect(s).toHaveLength(13);
    expect(s[1].dueDate).toBe("2025-01-15");
  });
  it("month-end dates clamp (31 Jan + 1 month = 28 Feb)", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });
  it("rejects invalid input", () => {
    expect(() => buildSchedule({ principal: 0, annualRatePct: 10, method: "flat", termMonths: 3, frequency: "monthly", startDate: "2025-01-01" })).toThrow();
  });
});

describe("repayment allocation", () => {
  const rows = toRows(buildSchedule({ principal: 300_000, annualRatePct: 24, method: "flat", termMonths: 3, frequency: "monthly", startDate: "2025-01-01" }));
  it("allocates penalty, then interest, then principal on the oldest installment", () => {
    const r = rows.map((x) => ({ ...x }));
    r[0].penaltyAccrued = 5_000;
    const a = allocateRepayment(r, 20_000);
    expect(a.allocations[0]).toMatchObject({ scheduleId: "r1", penalty: 5_000, interest: 6_000, principal: 9_000 });
    expect(a.unallocated).toBe(0);
  });
  it("partial payments never over-allocate", () => {
    const a = allocateRepayment(rows, 3_000);
    expect(a.principal + a.interest + a.penalty).toBe(3_000);
    expect(a.interest).toBe(3_000);
  });
  it("advance (early) payments spill into future installments and overpayment is reported", () => {
    const total = sum(rows.map((r) => r.principalDue + r.interestDue));
    const a = allocateRepayment(rows, total + 777);
    expect(a.principal + a.interest).toBe(total);
    expect(a.unallocated).toBe(777);
    expect(a.allocations).toHaveLength(3);
  });
  it("total outstanding reflects payments", () => {
    const r = rows.map((x) => ({ ...x }));
    const a = allocateRepayment(r, 50_000);
    for (const al of a.allocations) { const t = r.find((x) => x.id === al.scheduleId)!; t.principalPaid += al.principal; t.interestPaid += al.interest; }
    const o = totalOutstanding(r);
    expect(o.principal + o.interest).toBe(sum(rows.map((x) => x.principalDue + x.interestDue)) - 50_000);
  });
  it("early settlement rebates interest on installments not yet due", () => {
    const s = earlySettlement(rows, "2025-02-01");
    expect(s.principal).toBe(300_000);
    expect(s.rebate).toBeGreaterThan(0);
    expect(s.interest + s.rebate).toBe(sum(rows.map((r) => r.interestDue)));
    expect(s.total).toBe(s.principal + s.interest + s.penalty);
  });
});

describe("penalties and risk buckets", () => {
  it("no penalty within grace, charged once per 30-day period after, never double-charged", () => {
    const base = { unpaid: 100_000, ratePct: 5, graceDays: 3, periodsCharged: 0 };
    expect(penaltyCharge({ ...base, daysOverdue: 3 }).amount).toBe(0);
    expect(penaltyCharge({ ...base, daysOverdue: 4 })).toEqual({ newPeriods: 1, amount: 5_000 });
    expect(penaltyCharge({ ...base, daysOverdue: 20, periodsCharged: 1 }).amount).toBe(0);
    expect(penaltyCharge({ ...base, daysOverdue: 40, periodsCharged: 1 })).toEqual({ newPeriods: 1, amount: 5_000 });
    expect(penaltyCharge({ ...base, daysOverdue: 100, periodsCharged: 0 }).newPeriods).toBe(4);
  });
  it("PAR buckets", () => {
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(parBucket)).toEqual(["Current", "1-30 days", "1-30 days", "31-60 days", "31-60 days", "61-90 days", "61-90 days", "90+ days (NPL)"]);
  });
});

describe("eligibility", () => {
  const product = { minAmount: 100_000, maxAmount: 10_000_000, minTermMonths: 1, maxTermMonths: 12, savingsMultiple: 3, minMembershipMonths: 3, guarantorsRequired: 1 };
  const base = { memberStatus: "active", savingsBalance: 1_000_000, outstandingPrincipal: 0, membershipMonths: 12, overdueLoans: 0, amount: 2_000_000, termMonths: 6, guarantorCover: 0, guarantorCount: 0, product };
  it("allows up to savings x multiple", () => { const r = assessEligibility(base); expect(r.eligible).toBe(true); expect(r.savingsLimit).toBe(3_000_000); });
  it("existing loans reduce the limit", () => expect(assessEligibility({ ...base, outstandingPrincipal: 1_500_000, amount: 2_000_000 }).eligible).toBe(false));
  it("guarantor cover can fill a shortfall", () => {
    expect(assessEligibility({ ...base, amount: 4_000_000 }).eligible).toBe(false);
    expect(assessEligibility({ ...base, amount: 4_000_000, guarantorCover: 1_000_000, guarantorCount: 1 }).eligible).toBe(true);
  });
  it("blocks suspended members, new members and members in arrears", () => {
    expect(assessEligibility({ ...base, memberStatus: "suspended" }).eligible).toBe(false);
    expect(assessEligibility({ ...base, membershipMonths: 1 }).eligible).toBe(false);
    expect(assessEligibility({ ...base, overdueLoans: 1 }).eligible).toBe(false);
  });
});

describe("savings interest and VSLA share-out", () => {
  it("interest on balance for days", () => expect(savingsInterest(1_000_000, 12, 30)).toBe(9_863));
  it("share-out distributes exactly the income pool and returns contributions", () => {
    const r = shareOut([{ memberId: "a", contributions: 100_000 }, { memberId: "b", contributions: 200_000 }, { memberId: "c", contributions: 300_001 }], 100_000);
    expect(sum(r.map((x) => x.profit))).toBe(100_000);
    expect(sum(r.map((x) => x.payout))).toBe(600_001 + 100_000);
    expect(r.find((x) => x.memberId === "c")!.profit).toBeGreaterThan(r.find((x) => x.memberId === "a")!.profit);
  });
  it("share-out with no contributions pays nothing", () => expect(shareOut([], 5000)).toEqual([]));
});

describe("journal validation", () => {
  it("accepts balanced entries and rejects unbalanced / malformed ones", () => {
    expect(validateJournal([{ accountId: "a", debit: 100, credit: 0 }, { accountId: "b", debit: 0, credit: 100 }])).toBeNull();
    expect(validateJournal([{ accountId: "a", debit: 100, credit: 0 }, { accountId: "b", debit: 0, credit: 99 }])).toMatch(/balance/);
    expect(validateJournal([{ accountId: "a", debit: 100, credit: 0 }])).toMatch(/two lines/);
    expect(validateJournal([{ accountId: "a", debit: 100, credit: 100 }, { accountId: "b", debit: 0, credit: 0 }])).toMatch(/exactly one/);
    expect(validateJournal([{ accountId: "a", debit: -5, credit: 0 }, { accountId: "b", debit: 0, credit: -5 }])).toMatch(/Negative/);
  });
  it("reversal swaps sides and stays balanced", () => {
    const l = [{ accountId: "a", debit: 70, credit: 0 }, { accountId: "b", debit: 0, credit: 70 }];
    const r = reverseLines(l);
    expect(r[0]).toMatchObject({ debit: 0, credit: 70 });
    expect(validateJournal(r)).toBeNull();
  });
});

describe("Uganda phone numbers", () => {
  it("normalises local and international formats", () => {
    for (const v of ["0772123456", "772123456", "256772123456", "+256 772 123 456", "0772-123-456"]) expect(normalizeUgPhone(v)).toBe("+256772123456");
    expect(normalizeUgPhone("12345")).toBeNull();
    expect(normalizeUgPhone("0572123456")).toBeNull();
    expect(formatUgPhone("0772123456")).toBe("+256 772 123 456");
  });
  it("detects MTN and Airtel", () => { expect(detectNetwork("0772123456")).toBe("mtn_momo"); expect(detectNetwork("0752123456")).toBe("airtel_money"); });
});
