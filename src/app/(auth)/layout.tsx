import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh grid grid-cols-1 lg:grid-cols-2">
      <aside className="hidden lg:flex flex-col justify-between p-10 bg-[#0b3d2e] text-white">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-emerald-300">Softronics</p>
          <h1 className="text-3xl font-semibold mt-2 leading-tight">SACCO &amp; Savings Group<br />Management Platform</h1>
          <p className="mt-4 text-emerald-100/80 max-w-md">Digitise savings, loans, VSLA meetings and double-entry accounting for SACCOs, cooperatives and community savings groups across Uganda.</p>
        </div>
        <ul className="space-y-2 text-sm text-emerald-100/90">
          <li>Every shilling traced to a balanced ledger entry</li>
          <li>Role-based access and a tamper-evident audit trail</li>
          <li>Built for Android phones and low bandwidth - UGX and EAT by default</li>
        </ul>
      </aside>
      <main className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
