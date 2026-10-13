import { useEffect, useRef, useState, type ReactNode } from "react";

// Small SVG charts for the demo page, built to the dataviz specs: 2px lines,
// 8px end-dots with a 2px surface ring, bars <= 24px with 4px rounded data
// ends and 2px gaps, hairline grid, legend for 2+ series plus selective
// direct labels, hover + keyboard tooltips, and a table view for every chart.
// Text uses ink tokens; series colors appear only on marks.

export interface Series {
  key: string;
  label: string;
}

const color = (key: string) => `var(--series-${key})`;

/**
 * The plot's real width in CSS pixels, so the SVG is drawn 1:1 and text stays
 * at its set size instead of scaling with the container.
 */
function useWidth(ref: React.RefObject<HTMLDivElement | null>, fallback = 640): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function useTip() {
  const wrap = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const showAt = (clientX: number, clientY: number, content: ReactNode) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ x: clientX - box.left, y: clientY - box.top, content });
  };
  const showFor = (el: Element, content: ReactNode) => {
    const r = el.getBoundingClientRect();
    showAt(r.left + r.width / 2, r.top, content);
  };
  const node = tip ? (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.content}
    </div>
  ) : null;
  return { wrap, showAt, showFor, hide: () => setTip(null), node };
}

export function TipRow({ series, value, detail, line = true }: { series: string; value: string; detail?: string; line?: boolean }) {
  return (
    <div className="viz-tip-row">
      <span className={line ? "viz-key-line" : "viz-key-rect"} style={{ background: color(series) }} />
      <strong>{value}</strong>
      <span className="viz-muted">{detail}</span>
    </div>
  );
}

export function Legend({ series, mark }: { series: Series[]; mark: "line" | "rect" }) {
  return (
    <ul className="viz-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className={mark === "line" ? "viz-key-line" : "viz-key-rect"} style={{ background: color(s.key) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

export function ChartCard(props: {
  title: string;
  subtitle: string;
  legend?: ReactNode;
  table: { head: string[]; rows: (string | number)[][] };
  children: ReactNode;
}) {
  return (
    <figure className="viz-card">
      <figcaption>
        <h3>{props.title}</h3>
        <p className="viz-muted">{props.subtitle}</p>
      </figcaption>
      {props.legend}
      {props.children}
      <details className="viz-table">
        <summary>Show as table</summary>
        <table>
          <thead>
            <tr>{props.table.head.map((h) => <th key={h}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {props.table.rows.map((r, i) => (
              <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Rounded data end (top), square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function YAxis({ ticks, y, left, right, format }: { ticks: number[]; y: (v: number) => number; left: number; right: number; format: (v: number) => string }) {
  return (
    <g className="viz-axis">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={left} x2={right} y1={y(t)} y2={y(t)} className={t === 0 ? "viz-baseline" : "viz-grid"} />
          <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
        </g>
      ))}
    </g>
  );
}

// ---- Line chart over a few ordered x positions (the forgetting curve) ----

export function LineChart(props: {
  series: Series[];
  xLabels: string[];
  values: Record<string, number[]>; // per series, one value per x
  details?: Record<string, string[]>;
  yTicks: number[];
  format: (v: number) => string;
}) {
  const { wrap, showAt, hide, node } = useTip();
  const W = useWidth(wrap);
  // Room for the direct end labels ("Built-in memory 79%").
  const H = 260, m = { l: 48, r: 160, t: 16, b: 36 };
  const [hoverX, setHoverX] = useState<number | null>(null);
  const top = props.yTicks.at(-1)!;
  const x = (i: number) => m.l + (props.xLabels.length === 1 ? 0 : (i * (W - m.l - m.r)) / (props.xLabels.length - 1));
  const y = (v: number) => m.t + (1 - v / top) * (H - m.t - m.b);
  const last = props.xLabels.length - 1;
  const tipFor = (i: number) => (
    <>
      <div className="viz-muted">{props.xLabels[i]}</div>
      {[...props.series]
        .sort((a, b) => props.values[b.key][i] - props.values[a.key][i])
        .map((s) => (
          <TipRow key={s.key} series={s.key} value={props.format(props.values[s.key][i])} detail={`${s.label}${props.details ? ` · ${props.details[s.key][i]}` : ""}`} />
        ))}
    </>
  );
  // Direct end labels, nudged apart only if they would overlap.
  const ends = props.series
    .map((s) => ({ s, y: y(props.values[s.key][last]) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 14);
  return (
    <div className="viz-plot" ref={wrap} onPointerLeave={() => { hide(); setHoverX(null); }}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Line chart; values are in the table below">
        <YAxis ticks={props.yTicks} y={y} left={m.l} right={W - m.r} format={props.format} />
        {props.xLabels.map((l, i) => (
          <text key={l} x={x(i)} y={H - 12} textAnchor="middle" className="viz-axis-text">{l}</text>
        ))}
        {hoverX !== null && <line x1={x(hoverX)} x2={x(hoverX)} y1={m.t} y2={H - m.b} className="viz-crosshair" />}
        {props.series.map((s) => (
          <g key={s.key}>
            <polyline
              points={props.values[s.key].map((v, i) => `${x(i)},${y(v)}`).join(" ")}
              fill="none" stroke={color(s.key)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
            />
            {props.values[s.key].map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={4} fill={color(s.key)} stroke="var(--surface-1)" strokeWidth={2} />
            ))}
          </g>
        ))}
        {ends.map(({ s, y: ly }) => (
          <g key={s.key}>
            <line x1={x(last) + 8} x2={x(last) + 20} y1={ly} y2={ly} stroke={color(s.key)} strokeWidth={2} />
            <text x={x(last) + 26} y={ly} dy="0.32em" className="viz-label">
              {s.label} {props.format(props.values[s.key][last])}
            </text>
          </g>
        ))}
        {/* Hit areas: a band per x position, wider than any mark. */}
        {props.xLabels.map((l, i) => {
          const half = props.xLabels.length > 1 ? (x(1) - x(0)) / 2 : 40;
          return (
            <rect
              key={l} x={x(i) - half} y={m.t} width={half * 2} height={H - m.t - m.b} fill="transparent"
              tabIndex={0} aria-label={`${l}: ${props.series.map((s) => `${s.label} ${props.format(props.values[s.key][i])}`).join(", ")}`}
              onPointerMove={(e) => { setHoverX(i); showAt(e.clientX, e.clientY, tipFor(i)); }}
              onFocus={(e) => { setHoverX(i); const r = e.currentTarget.getBoundingClientRect(); showAt(r.left + r.width / 2, r.top + 20, tipFor(i)); }}
              onBlur={() => { hide(); setHoverX(null); }}
            />
          );
        })}
      </svg>
      {node}
    </div>
  );
}

// ---- Bars: one bar per series in each category (grouped) ------------------

export function BarChart(props: {
  series: Series[];
  categories: string[];
  values: Record<string, number[]>; // per series, one value per category
  details?: Record<string, string[]>;
  yTicks: number[];
  format: (v: number) => string;
}) {
  const { wrap, showFor, hide, node } = useTip();
  const W = useWidth(wrap);
  const H = 240, m = { l: 48, r: 16, t: 24, b: 36 };
  const top = props.yTicks.at(-1)!;
  const y = (v: number) => m.t + (1 - v / top) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / props.categories.length;
  const gap = 2;
  const bw = Math.min(24, (slot * 0.6 - gap * (props.series.length - 1)) / props.series.length);
  const groupW = props.series.length * bw + (props.series.length - 1) * gap;
  return (
    <div className="viz-plot" ref={wrap} onPointerLeave={hide}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Bar chart; values are in the table below">
        <YAxis ticks={props.yTicks} y={y} left={m.l} right={W - m.r} format={props.format} />
        {props.categories.map((c, ci) => {
          const gx = m.l + slot * ci + (slot - groupW) / 2;
          return (
            <g key={c}>
              <text x={m.l + slot * ci + slot / 2} y={H - 12} textAnchor="middle" className="viz-axis-text">{c}</text>
              {props.series.map((s, si) => {
                const v = props.values[s.key][ci];
                const bx = gx + si * (bw + gap);
                const h = Math.max(0, y(0) - y(v));
                const tip = (
                  <>
                    <div className="viz-muted">{c}</div>
                    <TipRow series={s.key} value={props.format(v)} detail={`${s.label}${props.details ? ` · ${props.details[s.key][ci]}` : ""}`} line={false} />
                  </>
                );
                return (
                  <g key={s.key}>
                    <path d={barPath(bx, y(v), bw, h)} fill={color(s.key)} className="viz-bar" />
                    <rect
                      x={bx - gap} y={m.t} width={bw + gap * 2} height={H - m.t - m.b} fill="transparent"
                      tabIndex={0} aria-label={`${c}, ${s.label}: ${props.format(v)}`}
                      onPointerMove={(e) => showFor(e.currentTarget, tip)}
                      onFocus={(e) => showFor(e.currentTarget, tip)}
                      onBlur={hide}
                    />
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}

// ---- One bar per design, named on the axis (reply time, cost) -------------

export function DesignBars(props: {
  series: Series[];
  values: Record<string, number>;
  yTicks: number[];
  format: (v: number) => string;
  /** Optional second value per design (e.g. 90th percentile), drawn as a tick. */
  markers?: Record<string, number>;
  markerLabel?: string;
}) {
  const { wrap, showFor, hide, node } = useTip();
  const W = useWidth(wrap);
  const H = 240, m = { l: 48, r: 16, t: 24, b: 36 };
  const top = props.yTicks.at(-1)!;
  const y = (v: number) => m.t + (1 - v / top) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / props.series.length;
  const bw = 24;
  return (
    <div className="viz-plot" ref={wrap} onPointerLeave={hide}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="Bar chart; values are in the table below">
        <YAxis ticks={props.yTicks} y={y} left={m.l} right={W - m.r} format={props.format} />
        {props.series.map((s, i) => {
          const cx = m.l + slot * i + slot / 2;
          const v = props.values[s.key];
          const marker = props.markers?.[s.key];
          const tip = (
            <>
              <TipRow series={s.key} value={props.format(v)} detail={s.label} line={false} />
              {marker !== undefined && <div className="viz-muted">{props.markerLabel}: {props.format(marker)}</div>}
            </>
          );
          return (
            <g key={s.key}>
              <path d={barPath(cx - bw / 2, y(v), bw, Math.max(0, y(0) - y(v)))} fill={color(s.key)} className="viz-bar" />
              <text x={cx} y={y(v) - 6} textAnchor="middle" className="viz-label">{props.format(v)}</text>
              {marker !== undefined && (
                <g>
                  <line x1={cx - bw / 2 - 4} x2={cx + bw / 2 + 4} y1={y(marker)} y2={y(marker)} className="viz-marker" />
                  {/* The last bar's marker label goes on its left, away from the edge. */}
                  <text
                    x={i === props.series.length - 1 ? cx - bw / 2 - 8 : cx + bw / 2 + 8}
                    textAnchor={i === props.series.length - 1 ? "end" : "start"}
                    y={y(marker)} dy="0.32em" className="viz-label"
                  >
                    {props.markerLabel} {props.format(marker)}
                  </text>
                </g>
              )}
              <text x={cx} y={H - 12} textAnchor="middle" className="viz-axis-text">{s.label}</text>
              <rect
                x={cx - slot / 2 + 4} y={m.t} width={slot - 8} height={H - m.t - m.b} fill="transparent"
                tabIndex={0} aria-label={`${s.label}: ${props.format(v)}${marker !== undefined ? `, ${props.markerLabel} ${props.format(marker)}` : ""}`}
                onPointerMove={(e) => showFor(e.currentTarget, tip)}
                onFocus={(e) => showFor(e.currentTarget, tip)}
                onBlur={hide}
              />
            </g>
          );
        })}
      </svg>
      {node}
    </div>
  );
}
