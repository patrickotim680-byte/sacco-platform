import { redirect } from "next/navigation";
import { getCtx } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ctx = await getCtx();
  if (!ctx) redirect("/login");
  redirect(ctx.role === "member" ? "/portal" : ctx.orgId ? "/dashboard" : ctx.user.isPlatformAdmin ? "/admin" : "/login");
}
