import Link from "next/link";
import { desc, eq, and } from "drizzle-orm";
import { db } from "@/db";
import { members, savingsAccounts, withdrawalRequests } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction } from "@/components/forms";
import { Badge, Card, Empty, PageHeader, TableWrap, Tabs, one } from "@/components/ui";
import { reviewWithdrawalAction } from "@/app/actions/finance";
import { fmtDateTime, label, ugx } from "@/lib/format";
import { getSettings } from "@/lib/core";

export const metadata = { title: "Withdrawals" };

export default async function Withdrawals({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("savings.view");
  const tab = one((await searchParams).tab) ?? "pending";
  const rows = await db.select({ r: withdrawalRequests, m: members.fullName, mid: members.id, acc: savingsAccounts.accountNo, bal: savingsAccounts.balance }).from(withdrawalRequests)
    .innerJoin(members, eq(members.id, withdrawalRequests.memberId)).innerJoin(savingsAccounts, eq(savingsAccounts.id, withdrawalRequests.accountId))
    .where(and(eq(withdrawalRequests.orgId, ctx.orgId), tab === "pending" ? eq(withdrawalRequests.status, "pending") : undefined)).orderBy(desc(withdrawalRequests.createdAt)).limit(100);
  const approver = can(ctx.role, "savings.withdraw.approve");
  const mc = getSettings(ctx.org).makerChecker;
  return (
    <>
      <PageHeader title="Withdrawal requests" sub={mc ? "Maker-checker is ON: you cannot approve a request you raised yourself." : "Maker-checker is OFF for this organisation."} />
      <Tabs base="/savings/withdrawals" current={tab} tabs={[{ key: "pending", label: "Awaiting approval" }, { key: "all", label: "All requests" }]} />
      <Card pad={false}>
        {rows.length === 0 ? <Empty title={tab === "pending" ? "Nothing awaiting approval" : "No withdrawal requests"}>New requests appear here when staff or members ask to withdraw savings.</Empty> : (
          <TableWrap><thead><tr><th>Requested</th><th>Member</th><th>Account</th><th className="r">Amount</th><th className="r">Balance</th><th>Channel</th><th>Reason</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map(({ r, m, mid, acc, bal }) => (
              <tr key={r.id}><td>{fmtDateTime(r.createdAt)}</td><td><Link className="text-brand hover:underline" href={`/members/${mid}`}>{m}</Link></td><td className="num">{acc}</td><td className="r num font-semibold">{ugx(r.amount)}</td><td className="r num">{ugx(bal)}</td><td>{label(r.channel)}</td><td className="max-w-48 truncate" title={r.reviewNote ?? r.reason ?? ""}>{r.reason ?? "-"}</td><td><Badge value={r.status} /></td>
                <td className="r">{approver && r.status === "pending" && <div className="flex gap-1.5 justify-end">
                  <ConfirmAction action={reviewWithdrawalAction} fields={{ id: r.id, decision: "approve" }} label="Approve" variant="primary" title="Approve and pay out" message={`Approve ${ugx(r.amount)} for ${m}? A ledger transaction is posted and the account balance is reduced immediately.`} />
                  <ConfirmAction action={reviewWithdrawalAction} fields={{ id: r.id, decision: "reject" }} label="Reject" danger message="Reject this request. The member is notified." reason reasonLabel="Reason for rejection" />
                </div>}</td></tr>))}</tbody></TableWrap>
        )}
      </Card>
    </>
  );
}
