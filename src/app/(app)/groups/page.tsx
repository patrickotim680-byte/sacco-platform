import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { groups, groupCycles } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Field, Grid, ModalForm, Select } from "@/components/forms";
import { RulesFields } from "@/components/group-fields";
import { Badge, Card, Empty, PageHeader } from "@/components/ui";
import { createGroupAction } from "@/app/actions/groups";
import { groupPosition } from "@/lib/services/groups";
import { ugx, label } from "@/lib/format";

export const metadata = { title: "VSLA & groups" };

export default async function GroupsPage() {
  const ctx = await requirePage("groups.view");
  const rows = await db.select({ g: groups, members: sql<number>`(select count(*) from group_members gm where gm.group_id = ${groups.id})` }).from(groups).where(eq(groups.orgId, ctx.orgId)).orderBy(groups.name);
  const cycles = await db.select().from(groupCycles).where(eq(groupCycles.orgId, ctx.orgId));
  const pos = await Promise.all(rows.map(async ({ g }) => { const c = cycles.find((x) => x.groupId === g.id && x.status === "open"); return c ? groupPosition(g.id, c.id) : null; }));
  return (
    <>
      <PageHeader title="VSLA & groups" sub="Village savings groups, rotating savings and investment clubs: shares, social funds, group loans, meetings and cycle share-out." actions={can(ctx.role, "groups.manage") && (
        <ModalForm wide trigger="Register group" title="Register a group" action={createGroupAction}>
          <Field label="Group name" name="name" required />
          <Grid><Select label="Group type" name="kind" required defaultValue="vsla" options={[{ value: "vsla", label: "VSLA" }, { value: "rotating", label: "Rotating savings (ROSCA)" }, { value: "investment_club", label: "Investment club" }, { value: "other", label: "Other" }]} /><Field label="Location" name="location" /><Field label="Registration no." name="registrationNo" /></Grid>
          <Field label="Constitution / rules summary" name="constitution"><textarea id="constitution" name="constitution" className="input" /></Field>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Financial rules</p>
          <RulesFields />
        </ModalForm>)} />
      {rows.length === 0 ? <Card><Empty title="No groups yet">Register a VSLA or savings group, add its members and open a savings cycle.</Empty></Card> : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">{rows.map(({ g, members }, i) => {
          const c = cycles.find((x) => x.groupId === g.id && x.status === "open");
          return (
            <Link key={g.id} href={`/groups/${g.id}`} className="card card-pad hover:bg-surface-2 block">
              <div className="flex justify-between gap-2"><h2 className="font-semibold">{g.name}</h2><Badge value={g.status} /></div>
              <p className="text-sm text-muted">{label(g.kind)} - {g.location ?? "No location"} - {Number(members)} members</p>
              <div className="mt-3 text-sm space-y-1">
                <p>{c ? <>Cycle: <b>{c.name}</b> (to {c.endDate})</> : <span className="text-warn">No open cycle</span>}</p>
                {pos[i] && <><p>Cash in box: <b className="num">{ugx(pos[i]!.cashInBox)}</b></p><p>Shares: <span className="num">{ugx(pos[i]!.shares)}</span> - Loans out: <span className="num">{ugx(pos[i]!.loansOut)}</span></p></>}
              </div>
            </Link>
          );
        })}</div>
      )}
    </>
  );
}
