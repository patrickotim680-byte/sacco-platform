import type { ReactNode } from "react";
import { Shell, type NavItem } from "@/components/shell";
import { requirePage } from "@/lib/auth";
import { can, ROLE_LABELS, type Perm } from "@/lib/permissions";
import { logoutAction } from "@/app/actions/auth";

const NAV: (NavItem & { perm?: Perm })[] = [
  { href: "/dashboard", label: "Dashboard", icon: "home", group: "" },
  { href: "/members", label: "Members", icon: "users", group: "Operations", perm: "members.view" },
  { href: "/savings", label: "Savings accounts", icon: "wallet", group: "Operations", perm: "savings.view" },
  { href: "/savings/withdrawals", label: "Withdrawals", icon: "swap", group: "Operations", perm: "savings.view" },
  { href: "/transactions", label: "Transactions", icon: "book", group: "Operations", perm: "savings.view" },
  { href: "/loans", label: "Loans", icon: "loan", group: "Lending", perm: "loans.view" },
  { href: "/loans/applications", label: "Applications", icon: "report", group: "Lending", perm: "loans.view" },
  { href: "/loans/products", label: "Loan products", icon: "tag", group: "Lending", perm: "loans.view" },
  { href: "/groups", label: "VSLA & groups", icon: "group", group: "Lending", perm: "groups.view" },
  { href: "/accounting", label: "Accounting", icon: "book", group: "Finance", perm: "accounting.view" },
  { href: "/accounting/cashbook", label: "Cashbook", icon: "wallet", group: "Finance", perm: "accounting.view" },
  { href: "/accounting/journal", label: "Journal & ledger", icon: "report", group: "Finance", perm: "accounting.view" },
  { href: "/payments", label: "Payments", icon: "phone", group: "Finance", perm: "payments.view" },
  { href: "/reports", label: "Reports", icon: "report", group: "Finance", perm: "reports.view" },
  { href: "/notifications", label: "Notifications", icon: "bell", group: "Admin" },
  { href: "/audit", label: "Audit & security", icon: "shield", group: "Admin", perm: "audit.view" },
  { href: "/settings", label: "Settings", icon: "gear", group: "Admin", perm: "settings.manage" },
  { href: "/support", label: "Support", icon: "help", group: "Admin" },
];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePage();
  const items = NAV.filter((n) => !n.perm || can(ctx.role, n.perm)).map(({ perm, ...n }) => { void perm; return n; });
  return (
    <Shell items={items} orgName={ctx.org.name} userName={ctx.user.fullName} roleLabel={ROLE_LABELS[ctx.role]} brand={ctx.org.brandColor} logout={logoutAction} demo={ctx.org.isDemo} searchAction={can(ctx.role, "members.view") ? "/members" : undefined}>
      {children}
    </Shell>
  );
}
