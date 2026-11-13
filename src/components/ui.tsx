import Link from "next/link";
import type { ReactNode } from "react";
import { label as lbl, ugx } from "@/lib/format";

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="text-sm text-muted mt-0.5">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, pad = true, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-line">
          <h2 className="font-semibold text-sm">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={pad ? "card-pad" : ""}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "danger" }) {
  const c = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "";
  return (
    <div className="card card-pad">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p className={`text-xl font-semibold mt-1 num ${c}`}>{value}</p>
      {sub && <p className="text-xs text-muted mt-1">{sub}</p>}
    </div>
  );
}

const TONES: Record<string, string> = {
  active: "badge-ok", completed: "badge-ok", approved: "badge-ok", paid: "badge-ok", closed: "badge-info", confirmed: "badge-ok", delivered: "badge-ok", sent: "badge-ok", held: "badge-ok", present: "badge-ok", accepted: "badge-ok", repaid: "badge-ok", reviewed: "badge-info", disbursed: "badge-info", open: "badge-info", resolved: "badge-ok", trial: "badge-info",
  pending: "badge-warn", partial: "badge-warn", under_review: "badge-warn", awaiting_confirmation: "badge-warn", pending_provider: "badge-warn", queued: "badge-warn", simulated: "badge-warn", late: "badge-warn", scheduled: "badge-info", in_progress: "badge-warn", past_due: "badge-warn", apology: "badge-info", medium: "badge-warn",
  suspended: "badge-danger", rejected: "badge-danger", reversed: "badge-danger", failed: "badge-danger", overdue: "badge-danger", absent: "badge-danger", declined: "badge-danger", cancelled: "badge-danger", deactivated: "badge-danger", exited: "badge-danger", high: "badge-danger", written_off: "badge-danger",
};
export const Badge = ({ value, tone }: { value: string; tone?: string }) => <span className={`badge ${tone ?? TONES[value] ?? ""}`}>{lbl(value)}</span>;

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="text-center py-10 px-4">
      <p className="font-semibold">{title}</p>
      {children && <p className="text-sm text-muted mt-1 max-w-md mx-auto">{children}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export const Money = ({ v, className = "" }: { v: string | number | null | undefined; className?: string }) => <span className={`num ${className}`}>{ugx(v)}</span>;

export function Pagination({ page, pages, total, params, base }: { page: number; pages: number; total: number; params: Record<string, string | undefined>; base: string }) {
  const href = (p: number) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    q.set("page", String(p));
    return `${base}?${q.toString()}`;
  };
  return (
    <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-line text-sm no-print">
      <span className="text-muted">{total.toLocaleString("en-UG")} record{total === 1 ? "" : "s"} - page {page} of {Math.max(1, pages)}</span>
      <div className="flex gap-2">
        {page > 1 ? <Link className="btn btn-sm" href={href(page - 1)}>Previous</Link> : <span className="btn btn-sm opacity-50">Previous</span>}
        {page < pages ? <Link className="btn btn-sm" href={href(page + 1)}>Next</Link> : <span className="btn btn-sm opacity-50">Next</span>}
      </div>
    </div>
  );
}

export const TableWrap = ({ children }: { children: ReactNode }) => <div className="scroll-x"><table className="tbl">{children}</table></div>;

export function FilterBar({ action, children }: { action: string; children: ReactNode }) {
  return (
    <form action={action} method="get" className="card card-pad mb-4 flex flex-wrap items-end gap-3 no-print">
      {children}
      <button className="btn btn-primary" type="submit">Apply</button>
      <Link href={action} className="btn">Reset</Link>
    </form>
  );
}
export const FilterField = ({ label, name, children }: { label: string; name: string; children: ReactNode }) => (
  <div className="min-w-[140px] flex-1 sm:flex-none"><label className="lbl" htmlFor={name}>{label}</label>{children}</div>
);

export function Tabs({ tabs, current, base, param = "tab" }: { tabs: { key: string; label: string; count?: number }[]; current: string; base: string; param?: string }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line mb-4 no-print" role="tablist">
      {tabs.map((t) => (
        <Link key={t.key} href={`${base}?${param}=${t.key}`} role="tab" aria-selected={current === t.key}
          className={`px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${current === t.key ? "border-brand text-brand font-semibold" : "border-transparent text-muted hover:text-fg"}`}>
          {t.label}{t.count !== undefined && <span className="ml-1.5 badge">{t.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export const KV = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex justify-between gap-4 py-1.5 border-b border-line last:border-0 text-sm"><dt className="text-muted">{k}</dt><dd className="text-right font-medium num">{children}</dd></div>
);

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading">
      <div className="skeleton h-7 w-48" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-20" />)}</div>
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton h-9" />)}
    </div>
  );
}

export const pageParam = (v: string | string[] | undefined) => Math.max(1, Number(Array.isArray(v) ? v[0] : v) || 1);
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
