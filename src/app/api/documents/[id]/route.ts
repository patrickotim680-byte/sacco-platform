import { readFile } from "fs/promises";
import path from "path";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberDocuments } from "@/db/schema";
import { getCtx } from "@/lib/auth";
import { can } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  if (!ctx?.orgId || !ctx.role) return new Response("Unauthorised", { status: 401 });
  const [d] = await db.select().from(memberDocuments).where(and(eq(memberDocuments.id, id), eq(memberDocuments.orgId, ctx.orgId)));
  const own = ctx.role === "member" && d && d.memberId === ctx.memberId;
  if (!d || (!own && !can(ctx.role, "members.view"))) return new Response("Not found", { status: 404 });
  try {
    const buf = await readFile(path.join(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".storage"), d.storagePath));
    return new Response(new Uint8Array(buf), { headers: { "Content-Type": d.mimeType, "Content-Disposition": `inline; filename="${d.fileName}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch {
    return new Response("File missing from storage", { status: 404 });
  }
}
