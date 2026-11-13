import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { requirePlatformAdmin } from "@/lib/auth";
import { logoutAction } from "@/app/actions/auth";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await requirePlatformAdmin();
  return (
    <Shell items={[{ href: "/admin", label: "Platform console", icon: "building", group: "" }]} orgName="Softronics Platform Admin" userName={ctx.user.fullName} roleLabel="Platform owner" brand="#0b3d2e" logout={logoutAction}>
      {children}
    </Shell>
  );
}
