import { eq } from "drizzle-orm";
import { db } from "@/db";
import { loanProducts } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Field, Grid, ModalForm, Select } from "@/components/forms";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";
import { saveLoanProductAction } from "@/app/actions/finance";
import { ugx } from "@/lib/format";

export const metadata = { title: "Loan products" };

function Form({ p }: { p?: typeof loanProducts.$inferSelect }) {
  return (
    <>
      {p && <input type="hidden" name="id" value={p.id} />}
      <Field label="Product name" name="name" required defaultValue={p?.name} />
      <Grid>
        <Field label="Interest rate (% per annum)" name="interestRate" required defaultValue={p ? Number(p.interestRate) : 24} inputMode="decimal" />
        <Select label="Interest method" name="interestMethod" required defaultValue={p?.interestMethod ?? "reducing"} options={[{ value: "reducing", label: "Reducing balance" }, { value: "flat", label: "Flat rate" }]} />
        <Select label="Repayment frequency" name="frequency" required defaultValue={p?.frequency ?? "monthly"} options={[{ value: "monthly", label: "Monthly" }, { value: "weekly", label: "Weekly" }]} />
        <Field label="Savings multiple (max loan = x savings)" name="savingsMultiple" required defaultValue={p ? Number(p.savingsMultiple) : 3} inputMode="decimal" />
        <Field label="Minimum amount (UGX)" name="minAmount" required defaultValue={p ? Number(p.minAmount) : 100000} inputMode="numeric" />
        <Field label="Maximum amount (UGX)" name="maxAmount" required defaultValue={p ? Number(p.maxAmount) : 10000000} inputMode="numeric" />
        <Field label="Minimum term (months)" name="minTerm" required defaultValue={p?.minTermMonths ?? 1} inputMode="numeric" />
        <Field label="Maximum term (months)" name="maxTerm" required defaultValue={p?.maxTermMonths ?? 12} inputMode="numeric" />
        <Field label="Minimum membership (months)" name="minMembership" required defaultValue={p?.minMembershipMonths ?? 3} inputMode="numeric" />
        <Field label="Guarantors required" name="guarantors" required defaultValue={p?.guarantorsRequired ?? 1} inputMode="numeric" />
        <Field label="Processing fee (% of principal)" name="fee" required defaultValue={p ? Number(p.processingFeePct) : 1} inputMode="decimal" />
        <Field label="Late penalty (% per 30 days)" name="penalty" required defaultValue={p ? Number(p.penaltyRatePct) : 5} inputMode="decimal" />
        <Field label="Grace days" name="grace" required defaultValue={p?.graceDays ?? 3} inputMode="numeric" />
      </Grid>
      {p && <label className="flex gap-2 items-center text-sm"><input type="checkbox" name="active" defaultChecked={p.active} /> Available for new applications</label>}
    </>
  );
}

export default async function LoanProducts() {
  const ctx = await requirePage("loans.view");
  const rows = await db.select().from(loanProducts).where(eq(loanProducts.orgId, ctx.orgId)).orderBy(loanProducts.createdAt);
  const manage = can(ctx.role, "loans.products");
  return (
    <>
      <PageHeader title="Loan products" sub="Rates, terms, limits and penalties apply to new loans only; existing loans keep the terms they were disbursed with." actions={manage && <ModalForm wide trigger="New product" title="New loan product" action={saveLoanProductAction}><Form /></ModalForm>} />
      <Card pad={false}>
        <TableWrap><thead><tr><th>Product</th><th className="r">Rate p.a.</th><th>Method</th><th>Term</th><th className="r">Amount range</th><th className="r">Savings x</th><th className="r">Fee</th><th className="r">Penalty</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((p) => <tr key={p.id}><td className="font-medium">{p.name}</td><td className="r num">{Number(p.interestRate)}%</td><td>{p.interestMethod}</td><td>{p.minTermMonths}-{p.maxTermMonths} mo ({p.frequency})</td><td className="r num">{ugx(p.minAmount, { symbol: false })} - {ugx(p.maxAmount, { symbol: false })}</td><td className="r num">{Number(p.savingsMultiple)}x</td><td className="r num">{Number(p.processingFeePct)}%</td><td className="r num">{Number(p.penaltyRatePct)}%</td><td><Badge value={p.active ? "active" : "closed"} /></td>
            <td className="r">{manage && <ModalForm wide small variant="default" trigger="Edit" title={`Edit ${p.name}`} action={saveLoanProductAction}><Form p={p} /></ModalForm>}</td></tr>)}</tbody></TableWrap>
      </Card>
    </>
  );
}
