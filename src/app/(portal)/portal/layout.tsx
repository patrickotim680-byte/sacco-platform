import type { ReactNode } from "react";
import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";
import { ThemeToggle } from "@/components/forms";

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePage("portal.use");
  return (
    <div className="min-h-dvh pb-20" style={{ ["--brand" as string]: ctx.org.brandColor }}>
      {ctx.org.isDemo && <div className="bg-warn/15 text-warn text-xs font-medium px-4 py-1.5 text-center">DEMO - fictional data</div>}
      <header className="sticky top-0 z-40 bg-surface border-b border-line px-4 h-14 flex items-center justify-between">
        <div className="min-w-0"><p className="text-[11px] font-semibold uppercase tracking-wider text-brand">Member portal</p><p className="font-semibold truncate">{ctx.org.name}</p></div>
        <div className="flex gap-2"><ThemeToggle /><form action={logoutAction}><button className="btn btn-sm">Sign out</button></form></div>
      </header>
      <main className="p-4 max-w-3xl mx-auto">{children}</main>
      <nav className="fixed bottom-0 inset-x-0 bg-surface border-t border-line grid grid-cols-5 text-center text-xs z-40" aria-label="Portal">
        {[["Home", "/portal"], ["Savings", "/portal?tab=savings"], ["Loans", "/portal?tab=loans"], ["Alerts", "/portal?tab=alerts"], ["Profile", "/portal?tab=profile"]].map(([l, h]) => <Link key={h} href={h} className="py-3 font-medium hover:bg-surface-2">{l}</Link>)}
      </nav>
    </div>
  );
}
