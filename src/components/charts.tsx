/* Lightweight SVG charts (no client JS, low bandwidth). All values come from database queries. */
import { ugx } from "@/lib/format";

const short = (n: number) => (Math.abs(n) >= 1e9 ? (n / 1e9).toFixed(1) + "B" : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + "M" : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n)));
const mlabel = (s: string) => { const [y, m] = s.split("-"); return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] + (m === "01" ? ` '${y.slice(2)}` : ""); };

export type Series = { key: string; label: string; color: string };

export function BarChart({ data, series, height = 220, title }: { data: ({ label: string } & Record<string, number | string>)[]; series: Series[]; height?: number; title: string }) {
  const W = 640, H = height, pl = 44, pb = 24, pt = 8, pr = 8;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0)));
  const iw = W - pl - pr, ih = H - pb - pt;
  const gw = iw / Math.max(1, data.length), bw = Math.max(2, (gw * 0.75) / series.length);
  const ticks = [0, 0.5, 1].map((t) => max * t);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="w-full h-auto">
        {ticks.map((t, i) => { const y = pt + ih - (t / max) * ih; return <g key={i}><line x1={pl} x2={W - pr} y1={y} y2={y} stroke="var(--line)" /><text x={pl - 6} y={y + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{short(t)}</text></g>; })}
        {data.map((d, i) => (
          <g key={i}>
            {series.map((s, j) => { const v = Number(d[s.key]) || 0; const h = (v / max) * ih; return <rect key={s.key} x={pl + i * gw + gw * 0.125 + j * bw} y={pt + ih - h} width={bw - 1} height={h} fill={s.color} rx="1.5"><title>{`${d.label} ${s.label}: ${ugx(v)}`}</title></rect>; })}
            {(data.length <= 12 || i % 2 === 0) && <text x={pl + i * gw + gw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted)">{/^\d{4}-\d{2}$/.test(d.label) ? mlabel(d.label) : d.label}</text>}
          </g>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-3 mt-1 text-xs text-muted">{series.map((s) => <span key={s.key} className="inline-flex items-center gap-1"><i className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</span>)}</figcaption>
    </figure>
  );
}

export function LineChart({ data, color = "var(--brand)", height = 200, title, fmt = (n: number) => short(n) }: { data: { label: string; value: number }[]; color?: string; height?: number; title: string; fmt?: (n: number) => string }) {
  const W = 640, H = height, pl = 44, pb = 24, pt = 10, pr = 10;
  const min = Math.min(...data.map((d) => d.value)), max = Math.max(1, ...data.map((d) => d.value));
  const lo = min === max ? 0 : min * 0.9, iw = W - pl - pr, ih = H - pb - pt;
  const x = (i: number) => pl + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pt + ih - ((v - lo) / Math.max(1, max - lo)) * ih;
  const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="w-full h-auto">
      {[lo, (lo + max) / 2, max].map((t, i) => <g key={i}><line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={pl - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">{fmt(t)}</text></g>)}
      {data.length > 1 && <path d={`${path} L${x(data.length - 1)},${pt + ih} L${x(0)},${pt + ih} Z`} fill={color} opacity="0.1" />}
      <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {data.map((d, i) => <g key={i}><circle cx={x(i)} cy={y(d.value)} r="2.5" fill={color}><title>{`${d.label}: ${fmt(d.value)}`}</title></circle>{(data.length <= 12 || i % 2 === 0) && <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--muted)">{mlabel(d.label)}</text>}</g>)}
    </svg>
  );
}

export function HBars({ data, format = ugx, colors }: { data: { label: string; value: number }[]; format?: (n: number) => string; colors?: string[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.map((d, i) => (
        <li key={d.label}>
          <div className="flex justify-between text-xs mb-1"><span>{d.label}</span><span className="num text-muted">{format(d.value)}</span></div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: colors?.[i] ?? "var(--brand)" }} /></div>
        </li>
      ))}
    </ul>
  );
}
