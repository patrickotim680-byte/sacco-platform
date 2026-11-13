import Link from "next/link";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";
import { requirePage } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { Field, ModalForm } from "@/components/forms";
import { Badge, Card, Empty, FilterBar, FilterField, PageHeader, Pagination, TableWrap, one, pageParam } from "@/components/ui";
import { MemberFields } from "@/components/fields";
import { createMemberAction, importMembersAction } from "@/app/actions/members";
import { formatUgPhone, fmtDate, ugx } from "@/lib/format";

export const metadata = { title: "Members" };
const PAGE = 25;

export default async function MembersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePage("members.view");
  const sp = await searchParams;
  const q = one(sp.q)?.trim(), status = one(sp.status), district = one(sp.district), page = pageParam(sp.page);
  const where = and(
    eq(members.orgId, ctx.orgId),
    status ? eq(members.status, status) : undefined,
    district ? eq(members.district, district) : undefined,
    q ? or(ilike(members.fullName, `%${q}%`), ilike(members.memberNo, `%${q}%`), ilike(members.phone, `%${q.replace(/^0/, "+256")}%`), ilike(members.nationalId, `%${q}%`)) : undefined,
  );
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(members).where(where);
  const rows = await db.select({
    m: members,
    savings: sql<string>`coalesce((select sum(balance) from savings_accounts a where a.member_id = ${members.id}),0)`,
    loan: sql<string>`coalesce((select sum(principal - principal_paid) from loans l where l.member_id = ${members.id} and l.status='active'),0)`,
  }).from(members).where(where).orderBy(desc(members.memberNo)).limit(PAGE).offset((page - 1) * PAGE);
  const districts = await db.selectDistinct({ d: members.district }).from(members).where(eq(members.orgId, ctx.orgId)).orderBy(members.district);
  const params = { q, status, district };
  const exportQs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return (
    <>
      <PageHeader title="Members" sub="Register, search and manage members. Each member has a unique number, financial profile and full history." actions={<>
        <Link className="btn" href={`/api/export/members?format=csv&${exportQs}`}>Export CSV</Link>
        <Link className="btn" href={`/api/export/members?format=xlsx&${exportQs}`}>Export Excel</Link>
        {can(ctx.role, "members.import") && (
          <ModalForm trigger="Import CSV" title="Import members from CSV" variant="default" action={importMembersAction} submit="Import">
            <p className="text-sm text-muted">Columns: <code>full_name, phone</code> (required), <code>gender, national_id, district, address, occupation, email, nok_name, nok_phone, nok_relationship, date_of_birth, joined_at</code>. Duplicate phone numbers and IDs are skipped and reported.</p>
            <input type="file" name="file" accept=".csv,text/csv" className="input" />
            <Field label="...or paste CSV" name="csv"><textarea id="csv" name="csv" className="input" placeholder={"full_name,phone,district\nJane Demo,0772000111,Kampala"} /></Field>
          </ModalForm>
        )}
        {can(ctx.role, "members.manage") && <ModalForm wide trigger="Register member" title="Register a new member" action={createMemberAction} submit="Register member"><MemberFields /></ModalForm>}
      </>} />
      <FilterBar action="/members">
        <FilterField label="Search" name="q"><input id="q" name="q" defaultValue={q} className="input" placeholder="Name, number, phone or NIN" /></FilterField>
        <FilterField label="Status" name="status"><select id="status" name="status" defaultValue={status ?? ""} className="input"><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="exited">Exited</option></select></FilterField>
        <FilterField label="District" name="district"><select id="district" name="district" defaultValue={district ?? ""} className="input"><option value="">All</option>{districts.map((d) => d.d && <option key={d.d}>{d.d}</option>)}</select></FilterField>
      </FilterBar>
      <Card pad={false}>
        {rows.length === 0 ? <Empty title="No members found" action={can(ctx.role, "members.manage") ? <ModalForm trigger="Register member" title="Register a new member" action={createMemberAction} wide><MemberFields /></ModalForm> : undefined}>Try a different search or filter, or register a new member.</Empty> : (
          <TableWrap>
            <thead><tr><th>No.</th><th>Name</th><th>Phone</th><th>District</th><th>Joined</th><th className="r">Savings</th><th className="r">Loan balance</th><th>Status</th></tr></thead>
            <tbody>{rows.map(({ m, savings, loan }) => (
              <tr key={m.id}>
                <td className="num">{m.memberNo}</td>
                <td><Link className="font-medium text-brand hover:underline" href={`/members/${m.id}`}>{m.fullName}</Link></td>
                <td className="num">{formatUgPhone(m.phone)}</td><td>{m.district ?? "-"}</td><td>{fmtDate(m.joinedAt)}</td>
                <td className="r num">{ugx(savings)}</td><td className="r num">{Number(loan) ? ugx(loan) : "-"}</td><td><Badge value={m.status} /></td>
              </tr>))}</tbody>
          </TableWrap>
        )}
        <Pagination page={page} pages={Math.ceil(Number(n) / PAGE)} total={Number(n)} params={params} base="/members" />
      </Card>
    </>
  );
}
