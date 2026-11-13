import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

/**
 * Private document storage.
 *  - Production (Vercel): Supabase Storage when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
 *    The bucket is private; files are only ever served through the authenticated /api/documents/[id] route.
 *  - Local development: files under STORAGE_DIR (default .storage), which does not survive on serverless hosts.
 * The service role key is server-only. Never expose it to the browser or prefix it with NEXT_PUBLIC_.
 */
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "member-documents";

function supabase() {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

// New-style keys (sb_secret_...) are not JWTs and go in the apikey header only; legacy service_role JWTs are also sent as a Bearer token.
const headers = (key: string, extra: Record<string, string> = {}): Record<string, string> => (key.startsWith("sb_") ? { apikey: key, ...extra } : { Authorization: `Bearer ${key}`, apikey: key, ...extra });
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function ensureBucket(url: string, key: string) {
  const r = await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: headers(key, { "Content-Type": "application/json" }), body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false }) });
  // 200 = created, 400/409 = already exists
  if (!r.ok && r.status !== 400 && r.status !== 409) throw new Error(`Storage bucket setup failed (${r.status})`);
}

function localPath(storagePath: string) {
  return path.join(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".storage"), storagePath);
}

export function usingObjectStorage() { return supabase() !== null; }

export async function saveFile(storagePath: string, data: Buffer, contentType: string): Promise<void> {
  const sb = supabase();
  if (!sb) {
    const full = localPath(storagePath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data, { mode: 0o600 });
    return;
  }
  const put = () => fetch(`${sb.url}/storage/v1/object/${BUCKET}/${encodePath(storagePath)}`, { method: "POST", headers: headers(sb.key, { "Content-Type": contentType, "x-upsert": "false" }), body: new Uint8Array(data) });
  let r = await put();
  if (r.status === 404 || (r.status === 400 && /bucket/i.test(await r.clone().text()))) {
    await ensureBucket(sb.url, sb.key);
    r = await put();
  }
  if (!r.ok) throw new Error(`Document upload failed (${r.status})`);
}

/** Returns null when the file does not exist. */
export async function readStoredFile(storagePath: string): Promise<Buffer | null> {
  const sb = supabase();
  if (!sb) {
    try { return await readFile(localPath(storagePath)); } catch { return null; }
  }
  const r = await fetch(`${sb.url}/storage/v1/object/${BUCKET}/${encodePath(storagePath)}`, { headers: headers(sb.key), cache: "no-store" });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}
