"use server";
import type { FormState } from "@/components/forms";
import { act, S, O, I, OI, B, oneOf, isoDate } from "@/lib/action-helpers";
import { AppError } from "@/lib/core";
import { todayEAT } from "@/lib/finance";
import * as G from "@/lib/services/groups";

const rulesFrom = (fd: FormData): G.GroupRules => ({
  sharePrice: I(fd, "sharePrice", "Share price"), maxSharesPerMeeting: I(fd, "maxShares", "Max shares"), loanInterestPct: I(fd, "loanInterest", "Loan interest"),
  socialFundContribution: I(fd, "socialFund", "Social fund"), lateFine: I(fd, "lateFine", "Late fine"), absentFine: I(fd, "absentFine", "Absent fine"), loanMultipleOfSavings: I(fd, "loanMultiple", "Loan multiple"),
});

export async function createGroupAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => {
    const g = await G.createGroup(svc, { name: S(fd, "name"), kind: oneOf(S(fd, "kind"), ["vsla", "rotating", "investment_club", "other"] as const, "group type"), location: O(fd, "location"), registrationNo: O(fd, "registrationNo"), constitution: O(fd, "constitution"), rules: rulesFrom(fd) });
    return { message: "Group registered", redirect: `/groups/${g.id}` };
  });
}
export async function updateRulesAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.updateGroupRules(svc, S(fd, "id"), rulesFrom(fd), S(fd, "constitution")); return "Group rules saved"; });
}
export async function addGroupMemberAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.addGroupMember(svc, S(fd, "groupId"), S(fd, "memberId"), oneOf(S(fd, "role") || "member", ["member", "chairperson", "secretary", "treasurer"] as const, "role")); return "Group member saved"; });
}
export async function removeGroupMemberAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.removeGroupMember(svc, S(fd, "groupId"), S(fd, "memberId")); return "Member removed from group"; });
}
export async function openCycleAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.openCycle(svc, S(fd, "groupId"), { name: S(fd, "name"), startDate: isoDate(S(fd, "startDate")) ?? todayEAT(), endDate: isoDate(S(fd, "endDate")) ?? todayEAT(), savingsTarget: OI(fd, "target") ?? 0 }); return "Savings cycle opened"; });
}
export async function closeCycleAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { const r = await G.closeCycle(svc, S(fd, "groupId"), S(fd, "cycleId")); return `Cycle closed. Share-out paid: UGX ${r.total.toLocaleString("en-UG")}`; });
}
export async function groupEntryAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => {
    const kind = S(fd, "kind");
    const r = await G.recordGroupEntry(svc, { groupId: S(fd, "groupId"), memberId: O(fd, "memberId"), kind, amount: I(fd, "amount", "Amount"), shares: OI(fd, "shares"), note: O(fd, "note"), meetingId: O(fd, "meetingId"), date: isoDate(O(fd, "date")), loanId: O(fd, "loanId"), dueDate: isoDate(O(fd, "dueDate")) });
    return `Recorded ${r.reference}`;
  });
}
export async function scheduleMeetingAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.scheduleMeeting(svc, S(fd, "groupId"), { date: isoDate(S(fd, "date")) ?? todayEAT(), venue: O(fd, "venue"), agenda: O(fd, "agenda") }); return "Meeting scheduled"; });
}
export async function recordMeetingAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => {
    const ids = fd.getAll("memberIds").map(String);
    if (!ids.length) throw new AppError("No members to record");
    const attendance = ids.map((id) => ({ memberId: id, status: oneOf(S(fd, `att_${id}`) || "present", ["present", "absent", "late", "apology"] as const, "attendance") }));
    await G.recordMeeting(svc, S(fd, "meetingId"), { minutes: S(fd, "minutes"), attendance, applyFines: B(fd, "applyFines") });
    return "Meeting minutes and attendance recorded";
  });
}
export async function resolutionAction(_p: FormState, fd: FormData) {
  return act("groups.manage", async (_c, svc) => { await G.addResolution(svc, S(fd, "groupId"), { title: S(fd, "title"), body: S(fd, "body"), date: isoDate(S(fd, "date")) ?? todayEAT(), meetingId: O(fd, "meetingId") }); return "Resolution recorded"; });
}
