import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { memberDocuments, members } from "@/db/schema";
import { requireAction, actorOf } from "@/lib/auth";
import { audit } from "@/lib/core";

export const dynamic = "force-dynamic";
const MAX = 3 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "application/pdf": "pdf" };

/** Private document storage: files live outside /public under STORAGE_DIR and are only served through the authenticated download route. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const ctx = await requireAction("members.manage");
    const [m] = await db.select({ id: members.id }).from(members).where(and(eq(members.id, id), eq(members.orgId, ctx.orgId)));
    if (!m) return new Response("Not found", { status: 404 });
    const fd = await req.formData();
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return new Response("No file", { status: 400 });
    if (file.size > MAX) return new Response("File too large (max 3 MB)", { status: 413 });
    const ext = TYPES[file.type];
    if (!ext) return new Response("Only PNG, JPG or PDF files are accepted", { status: 415 });
    const buf = Buffer.from(await file.arrayBuffer());
    const magic = buf.subarray(0, 4).toString("hex");
    const okMagic = (ext === "png" && magic === "89504e47") || (ext === "jpg" && magic.startsWith("ffd8")) || (ext === "pdf" && buf.subarray(0, 4).toString() === "%PDF");
    if (!okMagic) return new Response("File content does not match its type", { status: 415 });
    const dir = path.join(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".storage"), ctx.orgId);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}.${ext}`;
    await writeFile(path.join(dir, name), buf, { mode: 0o600 });
    await db.transaction(async (tx) => {
      const [d] = await tx.insert(memberDocuments).values({ orgId: ctx.orgId, memberId: id, kind: String(fd.get("kind") || "other"), fileName: file.name.replace(/[^\w.\- ]/g, "_").slice(0, 120), storagePath: `${ctx.orgId}/${name}`, mimeType: file.type, sizeBytes: file.size, uploadedBy: ctx.user.id }).returning();
      await audit(tx, ctx.orgId, actorOf(ctx), "member.document_uploaded", "member_document", d.id, { memberId: id, kind: d.kind });
    });
    return Response.redirect(new URL(`/members/${id}`, req.url), 303);
  } catch (e) {
    return new Response((e as Error).message, { status: 403 });
  }
}
