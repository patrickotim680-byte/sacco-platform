export function ugx(v: string | number | null | undefined, opts: { symbol?: boolean } = {}) {
  const n = Number(v ?? 0);
  const s = new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(Math.abs(n));
  return `${n < 0 ? "-" : ""}${opts.symbol === false ? "" : "UGX "}${s}`;
}

export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d.length <= 10 ? d + "T00:00:00+03:00" : d) : d;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kampala", day: "2-digit", month: "short", year: "numeric" }).format(date);
}
export function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kampala", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) + " EAT";
}

/** Normalise Uganda numbers (0772..., 772..., 256772..., +256772...) to +256XXXXXXXXX. Returns null if invalid. */
export function normalizeUgPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.replace(/[\s\-()]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("256")) s = s.slice(3);
  else if (s.startsWith("0")) s = s.slice(1);
  if (!/^[37]\d{8}$/.test(s)) return null;
  return "+256" + s;
}
export function formatUgPhone(p: string | null | undefined) {
  const n = normalizeUgPhone(p);
  if (!n) return p ?? "-";
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7, 10)} ${n.slice(10)}`;
}
/** MTN: 77, 78, 76 ; Airtel: 70, 74, 75 */
export function detectNetwork(p: string | null | undefined): "mtn_momo" | "airtel_money" | "unknown" {
  const n = normalizeUgPhone(p);
  if (!n) return "unknown";
  const pre = n.slice(4, 6);
  if (["77", "78", "76", "39"].includes(pre)) return "mtn_momo";
  if (["70", "74", "75", "20"].includes(pre)) return "airtel_money";
  return "unknown";
}

export const label = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
