"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ThemeToggle } from "@/components/forms";

export type NavItem = { href: string; label: string; icon: string; group: string };

const ICONS: Record<string, string> = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  users: "M16 11a4 4 0 10-8 0 4 4 0 008 0zM4 21c0-4 4-6 8-6s8 2 8 6",
  wallet: "M3 7h16a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7zm0 0V6a2 2 0 012-2h11M16 14h2",
  swap: "M7 7h13l-3-3M17 17H4l3 3",
  loan: "M12 3v18M17 7H9.5a2.5 2.5 0 000 5h5a2.5 2.5 0 010 5H7",
  group: "M8 11a3 3 0 100-6 3 3 0 000 6zm8 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3 3-5 6-5m8 0c3 0 6 2 6 5M8 20c0-2 2-4 4-4s4 2 4 4",
  book: "M5 4h12a2 2 0 012 2v14H7a2 2 0 01-2-2V4zm0 14a2 2 0 012-2h12",
  phone: "M8 3h8a1 1 0 011 1v16a1 1 0 01-1 1H8a1 1 0 01-1-1V4a1 1 0 011-1zm3 16h2",
  bell: "M6 17V11a6 6 0 1112 0v6l2 2H4l2-2zm4 4h4",
  report: "M6 3h9l4 4v14H6V3zm8 0v5h5M9 13h7M9 17h7",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z",
  gear: "M12 15a3 3 0 100-6 3 3 0 000 6zm7-3l2-1-2-4-2 1a7 7 0 00-2-1l-.5-2h-5L9 7a7 7 0 00-2 1L5 7l-2 4 2 1a7 7 0 000 2l-2 1 2 4 2-1a7 7 0 002 1l.5 2h5l.5-2a7 7 0 002-1l2 1 2-4-2-1a7 7 0 000-2z",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zm-2-11a2 2 0 114 0c0 2-2 2-2 4m0 3h.01",
  building: "M4 21V5l8-2v18M12 9h8v12M7 9h2m-2 4h2m-2 4h2m6-4h2m-2 4h2",
  tag: "M3 12V3h9l9 9-9 9-9-9zm5-5h.01",
};
export const Icon = ({ name, size = 18 }: { name: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name] ?? ICONS.home} /></svg>
);

export function Shell({ items, orgName, userName, roleLabel, brand, logout, children, demo, searchAction }: {
  items: NavItem[]; orgName: string; userName: string; roleLabel: string; brand: string; logout: () => Promise<void>; children: ReactNode; demo?: boolean; searchAction?: string;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const groups = [...new Set(items.map((i) => i.group))];
  const active = (href: string) => (href === "/dashboard" || href === "/admin" ? path === href : path === href || path.startsWith(href + "/"));
  // pick the most specific match so "/loans" is not highlighted on "/loans/applications"
  const best = items.filter((i) => active(i.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const nav = (
    <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-4" aria-label="Main">
      {groups.map((g) => (
        <div key={g}>
          {g && <p className="px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g}</p>}
          <ul className="space-y-0.5">
            {items.filter((i) => i.group === g).map((i) => (
              <li key={i.href}>
                <Link href={i.href} className="nav-link" aria-current={best === i.href ? "page" : undefined} onClick={() => setOpen(false)}><Icon name={i.icon} />{i.label}</Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <div className="min-h-dvh lg:flex" style={{ ["--brand" as string]: brand }}>
      <aside className="hidden lg:flex lg:w-64 shrink-0 flex-col border-r border-line bg-surface sticky top-0 h-dvh no-print">
        <div className="px-5 py-4 border-b border-line">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-brand">SokoSave</p>
          <p className="font-semibold truncate" title={orgName}>{orgName}</p>
        </div>
        {nav}
        <div className="p-3 border-t border-line text-xs text-muted">
          <p className="font-medium text-fg truncate">{userName}</p>
          <p>{roleLabel}</p>
        </div>
      </aside>
      {open && (
        <div className="lg:hidden fixed inset-0 z-50 flex no-print">
          <div className="w-72 max-w-[85vw] bg-surface flex flex-col border-r border-line">
            <div className="px-5 py-4 border-b border-line flex items-center justify-between"><p className="font-semibold truncate">{orgName}</p><button className="btn btn-sm" onClick={() => setOpen(false)}>Close</button></div>
            {nav}
          </div>
          <button className="flex-1 bg-black/50" aria-label="Close menu" onClick={() => setOpen(false)} />
        </div>
      )}
      <div className="flex-1 min-w-0 flex flex-col">
        {demo && <div className="bg-warn/15 text-warn text-xs font-medium px-4 py-1.5 text-center no-print">DEMO ENVIRONMENT - all people, numbers and messages are fictional. No real money moves and no real messages are delivered.</div>}
        <header className="sticky top-0 z-40 bg-surface/95 backdrop-blur border-b border-line px-4 h-14 flex items-center gap-3 no-print">
          <button className="btn btn-sm lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">Menu</button>
          {searchAction && (
            <form action={searchAction} className="flex-1 max-w-md hidden sm:block">
              <input name="q" className="input" placeholder="Search members by name, number or phone" aria-label="Search members" />
            </form>
          )}
          <div className="flex-1 sm:hidden" />
          <ThemeToggle />
          <form action={logout}><button className="btn btn-sm" type="submit">Sign out</button></form>
        </header>
        <main className="p-4 lg:p-6 max-w-[1400px] w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
