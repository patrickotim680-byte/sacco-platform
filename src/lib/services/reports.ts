import { sql } from "drizzle-orm";
import { db } from "@/db";
import { daysBetween, todayEAT } from "@/lib/finance";
import { label as lbl } from "@/lib/format";

export type Col = { key: string; label: string; type?: "money" | "date" | "text" | "number" | "datetime" };
export type Section = { title: string; columns: Col[]; rows: Record<string, unknown>[]; footer?: Record<string, unknown> };
export type Report = { key: string; title: string; subtitle: string; sections: Section[] };
export type ReportParams = { from: string; to: string; memberId?: string; loanId?: string; groupId?: string; channel?: string };

export const REPORT_CATALOG: { key: string; title: string; group: string; needs?: ("member" | "loan" | "group")[]; description: string }[] = [
  { key: "member_register", title: "Member register", group: "Members", description: "All members with contacts, status and next of kin" },
  { key: "member_statement", title: "Member statement", group: "Members", needs: ["member"], description: "Complete transaction history for one member" },
  { key: "savings_balances", title: "Savings balances", group: "Savings", description: "Balance of every savings account" },
  { key: "contributions", title: "Contributions report", group: "Savings", description: "Deposits collected per member in the period" },
  { key: "loan_portfolio", title: "Loan portfolio", group: "Loans", description: "Every loan with outstanding principal, interest and penalties" },
  { key: "repayment_schedule", title: "Repayment schedule", group: "Loans", needs: ["loan"], description: "Installment schedule and payments for one loan" },
  { key: "overdue_loans", title: "Overdue loans", group: "Loans", description: "Loans with unpaid installments past due date" },
  { key: "npl_report", title: "Non-performing loans (90+ days)", group: "Loans", description: "Loans more than 90 days in arrears" },
  { key: "income_expenditure", title: "Income and expenditure", group: "Accounting", description: "Income and expense transactions in the period" },
  { key: "cashbook", title: "Cashbook", group: "Accounting", description: "Cash, bank and mobile money movements with running balance" },
  { key: "trial_balance", title: "Trial balance", group: "Accounting", description: "Debit and credit balances of all ledger accounts" },
  { key: "income_statement", title: "Income statement", group: "Accounting", description: "Income less expenditure for the period" },
  { key: "balance_sheet", title: "Balance sheet", group: "Accounting", description: "Assets, liabilities and equity as at period end" },
  { key: "cash_flow", title: "Cash flow statement", group: "Accounting", description: "Cash movements by activity (direct method)" },
  { key: "meeting_attendance", title: "Meeting attendance", group: "Groups", description: "Attendance per meeting for groups", needs: [] },
  { key: "meeting_minutes", title: "Meeting minutes", group: "Groups", description: "Minutes of held meetings" },
  { key: "audit_log", title: "Audit trail", group: "Compliance", description: "Immutable record of actions in the period" },
  { key: "annual_report", title: "Annual financial report", group: "Compliance", description: "Income statement, balance sheet, portfolio and membership summary" },
];

const q = async (s: ReturnType<typeof sql>) => (await db.execute(s)).rows as Record<string, unknown>[];
const N = (v: unknown) => Number(v ?? 0);

async function glBalances(orgId: string, to: string, from?: string) {
  return q(sql`select a.code, a.name, a.type, coalesce(sum(l.debit),0) debit, coalesce(sum(l.credit),0) credit
    from gl_accounts a left join (select l.* from journal_lines l join journal_entries e on e.id=l.entry_id where e.entry_date <= ${to}::date ${from ? sql`and e.entry_date >= ${from}::date` : sql``}) l on l.account_id=a.id
    where a.org_id=${orgId} group by a.code, a.name, a.type order by a.code`);
}

function incomeStatement(rows: Record<string, unknown>[]): Section[] {
  const inc = rows.filter((r) => r.type === "income").map((r) => ({ code: r.code, name: r.name, amount: N(r.credit) - N(r.debit) }));
  const exp = rows.filter((r) => r.type === "expense").map((r) => ({ code: r.code, name: r.name, amount: N(r.debit) - N(r.credit) }));
  const ti = inc.reduce((s, r) => s + r.amount, 0), te = exp.reduce((s, r) => s + r.amount, 0);
  const cols: Col[] = [{ key: "code", label: "Code" }, { key: "name", label: "Account" }, { key: "amount", label: "Amount (UGX)", type: "money" }];
  return [
    { title: "Income", columns: cols, rows: inc, footer: { name: "Total income", amount: ti } },
    { title: "Expenditure", columns: cols, rows: exp, footer: { name: "Total expenditure", amount: te } },
    { title: "Result", columns: [{ key: "name", label: "" }, { key: "amount", label: "Amount (UGX)", type: "money" }], rows: [{ name: te > ti ? "Net deficit for the period" : "Net surplus for the period", amount: ti - te }] },
  ];
}

export async function getReport(orgId: string, key: string, p: ReportParams): Promise<Report> {
  const sub = `${p.from} to ${p.to}`;
  const today = todayEAT();
  const mk = (title: string, subtitle: string, sections: Section[]): Report => ({ key, title, subtitle, sections });
  switch (key) {
    case "member_register": {
      const rows = await q(sql`select member_no, full_name, gender, phone, national_id, district, status, joined_at, nok_name, nok_phone from members where org_id=${orgId} order by member_no`);
      return mk("Member register", `As at ${today}`, [{ title: `${rows.length} members`, rows, columns: [
        { key: "member_no", label: "Member No" }, { key: "full_name", label: "Name" }, { key: "gender", label: "Gender" }, { key: "phone", label: "Phone" }, { key: "national_id", label: "National ID" },
        { key: "district", label: "District" }, { key: "status", label: "Status" }, { key: "joined_at", label: "Joined", type: "date" }, { key: "nok_name", label: "Next of kin" }, { key: "nok_phone", label: "NOK phone" }] }]);
    }
    case "member_statement": {
      if (!p.memberId) throw new Error("Select a member");
      const [m] = await q(sql`select member_no, full_name from members where id=${p.memberId} and org_id=${orgId}`);
      if (!m) throw new Error("Member not found");
      const rows = await q(sql`select txn_date, reference, type, channel, description, status, amount,
        case when type in ('deposit','interest') and status='completed' then amount when type='reversal' and metadata->>'originalType' in ('withdrawal') then amount else 0 end credit_in,
        case when type in ('withdrawal','loan_repayment') and status='completed' then amount else 0 end debit_out
        from transactions where org_id=${orgId} and member_id=${p.memberId} and txn_date between ${p.from}::date and ${p.to}::date order by created_at`);
      const accs = await q(sql`select a.account_no, pr.name product, a.balance, a.status from savings_accounts a join savings_products pr on pr.id=a.product_id where a.member_id=${p.memberId}`);
      const lns = await q(sql`select loan_no, principal, principal - principal_paid out_principal, status, disbursed_at from loans where member_id=${p.memberId} order by disbursed_at`);
      return mk(`Member statement - ${m.full_name} (${m.member_no})`, sub, [
        { title: "Savings accounts", rows: accs, columns: [{ key: "account_no", label: "Account" }, { key: "product", label: "Product" }, { key: "balance", label: "Balance", type: "money" }, { key: "status", label: "Status" }] },
        { title: "Loans", rows: lns, columns: [{ key: "loan_no", label: "Loan" }, { key: "disbursed_at", label: "Disbursed", type: "date" }, { key: "principal", label: "Principal", type: "money" }, { key: "out_principal", label: "Principal outstanding", type: "money" }, { key: "status", label: "Status" }] },
        { title: "Transactions", rows, columns: [{ key: "txn_date", label: "Date", type: "date" }, { key: "reference", label: "Reference" }, { key: "type", label: "Type" }, { key: "channel", label: "Channel" }, { key: "description", label: "Description" }, { key: "amount", label: "Amount", type: "money" }, { key: "status", label: "Status" }] },
      ]);
    }
    case "savings_balances": {
      const rows = await q(sql`select m.member_no, m.full_name, a.account_no, pr.name product, a.status, a.balance from savings_accounts a join members m on m.id=a.member_id join savings_products pr on pr.id=a.product_id where a.org_id=${orgId} order by m.member_no, a.account_no`);
      const total = rows.reduce((s, r) => s + N(r.balance), 0);
      return mk("Savings balances", `As at ${today}`, [{ title: "Accounts", rows, footer: { full_name: "Total", balance: total }, columns: [{ key: "member_no", label: "Member No" }, { key: "full_name", label: "Member" }, { key: "account_no", label: "Account" }, { key: "product", label: "Product" }, { key: "status", label: "Status" }, { key: "balance", label: "Balance (UGX)", type: "money" }] }]);
    }
    case "contributions": {
      const rows = await q(sql`select m.member_no, m.full_name, count(*) deposits, sum(t.amount) total, max(t.txn_date) last_date from transactions t join members m on m.id=t.member_id where t.org_id=${orgId} and t.type='deposit' and t.status='completed' and t.txn_date between ${p.from}::date and ${p.to}::date group by m.member_no, m.full_name order by total desc`);
      const total = rows.reduce((s, r) => s + N(r.total), 0);
      return mk("Savings & contributions report", sub, [{ title: "Contributions by member", rows, footer: { full_name: "Total", total }, columns: [{ key: "member_no", label: "Member No" }, { key: "full_name", label: "Member" }, { key: "deposits", label: "Deposits", type: "number" }, { key: "total", label: "Total (UGX)", type: "money" }, { key: "last_date", label: "Last deposit", type: "date" }] }]);
    }
    case "loan_portfolio": case "overdue_loans": case "npl_report": {
      const rows = await q(sql`
        with od as (select s.loan_id, min(s.due_date) first_due, sum(s.principal_due + s.interest_due - s.principal_paid - s.interest_paid) overdue from loan_schedule s
          where s.org_id=${orgId} and s.status in ('pending','partial') and s.due_date < ${today}::date and s.principal_paid + s.interest_paid < s.principal_due + s.interest_due group by s.loan_id)
        select l.loan_no, m.member_no, m.full_name, l.disbursed_at, l.principal, l.interest_rate, l.interest_method, l.status, l.principal - l.principal_paid out_principal,
          coalesce((select sum(interest_due - interest_paid) from loan_schedule where loan_id=l.id and status<>'superseded'),0) out_interest,
          coalesce((select sum(penalty_accrued - penalty_paid) from loan_schedule where loan_id=l.id),0) out_penalty,
          coalesce(od.overdue,0) overdue, case when od.first_due is null then 0 else (${today}::date - od.first_due) end days_overdue
        from loans l join members m on m.id=l.member_id left join od on od.loan_id=l.id where l.org_id=${orgId} ${key === "loan_portfolio" ? sql`` : sql`and l.status='active' and od.first_due is not null`} order by days_overdue desc, l.loan_no`);
      const filtered = key === "npl_report" ? rows.filter((r) => N(r.days_overdue) > 90) : rows;
      const tot = (k: string) => filtered.reduce((s, r) => s + N(r[k]), 0);
      const cols: Col[] = [{ key: "loan_no", label: "Loan" }, { key: "member_no", label: "Member No" }, { key: "full_name", label: "Member" }, { key: "disbursed_at", label: "Disbursed", type: "date" }, { key: "principal", label: "Principal", type: "money" }, { key: "out_principal", label: "Principal o/s", type: "money" }, { key: "out_interest", label: "Interest o/s", type: "money" }, { key: "out_penalty", label: "Penalty o/s", type: "money" }, { key: "overdue", label: "Overdue amt", type: "money" }, { key: "days_overdue", label: "Days overdue", type: "number" }, { key: "status", label: "Status" }];
      const title = key === "loan_portfolio" ? "Loan portfolio" : key === "overdue_loans" ? "Overdue loans" : "Non-performing loans (over 90 days)";
      return mk(title, `As at ${today}`, [{ title: `${filtered.length} loans`, rows: filtered, columns: cols, footer: { full_name: "Total", principal: tot("principal"), out_principal: tot("out_principal"), out_interest: tot("out_interest"), out_penalty: tot("out_penalty"), overdue: tot("overdue") } }]);
    }
    case "repayment_schedule": {
      if (!p.loanId) throw new Error("Select a loan");
      const [l] = await q(sql`select l.loan_no, l.principal, l.interest_rate, l.interest_method, l.term_months, m.full_name from loans l join members m on m.id=l.member_id where l.id=${p.loanId} and l.org_id=${orgId}`);
      if (!l) throw new Error("Loan not found");
      const rows = await q(sql`select installment_no, due_date, principal_due, interest_due, principal_due + interest_due total_due, principal_paid + interest_paid paid, penalty_accrued - penalty_paid penalty_due, status from loan_schedule where loan_id=${p.loanId} and status<>'superseded' order by installment_no`);
      return mk(`Repayment schedule - ${l.loan_no} (${l.full_name})`, `${lbl(String(l.interest_method))} ${l.interest_rate}% p.a., ${l.term_months} months`, [{ title: "Installments", rows, columns: [{ key: "installment_no", label: "#", type: "number" }, { key: "due_date", label: "Due date", type: "date" }, { key: "principal_due", label: "Principal", type: "money" }, { key: "interest_due", label: "Interest", type: "money" }, { key: "total_due", label: "Total due", type: "money" }, { key: "paid", label: "Paid", type: "money" }, { key: "penalty_due", label: "Penalty due", type: "money" }, { key: "status", label: "Status" }] }]);
    }
    case "income_expenditure": {
      const rows = await q(sql`select t.txn_date, t.reference, t.type, t.description, t.channel, t.amount from transactions t where t.org_id=${orgId} and t.type in ('income','expense') and t.status='completed' and t.txn_date between ${p.from}::date and ${p.to}::date order by t.txn_date, t.created_at`);
      const inc = rows.filter((r) => r.type === "income"), exp = rows.filter((r) => r.type === "expense");
      const cols: Col[] = [{ key: "txn_date", label: "Date", type: "date" }, { key: "reference", label: "Reference" }, { key: "description", label: "Description" }, { key: "channel", label: "Channel" }, { key: "amount", label: "Amount (UGX)", type: "money" }];
      return mk("Income and expenditure", sub, [
        { title: "Other income received", rows: inc, columns: cols, footer: { description: "Total", amount: inc.reduce((s, r) => s + N(r.amount), 0) } },
        { title: "Expenditure paid", rows: exp, columns: cols, footer: { description: "Total", amount: exp.reduce((s, r) => s + N(r.amount), 0) } },
        ...incomeStatement(await glBalances(orgId, p.to, p.from)).map((s) => ({ ...s, title: `Ledger view - ${s.title}` })),
      ]);
    }
    case "cashbook": {
      const [open] = await q(sql`select coalesce(sum(l.debit - l.credit),0) b from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.is_cash and e.entry_date < ${p.from}::date`);
      const rows = await q(sql`select e.entry_date, e.entry_no, e.description, a.name account, l.debit receipts, l.credit payments from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id
        where l.org_id=${orgId} and a.is_cash and e.entry_date between ${p.from}::date and ${p.to}::date order by e.entry_date, e.created_at, l.id`);
      let bal = N(open.b);
      const withBal = [{ entry_date: p.from, entry_no: "", description: "Opening balance", account: "All cash accounts", receipts: 0, payments: 0, balance: bal }, ...rows.map((r) => { bal += N(r.receipts) - N(r.payments); return { ...r, balance: bal }; })];
      return mk("Cashbook", sub, [{ title: "Cash, bank and mobile money", rows: withBal, columns: [{ key: "entry_date", label: "Date", type: "date" }, { key: "entry_no", label: "Entry" }, { key: "description", label: "Description" }, { key: "account", label: "Account" }, { key: "receipts", label: "Receipts", type: "money" }, { key: "payments", label: "Payments", type: "money" }, { key: "balance", label: "Balance", type: "money" }], footer: { description: "Closing balance", balance: bal } }]);
    }
    case "trial_balance": {
      const rows = (await glBalances(orgId, p.to)).map((r) => { const net = N(r.debit) - N(r.credit); return { code: r.code, name: r.name, type: r.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 }; });
      return mk("Trial balance", `As at ${p.to}`, [{ title: "Ledger accounts", rows, columns: [{ key: "code", label: "Code" }, { key: "name", label: "Account" }, { key: "type", label: "Type" }, { key: "debit", label: "Debit", type: "money" }, { key: "credit", label: "Credit", type: "money" }], footer: { name: "Totals", debit: rows.reduce((s, r) => s + r.debit, 0), credit: rows.reduce((s, r) => s + r.credit, 0) } }]);
    }
    case "income_statement": return mk("Income statement", sub, incomeStatement(await glBalances(orgId, p.to, p.from)));
    case "balance_sheet": {
      const bs = await glBalances(orgId, p.to);
      const cols: Col[] = [{ key: "code", label: "Code" }, { key: "name", label: "Account" }, { key: "amount", label: "Amount (UGX)", type: "money" }];
      const pick = (t: string, sign: 1 | -1) => bs.filter((r) => r.type === t).map((r) => ({ code: r.code, name: r.name, amount: sign * (N(r.debit) - N(r.credit)) })).filter((r) => r.amount !== 0);
      const assets = pick("asset", 1), liab = pick("liability", -1), eq = pick("equity", -1);
      const surplus = bs.filter((r) => r.type === "income").reduce((s, r) => s + N(r.credit) - N(r.debit), 0) - bs.filter((r) => r.type === "expense").reduce((s, r) => s + N(r.debit) - N(r.credit), 0);
      eq.push({ code: "", name: "Accumulated surplus / (deficit)", amount: surplus });
      const sum = (a: { amount: number }[]) => a.reduce((s, r) => s + r.amount, 0);
      return mk("Balance sheet", `As at ${p.to}`, [
        { title: "Assets", columns: cols, rows: assets, footer: { name: "Total assets", amount: sum(assets) } },
        { title: "Liabilities", columns: cols, rows: liab, footer: { name: "Total liabilities", amount: sum(liab) } },
        { title: "Equity", columns: cols, rows: eq, footer: { name: "Total equity", amount: sum(eq) } },
        { title: "Check", columns: [{ key: "name", label: "" }, { key: "amount", label: "Amount (UGX)", type: "money" }], rows: [{ name: "Liabilities + equity", amount: sum(liab) + sum(eq) }, { name: "Difference from total assets (must be zero)", amount: sum(assets) - sum(liab) - sum(eq) }] },
      ]);
    }
    case "cash_flow": {
      const rows = await q(sql`select a.code, a.name, sum(o.credit - o.debit) amt from journal_lines o join journal_entries e on e.id=o.entry_id join gl_accounts a on a.id=o.account_id
        where o.org_id=${orgId} and not a.is_cash and e.entry_date between ${p.from}::date and ${p.to}::date
        and exists (select 1 from journal_lines c join gl_accounts ca on ca.id=c.account_id where c.entry_id=e.id and ca.is_cash) group by a.code, a.name order by a.code`);
      const group = (pred: (c: string) => boolean) => rows.filter((r) => pred(String(r.code))).map((r) => ({ name: `${r.name}`, amount: N(r.amt) }));
      const op = group((c) => c[0] === "4" || c[0] === "5"), inv = group((c) => c === "1100" || c === "1150" || c === "1200" || c === "1500"), fin = group((c) => c[0] === "2" || c[0] === "3");
      const sum = (a: { amount: number }[]) => a.reduce((s, r) => s + r.amount, 0);
      const cols: Col[] = [{ key: "name", label: "Item" }, { key: "amount", label: "Net cash (UGX)", type: "money" }];
      const [open] = await q(sql`select coalesce(sum(l.debit - l.credit),0) b from journal_lines l join journal_entries e on e.id=l.entry_id join gl_accounts a on a.id=l.account_id where l.org_id=${orgId} and a.is_cash and e.entry_date < ${p.from}::date`);
      const net = sum(op) + sum(inv) + sum(fin);
      return mk("Cash flow statement", sub, [
        { title: "Operating activities (income, expenses)", columns: cols, rows: op, footer: { name: "Net cash from operating activities", amount: sum(op) } },
        { title: "Lending & investing activities", columns: cols, rows: inv, footer: { name: "Net cash from lending/investing", amount: sum(inv) } },
        { title: "Financing activities (member savings, group funds, capital)", columns: cols, rows: fin, footer: { name: "Net cash from financing", amount: sum(fin) } },
        { title: "Summary", columns: cols, rows: [{ name: "Opening cash and bank", amount: N(open.b) }, { name: "Net increase / (decrease)", amount: net }, { name: "Closing cash and bank", amount: N(open.b) + net }] },
      ]);
    }
    case "meeting_attendance": {
      const rows = await q(sql`select g.name grp, mt.meeting_date, m.member_no, m.full_name, coalesce(a.status,'not recorded') status from group_meetings mt join groups g on g.id=mt.group_id
        join group_members gm on gm.group_id=g.id join members m on m.id=gm.member_id left join meeting_attendance a on a.meeting_id=mt.id and a.member_id=m.id
        where mt.org_id=${orgId} and mt.status='held' and mt.meeting_date between ${p.from}::date and ${p.to}::date ${p.groupId ? sql`and g.id=${p.groupId}` : sql``} order by mt.meeting_date, m.member_no`);
      return mk("Meeting attendance", sub, [{ title: "Attendance register", rows, columns: [{ key: "grp", label: "Group" }, { key: "meeting_date", label: "Meeting date", type: "date" }, { key: "member_no", label: "Member No" }, { key: "full_name", label: "Member" }, { key: "status", label: "Attendance" }] }]);
    }
    case "meeting_minutes": {
      const rows = await q(sql`select g.name grp, mt.meeting_date, mt.venue, mt.agenda, mt.minutes from group_meetings mt join groups g on g.id=mt.group_id where mt.org_id=${orgId} and mt.status='held' and mt.meeting_date between ${p.from}::date and ${p.to}::date ${p.groupId ? sql`and g.id=${p.groupId}` : sql``} order by mt.meeting_date desc`);
      return mk("Meeting minutes", sub, [{ title: "Minutes", rows, columns: [{ key: "grp", label: "Group" }, { key: "meeting_date", label: "Date", type: "date" }, { key: "venue", label: "Venue" }, { key: "agenda", label: "Agenda" }, { key: "minutes", label: "Minutes" }] }]);
    }
    case "audit_log": {
      const rows = await q(sql`select id, created_at, user_name, action, entity_type, entity_id, detail::text detail from audit_logs where org_id=${orgId} and created_at::date between ${p.from}::date and ${p.to}::date order by id desc limit 2000`);
      return mk("Audit trail", sub, [{ title: `${rows.length} events (most recent 2,000)`, rows, columns: [{ key: "id", label: "#", type: "number" }, { key: "created_at", label: "When", type: "datetime" }, { key: "user_name", label: "User" }, { key: "action", label: "Action" }, { key: "entity_type", label: "Entity" }, { key: "detail", label: "Detail" }] }]);
    }
    case "annual_report": {
      const is = incomeStatement(await glBalances(orgId, p.to, p.from));
      const bs = await getReport(orgId, "balance_sheet", p);
      const [mem] = await q(sql`select count(*) total, count(*) filter (where status='active') active, count(*) filter (where joined_at between ${p.from}::date and ${p.to}::date) joined from members where org_id=${orgId}`);
      const [pf] = await q(sql`select count(*) n, coalesce(sum(principal - principal_paid),0) outstanding from loans where org_id=${orgId} and status='active'`);
      const [sv] = await q(sql`select coalesce(sum(balance),0) s from savings_accounts where org_id=${orgId}`);
      const [ds] = await q(sql`select coalesce(sum(amount),0) s from transactions where org_id=${orgId} and type='loan_disbursement' and status='completed' and txn_date between ${p.from}::date and ${p.to}::date`);
      return mk("Annual financial report", sub, [
        { title: "Membership & portfolio summary", columns: [{ key: "item", label: "Indicator" }, { key: "value", label: "Value", type: "number" }], rows: [
          { item: "Total members", value: N(mem.total) }, { item: "Active members", value: N(mem.active) }, { item: "New members in period", value: N(mem.joined) },
          { item: "Active loans", value: N(pf.n) }, { item: "Outstanding loan principal (UGX)", value: N(pf.outstanding) }, { item: "Member savings (UGX)", value: N(sv.s) }, { item: "Loans disbursed in period (UGX)", value: N(ds.s) }] },
        ...is, ...bs.sections.map((s) => ({ ...s, title: `Balance sheet - ${s.title}` })),
      ]);
    }
    default: throw new Error("Unknown report");
  }
}

export const fmtCell = (v: unknown, type?: Col["type"]) => {
  if (v === null || v === undefined || v === "") return "";
  if (type === "money") return new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(Number(v));
  if (type === "number") return String(v);
  if (type === "date") return String(v instanceof Date ? v.toISOString() : v).slice(0, 10);
  if (type === "datetime") return new Date(v as string).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return String(v instanceof Date ? v.toISOString() : v);
};
export { daysBetween };
