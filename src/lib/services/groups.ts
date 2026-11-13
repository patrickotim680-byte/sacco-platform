import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  groupCycles, groupEntries, groupLoans, groupMeetings, groupMembers, groupResolutions, groups, meetingAttendance, members,
} from "@/db/schema";
import { AppError, accountMap, allowLedgerWrite, audit, newRef, postJournal, type Tx } from "@/lib/core";
import { shareOut, todayEAT, type Line } from "@/lib/finance";
import { assertFunds, friendly, type Svc } from "@/lib/services/savings";
import { ugx } from "@/lib/format";

export type GroupRules = { sharePrice: number; maxSharesPerMeeting: number; loanInterestPct: number; socialFundContribution: number; lateFine: number; absentFine: number; loanMultipleOfSavings: number };
export const DEFAULT_RULES: GroupRules = { sharePrice: 2000, maxSharesPerMeeting: 5, loanInterestPct: 10, socialFundContribution: 1000, lateFine: 500, absentFine: 1000, loanMultipleOfSavings: 3 };

export const ENTRY_KINDS = ["share", "social_fund", "emergency_fund", "fine", "loan_out", "loan_repayment", "rotating_contribution", "rotating_payout", "fund_payout", "share_out"] as const;

export async function createGroup(svc: Svc, i: { name: string; kind: string; location?: string; registrationNo?: string; constitution?: string; rules?: Partial<GroupRules> }) {
  if (!i.name.trim()) throw new AppError("Group name is required");
  return db.transaction(async (tx) => {
    const [g] = await tx.insert(groups).values({ orgId: svc.orgId, name: i.name, kind: i.kind, location: i.location, registrationNo: i.registrationNo, constitution: i.constitution, rules: { ...DEFAULT_RULES, ...i.rules } }).returning();
    await audit(tx, svc.orgId, svc.actor, "group.created", "group", g.id, { name: g.name });
    return g;
  });
}
export async function updateGroupRules(svc: Svc, groupId: string, rules: GroupRules, constitution: string) {
  await db.transaction(async (tx) => {
    const r = await tx.update(groups).set({ rules, constitution }).where(and(eq(groups.id, groupId), eq(groups.orgId, svc.orgId))).returning({ id: groups.id });
    if (!r[0]) throw new AppError("Group not found", 404);
    await audit(tx, svc.orgId, svc.actor, "group.rules_updated", "group", groupId, { rules });
  });
}
export async function addGroupMember(svc: Svc, groupId: string, memberId: string, role: string) {
  const [g] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, svc.orgId)));
  const [m] = await db.select({ id: members.id }).from(members).where(and(eq(members.id, memberId), eq(members.orgId, svc.orgId)));
  if (!g || !m) throw new AppError("Group or member not found", 404);
  await db.transaction(async (tx) => {
    await tx.insert(groupMembers).values({ orgId: svc.orgId, groupId, memberId, role, joinedAt: todayEAT() }).onConflictDoUpdate({ target: [groupMembers.groupId, groupMembers.memberId], set: { role } });
    await audit(tx, svc.orgId, svc.actor, "group.member_set", "group", groupId, { memberId, role });
  });
}
export async function removeGroupMember(svc: Svc, groupId: string, memberId: string) {
  await db.delete(groupMembers).where(and(eq(groupMembers.orgId, svc.orgId), eq(groupMembers.groupId, groupId), eq(groupMembers.memberId, memberId)));
}
export async function openCycle(svc: Svc, groupId: string, i: { name: string; startDate: string; endDate: string; savingsTarget: number }) {
  if (i.endDate <= i.startDate) throw new AppError("End date must be after the start date");
  const [open] = await db.select({ id: groupCycles.id }).from(groupCycles).where(and(eq(groupCycles.groupId, groupId), eq(groupCycles.orgId, svc.orgId), eq(groupCycles.status, "open")));
  if (open) throw new AppError("Close the current savings cycle before opening a new one");
  const [g] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, svc.orgId)));
  if (!g) throw new AppError("Group not found", 404);
  await db.transaction(async (tx) => {
    const [c] = await tx.insert(groupCycles).values({ orgId: svc.orgId, groupId, name: i.name, startDate: i.startDate, endDate: i.endDate, savingsTarget: String(i.savingsTarget || 0) }).returning();
    await audit(tx, svc.orgId, svc.actor, "group.cycle_opened", "group_cycle", c.id, { name: i.name });
  });
}

/** Records a group money event and the matching GL entry atomically. */
export async function recordGroupEntry(svc: Svc, i: { groupId: string; memberId?: string; kind: string; amount: number; shares?: number; note?: string; meetingId?: string; date?: string; loanId?: string; dueDate?: string }) {
  if (!(ENTRY_KINDS as readonly string[]).includes(i.kind)) throw new AppError("Unknown entry type");
  if (!Number.isInteger(i.amount) || i.amount <= 0) throw new AppError("Amount must be a positive whole number of shillings");
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [g] = await tx.select().from(groups).where(and(eq(groups.id, i.groupId), eq(groups.orgId, svc.orgId)));
      if (!g) throw new AppError("Group not found", 404);
      const [cycle] = await tx.select().from(groupCycles).where(and(eq(groupCycles.groupId, g.id), eq(groupCycles.status, "open")));
      if (!cycle && i.kind !== "share_out") throw new AppError("Open a savings cycle before recording entries");
      if (i.memberId) {
        const [gm] = await tx.select().from(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.memberId, i.memberId)));
        if (!gm) throw new AppError("Member does not belong to this group");
      } else if (!["fund_payout"].includes(i.kind)) throw new AppError("Select a member");
      const rules = g.rules;
      let shares = 0, interestPortion = 0;
      const date = i.date ?? todayEAT();
      const acct = await accountMap(tx, svc.orgId);
      const cash = acct("1000");
      let lines: Line[];
      const amt = i.amount;
      switch (i.kind) {
        case "share": {
          shares = i.shares ?? Math.round(amt / rules.sharePrice);
          if (shares < 1 || shares * rules.sharePrice !== amt) throw new AppError(`Amount must equal shares x share price (${ugx(rules.sharePrice)})`);
          if (shares > rules.maxSharesPerMeeting) throw new AppError(`Maximum ${rules.maxSharesPerMeeting} shares per meeting`);
          if (i.meetingId) {
            const [s] = await tx.select({ s: sql<number>`coalesce(sum(${groupEntries.shares}),0)` }).from(groupEntries).where(and(eq(groupEntries.meetingId, i.meetingId), eq(groupEntries.memberId, i.memberId!), eq(groupEntries.kind, "share")));
            if (Number(s.s) + shares > rules.maxSharesPerMeeting) throw new AppError(`Member would exceed ${rules.maxSharesPerMeeting} shares for this meeting`);
          }
          lines = [{ accountId: cash, debit: amt, credit: 0 }, { accountId: acct("2200"), debit: 0, credit: amt }]; break;
        }
        case "rotating_contribution": lines = [{ accountId: cash, debit: amt, credit: 0 }, { accountId: acct("2200"), debit: 0, credit: amt }]; break;
        case "social_fund": case "emergency_fund": lines = [{ accountId: cash, debit: amt, credit: 0 }, { accountId: acct("2300"), debit: 0, credit: amt }]; break;
        case "fine": lines = [{ accountId: cash, debit: amt, credit: 0 }, { accountId: acct("4010"), debit: 0, credit: amt }]; break;
        case "loan_out": {
          const [sv] = await tx.select({ s: sql<string>`coalesce(sum(${groupEntries.amount}),0)` }).from(groupEntries).where(and(eq(groupEntries.groupId, g.id), eq(groupEntries.cycleId, cycle.id), eq(groupEntries.memberId, i.memberId!), eq(groupEntries.kind, "share")));
          const [ol] = await tx.select({ s: sql<string>`coalesce(sum(${groupLoans.principal} - ${groupLoans.repaid}),0)` }).from(groupLoans).where(and(eq(groupLoans.groupId, g.id), eq(groupLoans.memberId, i.memberId!), eq(groupLoans.status, "active")));
          const limit = Number(sv.s) * rules.loanMultipleOfSavings - Number(ol.s);
          if (amt > limit) throw new AppError(`Exceeds member's group borrowing limit (${rules.loanMultipleOfSavings}x savings): available ${ugx(Math.max(0, limit))}`);
          await assertFunds(tx, svc.orgId, "cash", amt);
          lines = [{ accountId: acct("1150"), debit: amt, credit: 0 }, { accountId: cash, debit: 0, credit: amt }]; break;
        }
        case "loan_repayment": {
          const [gl] = await tx.select().from(groupLoans).where(and(eq(groupLoans.id, i.loanId ?? ""), eq(groupLoans.groupId, g.id))).for("update");
          if (!gl || gl.status !== "active") throw new AppError("Select an active group loan");
          const totalDue = Number(gl.principal) + Number(gl.interestDue);
          const repaidBefore = Number(gl.repaid);
          if (repaidBefore + amt > totalDue) throw new AppError(`Exceeds amount owing (${ugx(totalDue - repaidBefore)})`);
          const iDue = Number(gl.interestDue);
          interestPortion = Math.min(repaidBefore + amt, iDue) - Math.min(repaidBefore, iDue);
          await tx.update(groupLoans).set({ repaid: String(repaidBefore + amt), status: repaidBefore + amt >= totalDue ? "repaid" : "active" }).where(eq(groupLoans.id, gl.id));
          lines = [{ accountId: cash, debit: amt, credit: 0 }];
          if (amt - interestPortion > 0) lines.push({ accountId: acct("1150"), debit: 0, credit: amt - interestPortion });
          if (interestPortion > 0) lines.push({ accountId: acct("4000"), debit: 0, credit: interestPortion });
          i.memberId = gl.memberId; break;
        }
        case "rotating_payout": await assertFunds(tx, svc.orgId, "cash", amt); lines = [{ accountId: acct("2200"), debit: amt, credit: 0 }, { accountId: cash, debit: 0, credit: amt }]; break;
        case "fund_payout": await assertFunds(tx, svc.orgId, "cash", amt); lines = [{ accountId: acct("2300"), debit: amt, credit: 0 }, { accountId: cash, debit: 0, credit: amt }]; break;
        default: throw new AppError("Unsupported entry type");
      }
      const reference = newRef("GR");
      const je = await postJournal(tx, { orgId: svc.orgId, date, description: `${g.name}: ${i.kind.replace("_", " ")} ${reference}`, sourceType: "group_entry", createdBy: svc.actor.userId, lines });
      void je;
      let loanId = i.loanId;
      if (i.kind === "loan_out") {
        const [gl] = await tx.insert(groupLoans).values({ orgId: svc.orgId, groupId: g.id, cycleId: cycle.id, memberId: i.memberId!, principal: String(amt), interestDue: String(Math.round((amt * rules.loanInterestPct) / 100)), dueDate: i.dueDate ?? todayEAT() }).returning({ id: groupLoans.id });
        loanId = gl.id;
      }
      const [e] = await tx.insert(groupEntries).values({
        orgId: svc.orgId, groupId: g.id, cycleId: cycle?.id, memberId: i.memberId ?? null, meetingId: i.meetingId, kind: i.kind, amount: String(amt), shares,
        interestPortion: String(interestPortion), loanId, note: i.note, reference, entryDate: date, createdBy: svc.actor.userId,
      }).returning({ id: groupEntries.id });
      await audit(tx, svc.orgId, svc.actor, `group.${i.kind}`, "group_entry", e.id, { reference, amount: amt, group: g.name });
      return { reference };
    });
  } catch (e) { throw friendly(e); }
}

export async function groupPosition(groupId: string, cycleId: string) {
  const rows = await db.select({ kind: groupEntries.kind, amount: sql<string>`sum(${groupEntries.amount})`, interest: sql<string>`sum(${groupEntries.interestPortion})` }).from(groupEntries)
    .where(and(eq(groupEntries.groupId, groupId), eq(groupEntries.cycleId, cycleId))).groupBy(groupEntries.kind);
  const k = (x: string) => Number(rows.find((r) => r.kind === x)?.amount ?? 0);
  const interestIncome = Number(rows.find((r) => r.kind === "loan_repayment")?.interest ?? 0);
  const [outLoans] = await db.select({ s: sql<string>`coalesce(sum(${groupLoans.principal} - least(${groupLoans.repaid}, ${groupLoans.principal})),0)` }).from(groupLoans).where(and(eq(groupLoans.groupId, groupId), eq(groupLoans.cycleId, cycleId)));
  const shares = k("share"), fines = k("fine"), social = k("social_fund"), emergency = k("emergency_fund");
  const cashInBox = shares + k("rotating_contribution") + social + emergency + fines + k("loan_repayment") - k("loan_out") - k("rotating_payout") - k("fund_payout") - k("share_out");
  return { shares, fines, social, emergency, interestIncome, income: fines + interestIncome, loansOut: Number(outLoans.s), cashInBox, rotatingIn: k("rotating_contribution"), rotatingOut: k("rotating_payout"), fundPayouts: k("fund_payout") };
}

export async function computeShareOut(groupId: string, cycleId: string) {
  const rows = await db.select({ memberId: groupEntries.memberId, c: sql<string>`sum(${groupEntries.amount})` }).from(groupEntries)
    .where(and(eq(groupEntries.groupId, groupId), eq(groupEntries.cycleId, cycleId), eq(groupEntries.kind, "share"))).groupBy(groupEntries.memberId);
  const pos = await groupPosition(groupId, cycleId);
  return { rows: shareOut(rows.map((r) => ({ memberId: r.memberId!, contributions: Number(r.c) })), pos.income), income: pos.income, pos };
}

export async function closeCycle(svc: Svc, groupId: string, cycleId: string) {
  try {
    return await db.transaction(async (tx) => {
      await allowLedgerWrite(tx);
      const [c] = await tx.select().from(groupCycles).where(and(eq(groupCycles.id, cycleId), eq(groupCycles.groupId, groupId), eq(groupCycles.orgId, svc.orgId))).for("update");
      if (!c || c.status !== "open") throw new AppError("Cycle is not open");
      const [active] = await tx.select({ n: sql<number>`count(*)` }).from(groupLoans).where(and(eq(groupLoans.cycleId, cycleId), eq(groupLoans.status, "active")));
      if (Number(active.n) > 0) throw new AppError(`${active.n} group loan(s) are still outstanding. Collect them before closing the cycle.`);
      const so = await computeShareOut(groupId, cycleId);
      const total = so.rows.reduce((s, r) => s + r.payout, 0);
      if (total > 0) {
        await assertFunds(tx, svc.orgId, "cash", total);
        const acct = await accountMap(tx, svc.orgId);
        const contrib = so.rows.reduce((s, r) => s + r.contributions, 0), profit = total - contrib;
        const lines: Line[] = [{ accountId: acct("2200"), debit: contrib, credit: 0 }, { accountId: acct("1000"), debit: 0, credit: total }];
        if (profit > 0) lines.push({ accountId: acct("5030"), debit: profit, credit: 0 });
        await postJournal(tx, { orgId: svc.orgId, date: todayEAT(), description: `Share-out for cycle ${c.name}`, sourceType: "group_entry", createdBy: svc.actor.userId, lines });
        await tx.insert(groupEntries).values(so.rows.filter((r) => r.payout > 0).map((r) => ({
          orgId: svc.orgId, groupId, cycleId, memberId: r.memberId, kind: "share_out", amount: String(r.payout), reference: newRef("GR"), entryDate: todayEAT(), createdBy: svc.actor.userId, note: `Contributions ${r.contributions} + profit ${r.profit}`,
        })));
      }
      await tx.update(groupCycles).set({ status: "closed", closedAt: new Date(), shareOut: so }).where(eq(groupCycles.id, cycleId));
      await audit(tx, svc.orgId, svc.actor, "group.cycle_closed", "group_cycle", cycleId, { total, income: so.income });
      return { total };
    });
  } catch (e) { throw friendly(e); }
}

/* meetings */
export async function scheduleMeeting(svc: Svc, groupId: string, i: { date: string; venue?: string; agenda?: string }) {
  const [g] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, svc.orgId)));
  if (!g) throw new AppError("Group not found", 404);
  const [c] = await db.select({ id: groupCycles.id }).from(groupCycles).where(and(eq(groupCycles.groupId, groupId), eq(groupCycles.status, "open")));
  await db.insert(groupMeetings).values({ orgId: svc.orgId, groupId, cycleId: c?.id, meetingDate: i.date, venue: i.venue, agenda: i.agenda });
}
export async function recordMeeting(svc: Svc, meetingId: string, i: { minutes: string; attendance: { memberId: string; status: string }[]; applyFines: boolean }) {
  const [m] = await db.select().from(groupMeetings).where(and(eq(groupMeetings.id, meetingId), eq(groupMeetings.orgId, svc.orgId)));
  if (!m) throw new AppError("Meeting not found", 404);
  const [g] = await db.select().from(groups).where(eq(groups.id, m.groupId));
  await db.transaction(async (tx) => {
    await tx.update(groupMeetings).set({ minutes: i.minutes, status: "held" }).where(eq(groupMeetings.id, meetingId));
    for (const a of i.attendance) {
      await tx.insert(meetingAttendance).values({ orgId: svc.orgId, meetingId, memberId: a.memberId, status: a.status }).onConflictDoUpdate({ target: [meetingAttendance.meetingId, meetingAttendance.memberId], set: { status: a.status } });
    }
    await audit(tx, svc.orgId, svc.actor, "group.meeting_recorded", "group_meeting", meetingId, { attendance: i.attendance.length });
  });
  if (i.applyFines) {
    for (const a of i.attendance) {
      const amount = a.status === "absent" ? g.rules.absentFine : a.status === "late" ? g.rules.lateFine : 0;
      if (amount > 0) await recordGroupEntry(svc, { groupId: g.id, memberId: a.memberId, kind: "fine", amount, meetingId, note: `${a.status} at meeting ${m.meetingDate}`, date: m.meetingDate });
    }
  }
}
export async function addResolution(svc: Svc, groupId: string, i: { title: string; body: string; date: string; meetingId?: string }) {
  const [g] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, groupId), eq(groups.orgId, svc.orgId)));
  if (!g) throw new AppError("Group not found", 404);
  if (!i.title.trim() || !i.body.trim()) throw new AppError("Title and resolution text are required");
  await db.insert(groupResolutions).values({ orgId: svc.orgId, groupId, title: i.title, body: i.body, resolvedOn: i.date, meetingId: i.meetingId || null });
}
export type { Tx };
