import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { groupCycles, groupEntries, groupLoans, groupMeetings, groupMembers, groupResolutions, groups, meetingAttendance, members } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { RulesFields } from "@/components/group-fields";
import { Badge, Card, Empty, KV, PageHeader, Stat, Tabs, TableWrap, one } from "@/components/ui";
import { addGroupMemberAction, closeCycleAction, groupEntryAction, openCycleAction, recordMeetingAction, removeGroupMemberAction, resolutionAction, scheduleMeetingAction, updateRulesAction } from "@/app/actions/groups";
import { computeShareOut, groupPosition, ENTRY_KINDS } from "@/lib/services/groups";
import { addDays, todayEAT } from "@/lib/finance";
import { fmtDate, label, ugx } from "@/lib/format";
import { ActionForm } from "@/components/forms";

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const tab = one((await searchParams).tab) ?? "overview";
  const ctx = await requirePage("groups.view");
  const [g] = await db.select().from(groups).where(and(eq(groups.id, id), eq(groups.orgId, ctx.orgId)));
  if (!g) notFound();
  const manage = can(ctx.role, "groups.manage");
  const [gm, cycles, allMembers] = await Promise.all([
    db.select({ gm: groupMembers, m: members.fullName, no: members.memberNo }).from(groupMembers).innerJoin(members, eq(members.id, groupMembers.memberId)).where(eq(groupMembers.groupId, id)).orderBy(members.memberNo),
    db.select().from(groupCycles).where(eq(groupCycles.groupId, id)).orderBy(desc(groupCycles.startDate)),
    manage ? db.select({ id: members.id, no: members.memberNo, name: members.fullName }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.status, "active"))).orderBy(members.memberNo).limit(600) : [],
  ]);
  const cycle = cycles.find((c) => c.status === "open") ?? cycles[0];
  const pos = cycle ? await groupPosition(id, cycle.id) : null;
  const memOpts = gm.map((x) => ({ value: x.gm.memberId, label: `${x.no} - ${x.m}` }));
  let body;
  if (tab === "entries") {
    const entries = cycle ? await db.select({ e: groupEntries, m: members.fullName }).from(groupEntries).leftJoin(members, eq(members.id, groupEntries.memberId)).where(and(eq(groupEntries.groupId, id), eq(groupEntries.cycleId, cycle.id))).orderBy(desc(groupEntries.createdAt)).limit(60) : [];
    const loansActive = await db.select({ l: groupLoans, m: members.fullName }).from(groupLoans).innerJoin(members, eq(members.id, groupLoans.memberId)).where(and(eq(groupLoans.groupId, id), eq(groupLoans.status, "active")));
    body = (
      <>
        {manage && cycle?.status === "open" && <Card title="Record an entry" className="mb-4">
          <ActionForm action={groupEntryAction} submit="Record entry">
            <input type="hidden" name="groupId" value={id} />
            <Grid cols={3}>
              <Select label="Type" name="kind" required defaultValue="share" options={ENTRY_KINDS.filter((k) => k !== "share_out").map((k) => ({ value: k, label: label(k) }))} />
              <Select label="Member" name="memberId" options={memOpts} hint="Not needed for loan repayment (taken from the loan)" />
              <Field label="Amount (UGX)" name="amount" required inputMode="numeric" hint={`Share price ${ugx(g.rules.sharePrice)}`} />
              <Field label="Shares (for share purchases)" name="shares" inputMode="numeric" />
              <Select label="Group loan (for repayments)" name="loanId" options={loansActive.map((x) => ({ value: x.l.id, label: `${x.m} - ${ugx(x.l.principal)} (repaid ${ugx(x.l.repaid)} of ${ugx(Number(x.l.principal) + Number(x.l.interestDue))})` }))} />
              <Field label="Loan due date (for new loans)" name="dueDate" type="date" defaultValue={addDays(todayEAT(), 56)} />
            </Grid>
            <Field label="Note" name="note" />
            <p className="hint">Each entry posts a balanced journal to the general ledger (cash, group funds, fines and loans receivable).</p>
          </ActionForm></Card>}
        <Card title="Entries in current cycle" pad={false}>
          {entries.length === 0 ? <Empty title="No entries yet" /> : <TableWrap><thead><tr><th>Date</th><th>Reference</th><th>Type</th><th>Member</th><th className="r">Shares</th><th className="r">Amount</th><th>Note</th></tr></thead>
            <tbody>{entries.map(({ e, m }) => <tr key={e.id}><td>{fmtDate(e.entryDate)}</td><td className="num text-xs">{e.reference}</td><td>{label(e.kind)}</td><td>{m ?? "-"}</td><td className="r num">{e.shares || ""}</td><td className="r num">{ugx(e.amount)}</td><td className="text-muted">{e.note ?? ""}</td></tr>)}</tbody></TableWrap>}
        </Card>
        {loansActive.length > 0 && <Card title="Active group loans" className="mt-4" pad={false}><TableWrap><thead><tr><th>Member</th><th className="r">Principal</th><th className="r">Interest</th><th className="r">Repaid</th><th>Due</th></tr></thead><tbody>{loansActive.map(({ l, m }) => <tr key={l.id}><td>{m}</td><td className="r num">{ugx(l.principal)}</td><td className="r num">{ugx(l.interestDue)}</td><td className="r num">{ugx(l.repaid)}</td><td>{fmtDate(l.dueDate)}</td></tr>)}</tbody></TableWrap></Card>}
      </>
    );
  } else if (tab === "meetings") {
    const meetings = await db.select().from(groupMeetings).where(eq(groupMeetings.groupId, id)).orderBy(desc(groupMeetings.meetingDate)).limit(30);
    const att = meetings.length ? await db.select({ meetingId: meetingAttendance.meetingId, status: meetingAttendance.status, c: sql<number>`count(*)` }).from(meetingAttendance).where(inArray(meetingAttendance.meetingId, meetings.map((m) => m.id))).groupBy(meetingAttendance.meetingId, meetingAttendance.status) : [];
    body = (
      <Card title="Meetings" pad={false} actions={manage && <ModalForm small trigger="Schedule meeting" title="Schedule a meeting" action={scheduleMeetingAction}><input type="hidden" name="groupId" value={id} /><Grid><Field label="Date" name="date" type="date" required defaultValue={addDays(todayEAT(), 7)} /><Field label="Venue" name="venue" /></Grid><Field label="Agenda" name="agenda" /></ModalForm>}>
        {meetings.length === 0 ? <Empty title="No meetings yet" /> : <TableWrap><thead><tr><th>Date</th><th>Venue</th><th>Status</th><th>Attendance</th><th>Agenda / minutes</th><th /></tr></thead>
          <tbody>{meetings.map((m) => { const a = att.filter((x) => x.meetingId === m.id); return (
            <tr key={m.id}><td>{fmtDate(m.meetingDate)}</td><td>{m.venue ?? "-"}</td><td><Badge value={m.status} /></td><td className="text-xs">{a.map((x) => `${label(x.status)} ${x.c}`).join(", ") || "-"}</td><td className="max-w-80"><details><summary className="cursor-pointer text-brand">{m.agenda ?? "View"}</summary><p className="mt-1 whitespace-pre-wrap text-muted">{m.minutes ?? "Minutes not yet recorded"}</p></details></td>
              <td className="r">{manage && m.status === "scheduled" && m.meetingDate <= todayEAT() && (
                <ModalForm wide small trigger="Record meeting" title={`Meeting ${fmtDate(m.meetingDate)}`} action={recordMeetingAction}>
                  <input type="hidden" name="meetingId" value={m.id} />
                  <div className="scroll-x max-h-72 overflow-y-auto border border-line rounded-lg"><table className="tbl"><thead><tr><th>Member</th><th>Attendance</th></tr></thead><tbody>{gm.map((x) => <tr key={x.gm.memberId}><td>{x.no} {x.m}<input type="hidden" name="memberIds" value={x.gm.memberId} /></td><td><select name={`att_${x.gm.memberId}`} className="input" defaultValue="present"><option value="present">Present</option><option value="late">Late (fine {ugx(g.rules.lateFine)})</option><option value="absent">Absent (fine {ugx(g.rules.absentFine)})</option><option value="apology">Apology</option></select></td></tr>)}</tbody></table></div>
                  <Field label="Minutes" name="minutes" required><textarea id="minutes" name="minutes" required className="input" /></Field>
                  <label className="flex gap-2 items-center text-sm"><input type="checkbox" name="applyFines" defaultChecked /> Record fines for late and absent members</label>
                </ModalForm>)}</td></tr>); })}</tbody></TableWrap>}
      </Card>
    );
  } else if (tab === "members") {
    body = (
      <Card title="Group members and leadership" pad={false} actions={manage && <ModalForm small trigger="Add / change member" title="Add member or change role" action={addGroupMemberAction}><input type="hidden" name="groupId" value={id} /><Select label="Member" name="memberId" required options={allMembers.map((m) => ({ value: m.id, label: `${m.no} - ${m.name}` }))} /><Select label="Role" name="role" required defaultValue="member" options={[{ value: "member", label: "Member" }, { value: "chairperson", label: "Chairperson" }, { value: "secretary", label: "Secretary" }, { value: "treasurer", label: "Treasurer" }]} /></ModalForm>}>
        <TableWrap><thead><tr><th>No.</th><th>Name</th><th>Role</th><th>Joined</th><th /></tr></thead><tbody>{gm.map((x) => <tr key={x.gm.id}><td className="num">{x.no}</td><td>{x.m}</td><td><Badge value={x.gm.role} tone={x.gm.role === "member" ? "" : "badge-info"} /></td><td>{fmtDate(x.gm.joinedAt)}</td><td className="r">{manage && <ConfirmAction action={removeGroupMemberAction} fields={{ groupId: id, memberId: x.gm.memberId }} label="Remove" danger message={`Remove ${x.m} from the group? Their recorded entries are kept.`} />}</td></tr>)}</tbody></TableWrap>
      </Card>
    );
  } else if (tab === "resolutions") {
    const res = await db.select().from(groupResolutions).where(eq(groupResolutions.groupId, id)).orderBy(desc(groupResolutions.resolvedOn));
    body = (
      <Card title="Resolutions" actions={manage && <ModalForm small trigger="Record resolution" title="Record a resolution" action={resolutionAction}><input type="hidden" name="groupId" value={id} /><Field label="Title" name="title" required /><Field label="Date" name="date" type="date" defaultValue={todayEAT()} /><Field label="Resolution" name="body" required><textarea id="body" name="body" required className="input" /></Field></ModalForm>}>
        {res.length === 0 ? <Empty title="No resolutions recorded" /> : <ul className="space-y-3">{res.map((r) => <li key={r.id} className="border-b border-line pb-3 last:border-0"><p className="font-medium">{r.title} <span className="text-muted font-normal text-sm">- {fmtDate(r.resolvedOn)}</span></p><p className="text-sm text-muted whitespace-pre-wrap">{r.body}</p></li>)}</ul>}
      </Card>
    );
  } else if (tab === "rules") {
    body = (
      <Card title="Constitution and financial rules">
        <ActionForm action={updateRulesAction} submit="Save rules"><input type="hidden" name="id" value={id} /><RulesFields rules={g.rules} /><Field label="Constitution" name="constitution"><textarea id="constitution" name="constitution" defaultValue={g.constitution ?? ""} className="input" style={{ minHeight: 140 }} /></Field></ActionForm>
      </Card>
    );
  } else {
    const so = cycle ? await computeShareOut(id, cycle.id) : null;
    const names = new Map(gm.map((x) => [x.gm.memberId, `${x.no} ${x.m}`]));
    body = (
      <div className="space-y-4">
        <Card title="Savings cycle" actions={manage && (cycle?.status === "open"
          ? <ConfirmAction action={closeCycleAction} fields={{ groupId: id, cycleId: cycle.id }} label="Close cycle and share out" danger title="Close cycle" message="Pays out each member's contributions plus a pro-rata share of fines and loan interest. Posts balanced ledger entries. All group loans must be repaid first. This cannot be undone." />
          : <ModalForm small trigger="Open new cycle" title="Open savings cycle" action={openCycleAction}><input type="hidden" name="groupId" value={id} /><Field label="Name" name="name" required defaultValue={`Cycle ${today().slice(0, 4)}`} /><Grid><Field label="Start" name="startDate" type="date" required defaultValue={todayEAT()} /><Field label="End" name="endDate" type="date" required defaultValue={addDays(todayEAT(), 270)} /></Grid><Field label="Savings target (UGX)" name="target" inputMode="numeric" /></ModalForm>)}>
          {cycle ? <dl><KV k="Cycle">{cycle.name} <Badge value={cycle.status} /></KV><KV k="Period">{fmtDate(cycle.startDate)} to {fmtDate(cycle.endDate)}</KV><KV k="Savings target">{ugx(cycle.savingsTarget)}{pos && Number(cycle.savingsTarget) > 0 ? ` (${Math.min(100, Math.round((pos.shares / Number(cycle.savingsTarget)) * 100))}% reached)` : ""}</KV></dl> : <Empty title="No cycle">Open a savings cycle before recording entries.</Empty>}
        </Card>
        {pos && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3"><Stat label="Share savings" value={ugx(pos.shares)} /><Stat label="Social fund" value={ugx(pos.social)} /><Stat label="Emergency fund" value={ugx(pos.emergency)} /><Stat label="Fines collected" value={ugx(pos.fines)} /><Stat label="Loan interest earned" value={ugx(pos.interestIncome)} /><Stat label="Loans outstanding" value={ugx(pos.loansOut)} /><Stat label="Cash in the box" value={ugx(pos.cashInBox)} />{pos.rotatingIn > 0 && <Stat label="Rotating pot (in / out)" value={`${ugx(pos.rotatingIn)} / ${ugx(pos.rotatingOut)}`} />}</div>}
        {so && so.rows.length > 0 && <Card title={cycle?.status === "open" ? "Share-out preview (if the cycle closed today)" : "Share-out result"} pad={false}>
          <TableWrap><thead><tr><th>Member</th><th className="r">Contributions</th><th className="r">Profit share</th><th className="r">Payout</th></tr></thead><tbody>{so.rows.map((r) => <tr key={r.memberId}><td>{names.get(r.memberId) ?? r.memberId}</td><td className="r num">{ugx(r.contributions)}</td><td className="r num">{ugx(r.profit)}</td><td className="r num font-semibold">{ugx(r.payout)}</td></tr>)}</tbody></TableWrap>
          <p className="px-4 py-2 text-xs text-muted border-t border-line">Profit pool (fines + loan interest): {ugx(so.income)}, distributed in proportion to contributions.</p></Card>}
      </div>
    );
  }
  return (
    <>
      <PageHeader title={g.name} sub={<>{label(g.kind)} - {g.location ?? "No location"} - {gm.length} members</>} />
      <Tabs base={`/groups/${id}`} current={tab} tabs={[{ key: "overview", label: "Cycle & share-out" }, { key: "entries", label: "Shares, funds & loans" }, { key: "meetings", label: "Meetings" }, { key: "members", label: "Members", count: gm.length }, { key: "resolutions", label: "Resolutions" }, { key: "rules", label: "Rules" }]} />
      {body}
    </>
  );
}
const today = todayEAT;
