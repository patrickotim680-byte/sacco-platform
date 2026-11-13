import { getCtx, actorOf } from "@/lib/auth";
import { auditStandalone } from "@/lib/core";
import { can } from "@/lib/permissions";
import { getReport, REPORT_CATALOG } from "@/lib/services/reports";
import { resolveRange } from "@/lib/services/dashboard";
import { reportCsv, reportPdf, reportXlsx } from "@/lib/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }) {
  let { key } = await params;
  if (key === "members") key = "member_register";
  const ctx = await getCtx();
  if (!ctx?.orgId || !ctx.org || !ctx.role) return new Response("Unauthorised", { status: 401 });
  const url = new URL(req.url);
  const q = url.searchParams;
  const memberId = q.get("memberId") ?? undefined;
  // staff need reports.view / members.view; members may only download their own statement
  const ownStatement = ctx.role === "member" && key === "member_statement" && memberId && memberId === ctx.memberId;
  const allowed = ownStatement || (key === "member_register" ? can(ctx.role, "members.view") : can(ctx.role, "reports.view"));
  if (!allowed) return new Response("Forbidden", { status: 403 });
  if (!REPORT_CATALOG.some((r) => r.key === key)) return new Response("Unknown report", { status: 404 });
  if (ctx.org.status !== "active") return new Response("Organisation suspended", { status: 403 });
  const range = await resolveRange(ctx.org, { range: q.get("range") ?? "fy", from: q.get("from") ?? undefined, to: q.get("to") ?? undefined, cycle: q.get("cycle") ?? undefined });
  try {
    const report = await getReport(ctx.orgId, key, { from: range.from, to: range.to, memberId, loanId: q.get("loanId") ?? undefined, groupId: q.get("groupId") ?? undefined });
    const format = q.get("format") ?? "csv";
    await auditStandalone(ctx.orgId, actorOf(ctx), "report.exported", "report", key, { format, range: `${range.from}..${range.to}`, memberId });
    const base = `${key}-${range.to}`;
    if (format === "pdf") return new Response(new Uint8Array(await reportPdf(report, ctx.org.name)), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${base}.pdf"`, "Cache-Control": "private, no-store" } });
    if (format === "xlsx") return new Response(new Uint8Array(await reportXlsx(report, ctx.org.name)), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${base}.xlsx"`, "Cache-Control": "private, no-store" } });
    return new Response(reportCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.csv"`, "Cache-Control": "private, no-store" } });
  } catch (e) {
    return new Response((e as Error).message, { status: 400 });
  }
}
