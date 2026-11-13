import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { loanApplications, loanCollaterals, loanGuarantors, loanProducts, members } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ConfirmAction, Field, Grid, ModalForm, Select } from "@/components/forms";
import { CHANNEL_OPTIONS } from "@/components/fields";
import { Badge, Card, Empty, PageHeader, Tabs, one } from "@/components/ui";
import { addCollateralAction, addGuarantorAction, applyLoanAction, disburseAction, guarantorStatusAction, reviewApplicationAction } from "@/app/actions/finance";
import { fmtDate, ugx } from "@/lib/format";
import { todayEAT } from "@/lib/finance";

export const metadata = { title: "Loan applications" };

export default async function Applications({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("loans.view");
  const tab = one((await searchParams).tab) ?? "open";
  const statuses = tab === "open" ? ["pending", "under_review", "approved"] : ["rejected", "disbursed", "withdrawn"];
  const [apps, prods, mems] = await Promise.all([
    db.select({ a: loanApplications, m: members.fullName, mno: members.memberNo, p: loanProducts.name, rate: loanProducts.interestRate, method: loanProducts.interestMethod, need: loanProducts.guarantorsRequired }).from(loanApplications)
      .innerJoin(members, eq(members.id, loanApplications.memberId)).innerJoin(loanProducts, eq(loanProducts.id, loanApplications.productId))
      .where(and(eq(loanApplications.orgId, ctx.orgId), inArray(loanApplications.status, statuses))).orderBy(desc(loanApplications.createdAt)).limit(60),
    db.select().from(loanProducts).where(and(eq(loanProducts.orgId, ctx.orgId), eq(loanProducts.active, true))),
    db.select({ id: members.id, no: members.memberNo, name: members.fullName }).from(members).where(and(eq(members.orgId, ctx.orgId), eq(members.status, "active"))).orderBy(members.memberNo).limit(600),
  ]);
  const ids = apps.map((x) => x.a.id);
  const [gs, cs] = ids.length ? await Promise.all([
    db.select({ g: loanGuarantors, name: members.fullName }).from(loanGuarantors).innerJoin(members, eq(members.id, loanGuarantors.guarantorMemberId)).where(inArray(loanGuarantors.applicationId, ids)),
    db.select().from(loanCollaterals).where(inArray(loanCollaterals.applicationId, ids)),
  ]) : [[], []];
  const memberOptions = mems.map((m) => ({ value: m.id, label: `${m.no} - ${m.name}` }));
  const canReview = can(ctx.role, "loans.review"), canApprove = can(ctx.role, "loans.approve");
  return (
    <>
      <PageHeader title="Loan applications" sub="Eligibility is assessed against savings, membership age, existing loans and arrears. Approval needs accepted guarantors and a second officer." actions={can(ctx.role, "loans.apply") && (
        <ModalForm wide trigger="New loan application" title="New loan application" action={applyLoanAction} submit="Assess and submit">
          <Grid><Select label="Member" name="memberId" required options={memberOptions} /><Select label="Loan product" name="productId" required options={prods.map((p) => ({ value: p.id, label: `${p.name} - ${Number(p.interestRate)}% ${p.interestMethod}` }))} />
            <Field label="Amount (UGX)" name="amount" required inputMode="numeric" /><Field label="Term (months)" name="termMonths" required inputMode="numeric" /></Grid>
          <Field label="Purpose" name="purpose" />
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Guarantors (members; they must also accept)</p>
          <Grid><Select label="Guarantor 1" name="g1" options={memberOptions} /><Field label="Amount guaranteed (UGX)" name="ga1" inputMode="numeric" /><Select label="Guarantor 2" name="g2" options={memberOptions} /><Field label="Amount guaranteed (UGX)" name="ga2" inputMode="numeric" /></Grid>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Collateral (optional)</p>
          <Grid><Field label="Description" name="collateral" /><Field label="Estimated value (UGX)" name="collateralValue" inputMode="numeric" /></Grid>
        </ModalForm>)} />
      <Tabs base="/loans/applications" current={tab} tabs={[{ key: "open", label: "Open queue" }, { key: "closed", label: "Decided" }]} />
      {apps.length === 0 ? <Card><Empty title="No applications here">Applications appear after being submitted by staff or by members from the portal.</Empty></Card> : (
        <div className="space-y-3">{apps.map(({ a, m, mno, p, rate, method, need }) => {
          const g = gs.filter((x) => x.g.applicationId === a.id), c = cs.filter((x) => x.applicationId === a.id);
          const el = a.eligibility as { savingsLimit?: number; savings?: number; warnings?: string[]; reasons?: string[] };
          const accepted = g.filter((x) => x.g.status === "accepted").length;
          return (
            <Card key={a.id}>
              <div className="flex flex-wrap justify-between gap-3">
                <div><p className="font-semibold">{a.applicationNo} - <Link className="text-brand hover:underline" href={`/members/${a.memberId}`}>{m}</Link> <span className="text-muted text-sm num">({mno})</span></p>
                  <p className="text-sm text-muted">{p} - {Number(rate)}% {method} - applied {fmtDate(a.createdAt.toISOString())}</p></div>
                <div className="text-right"><p className="text-lg font-semibold num">{ugx(a.amount)}</p><p className="text-sm text-muted">{a.termMonths} months <Badge value={a.status} /></p></div>
              </div>
              <div className="grid sm:grid-cols-3 gap-4 mt-3 text-sm">
                <div><p className="lbl">Purpose</p><p>{a.purpose ?? "-"}</p>{a.reviewNote && <p className="text-muted mt-1">Note: {a.reviewNote}</p>}</div>
                <div><p className="lbl">Eligibility at submission</p><p>Savings-based limit: <b className="num">{ugx(el.savingsLimit ?? 0)}</b></p>{(el.warnings ?? []).map((w) => <p key={w} className="text-warn text-xs">{w}</p>)}</div>
                <div><p className="lbl">Guarantors ({accepted}/{need} accepted) and collateral</p>
                  {g.map((x) => <div key={x.g.id} className="flex items-center justify-between gap-2"><span>{x.name} <span className="num text-muted">({ugx(x.g.amountGuaranteed)})</span> <Badge value={x.g.status} /></span>
                    {canReview && x.g.status === "pending" && ["pending", "under_review"].includes(a.status) && <span className="flex gap-1"><ConfirmAction action={guarantorStatusAction} fields={{ id: x.g.id, status: "accepted" }} label="Accept" variant="primary" message="Record that this guarantor has consented to guarantee the loan." /><ConfirmAction action={guarantorStatusAction} fields={{ id: x.g.id, status: "declined" }} label="Decline" danger message="Record that the guarantor declined." /></span>}</div>)}
                  {g.length === 0 && <p className="text-muted">None</p>}
                  {c.map((x) => <p key={x.id} className="text-muted">Collateral: {x.description} ({ugx(x.estimatedValue)})</p>)}</div>
              </div>
              <div className="flex flex-wrap gap-2 mt-4">
                {canReview && ["pending", "under_review"].includes(a.status) && <>
                  <ModalForm small variant="default" trigger="Add guarantor" title="Add guarantor" action={addGuarantorAction}><input type="hidden" name="applicationId" value={a.id} /><Select label="Member" name="memberId" required options={memberOptions} /><Field label="Amount guaranteed" name="amount" required inputMode="numeric" /></ModalForm>
                  <ModalForm small variant="default" trigger="Add collateral" title="Record collateral" action={addCollateralAction}><input type="hidden" name="applicationId" value={a.id} /><Field label="Description" name="description" required /><Field label="Estimated value (UGX)" name="value" inputMode="numeric" /></ModalForm>
                  {a.status === "pending" && <ConfirmAction action={reviewApplicationAction} fields={{ id: a.id, decision: "under_review" }} label="Start review" message="Mark this application as under review." />}
                  {canApprove && <ConfirmAction action={reviewApplicationAction} fields={{ id: a.id, decision: "approved" }} label="Approve" variant="primary" title="Approve loan" message={`Approve ${ugx(a.amount)}? Eligibility and guarantors are re-checked now. You cannot approve an application you submitted.`} />}
                  {canApprove && <ConfirmAction action={reviewApplicationAction} fields={{ id: a.id, decision: "rejected" }} label="Reject" danger message="The member will be notified with your reason." reason reasonLabel="Reason for rejection" />}
                </>}
                {a.status === "approved" && can(ctx.role, "loans.disburse") && (
                  <ModalForm small trigger="Disburse" title={`Disburse ${a.applicationNo}`} action={disburseAction} submit="Disburse loan">
                    <input type="hidden" name="id" value={a.id} /><p className="text-sm text-muted">Posts: Dr Loans receivable, Cr cash/bank/mobile money (net of processing fee), Cr Fee income. Creates the repayment schedule from today.</p>
                    <Grid><Select label="Disbursement channel" name="channel" required defaultValue="cash" options={CHANNEL_OPTIONS} /><Field label="Date" name="date" type="date" defaultValue={todayEAT()} /></Grid>
                  </ModalForm>)}
                {a.loanId && <Link className="btn btn-sm" href={`/loans/${a.loanId}`}>Open loan</Link>}
              </div>
            </Card>
          );
        })}</div>
      )}
    </>
  );
}
