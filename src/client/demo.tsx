import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart, ChartCard, DesignBars, Legend, LineChart } from "./charts";
import { FAST_FORWARD } from "../config";
import {
  chatItems,
  compact,
  DESIGNS,
  plural,
  memoryView,
  niceTicks,
  pct,
  statTiles,
  TRY_STEPS,
  type ChatMessage,
  type DesignKey,
  type InspectSnapshot
} from "./demo-helpers";

// The demo: the same assistant three times, one per memory design, side by
// side. One message box sends to all three; fast-forward adds small talk to
// all three without model calls; each column shows what that design is
// currently holding. Below, charts of the full experiment.

// One press (the per-call cap) pushes a fact planted just before it out of
// cut-off's view.
const FF_PAIRS = FAST_FORWARD.maxPairsPerCall;

const REPO = "https://github.com/ZohaibA365/cf_ai_memory_test";

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

type Sender = (text: string) => void;

function MemoryPanel({ path, name, refresh }: { path: string; name: string; refresh: number }) {
  const [snap, setSnap] = useState<InspectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getJson<InspectSnapshot>(`/agents/${path}/${name}/inspect`)
      .then((s) => {
        if (live) {
          setSnap(s);
          setError(null);
        }
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [path, name, refresh]);
  if (error) return <p className="error">Could not load memory: {error}</p>;
  if (!snap) return <p className="viz-muted">Loading memory…</p>;
  const view = memoryView(snap);
  return (
    <div className="memory-panel">
      <h4>What it remembers</h4>
      {view.context && <p className="viz-muted">{view.context}</p>}
      {view.sections.map((s) => (
        <div key={s.title}>
          <h5>{s.title}</h5>
          {s.body ? <pre>{s.body}</pre> : <p className="viz-muted">{s.empty}</p>}
        </div>
      ))}
    </div>
  );
}

function Column(props: {
  design: (typeof DESIGNS)[number];
  name: string;
  register: (key: DesignKey, send: Sender, busy: boolean) => void;
  refresh: number;
  onReply: () => void;
}) {
  const agent = useAgent({ agent: props.design.agent, name: props.name });
  const { messages, sendMessage, status, connectionError } = useAgentChat({ agent });
  const busy = status === "submitted" || status === "streaming";
  const wasBusy = useRef(false);
  const { register, onReply, design } = props;

  useEffect(() => {
    register(design.key, (text) => sendMessage({ text }), busy);
  }, [register, design.key, sendMessage, busy]);

  // Refresh the memory panel when a reply finishes.
  useEffect(() => {
    if (wasBusy.current && !busy) onReply();
    wasBusy.current = busy;
  }, [busy, onReply]);

  const items = chatItems(messages as unknown as ChatMessage[]);
  const end = useRef<HTMLLIElement>(null);
  // Braces matter: an effect must return nothing or a cleanup function, and
  // newer browsers return a Promise from scrollIntoView(), which React would
  // later try to call as a cleanup (crashing the page).
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [items.length]);

  return (
    <section className="demo-col" aria-label={design.label}>
      <header>
        <span className="viz-key-rect" style={{ background: `var(--series-${design.key})` }} />
        <h2>{design.label}</h2>
      </header>
      <p className="viz-muted">{design.blurb}</p>
      <ol className="messages demo-messages">
        {items.length === 0 && <li className="viz-muted empty">Try the buttons above.</li>}
        {items.map((it) =>
          it.kind === "filler" ? (
            <li key={it.id} className="filler">··· {plural(it.exchanges, "exchange")} of small talk ···</li>
          ) : it.kind === "summary" ? (
            <li key={it.id} className="filler">··· older messages summarized (see What it remembers) ···</li>
          ) : (
            <li key={it.id} className={`msg ${it.role}`}>{it.text}</li>
          )
        )}
        {busy && <li className="viz-muted">Thinking…</li>}
        <li ref={end} aria-hidden="true" />
      </ol>
      {connectionError && <p className="error">Connection problem: {connectionError.reason}</p>}
      <MemoryPanel path={design.path} name={props.name} refresh={props.refresh} />
    </section>
  );
}

export function Demo({ visitorId }: { visitorId: string }) {
  const [generation, setGeneration] = useState(() => readGeneration());
  const name = `${visitorId}-demo-${generation}`;
  const senders = useRef(new Map<DesignKey, { send: Sender; busy: boolean }>());
  const [anyBusy, setAnyBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [ffNote, setFfNote] = useState<string | null>(null);
  const [ffBusy, setFfBusy] = useState(false);
  // The suggested next "Try it" step; any step can still be pressed.
  const [nextStep, setNextStep] = useState(0);

  const register = useCallback((key: DesignKey, send: Sender, busy: boolean) => {
    senders.current.set(key, { send, busy });
    setAnyBusy([...senders.current.values()].some((s) => s.busy));
  }, []);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  const sendText = (text: string) => {
    for (const { send } of senders.current.values()) send(text);
  };

  const sendAll = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || anyBusy || ffBusy) return;
    sendText(text);
    setDraft("");
  };

  const fastForward = async () => {
    setFfBusy(true);
    setFfNote(null);
    try {
      const results = await Promise.all(
        DESIGNS.map((d) =>
          getJson<{ added: number; used: number; limit: number }>(`/agents/${d.path}/${name}/fast-forward`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pairs: FF_PAIRS })
          })
        )
      );
      const { added, used, limit } = results[0];
      setFfNote(
        added > 0
          ? `Added ${plural(added, "exchange")} of small talk to each assistant (${used} of ${limit} used).`
          : `Fast-forward limit reached (${plural(limit, "exchange")}). Start over to try again.`
      );
    } catch (err) {
      setFfNote(`Fast-forward failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFfBusy(false);
      bump();
    }
  };

  const startOver = () => {
    const next = generation + 1;
    writeGeneration(next);
    setGeneration(next);
    senders.current.clear();
    setFfNote(null);
    setNextStep(0);
  };

  const runStep = (i: number) => {
    const step = TRY_STEPS[i];
    if (anyBusy || ffBusy) return;
    setNextStep(i + 1);
    if (step.action === "send") sendText(step.text);
    else void fastForward();
  };

  return (
    <main className="demo">
      <header className="demo-hero">
        <p className="eyebrow">cf_ai_memory_test</p>
        <h1>Three ways a chat assistant remembers</h1>
        <p className="lede">
          Search remembered 94% of facts at a third of built-in memory's cost; keeping only recent messages
          remembered 7%.
        </p>
        <p className="hero-links">
          <a href={REPO}>GitHub repo</a>
          <a href={`${REPO}#readme`}>README</a>
        </p>
      </header>

      <section className="try" aria-labelledby="try-h">
        <h2 id="try-h">Try it</h2>
        <p className="muted">
          The same assistant three times, one per memory design. Run the five steps in order: each message
          goes to all three, and fast-forward adds {plural(FF_PAIRS, "exchange")} of small talk. Your chats
          are private to this browser.
        </p>
        <ol className="try-steps">
          {TRY_STEPS.map((step, i) => (
            <li key={i}>
              <button
                type="button"
                className={i === nextStep ? "" : "secondary"}
                aria-current={i === nextStep ? "step" : undefined}
                onClick={() => runStep(i)}
                disabled={anyBusy || ffBusy}
                title={step.action === "send" ? `Sends “${step.text}”` : `Adds ${plural(FF_PAIRS, "exchange")} of small talk`}
              >
                <span className="step-n">{i + 1}</span>
                {step.label}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <form className="demo-controls" onSubmit={sendAll}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something to all three…"
          aria-label="Message to all three assistants"
        />
        {/* Not while fast-forwarding: a message sent mid-way would land in
            the middle of the small talk, on a branch the assistant never sees. */}
        <button type="submit" disabled={anyBusy || ffBusy || !draft.trim()}>Send to all</button>
        <button type="button" className="secondary" onClick={fastForward} disabled={anyBusy || ffBusy}>
          {ffBusy ? "Fast-forwarding…" : `Fast-forward ${plural(FF_PAIRS, "exchange")}`}
        </button>
        <button type="button" className="secondary" onClick={startOver} disabled={anyBusy || ffBusy}>
          Start over
        </button>
      </form>
      {ffNote && <p className="viz-muted" role="status">{ffNote}</p>}

      <div className="demo-grid" key={name}>
        {DESIGNS.map((d) => (
          <Column key={d.key} design={d} name={name} register={register} refresh={refresh} onReply={bump} />
        ))}
      </div>

      <Results />
    </main>
  );
}

// ---- Results charts --------------------------------------------------------

interface ResultsData {
  conversations: number;
  runs: number;
  humanLabels: number;
  model: string;
  designs: {
    design: string; scale: number; runs: number;
    fact: { right: number; decided: number }; never: { right: number; decided: number };
    unclear: number; medianMs: number; p90Ms: number; neuronsPerRun: number;
  }[];
  byType: { design: string; scale: number; type: string; right: number; decided: number }[];
}

const SERIES = DESIGNS.map((d) => ({ key: d.key, label: d.label }));
const TYPES = ["simple", "exact", "changed", "combine", "never"];
const LENGTH_LABEL = (s: number) => (s === 0.5 ? "Shorter (×0.5)" : s === 1 ? "Longer (×1)" : `×${s}`);
const fmtPct = (v: number) => `${Math.round(v)}%`;

function Results() {
  const [data, setData] = useState<ResultsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    getJson<ResultsData>("/api/results")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <p className="error">Could not load results: {error}</p>;
  if (!data) return <p className="viz-muted">Loading results…</p>;

  const scales = [...new Set(data.designs.map((d) => d.scale))].sort((a, b) => a - b);
  const row = (design: string, s: number) => data.designs.find((d) => d.design === design && d.scale === s)!;
  const factPct = (design: string, s: number) => { const r = row(design, s); return pct(r.fact.right, r.fact.decided); };
  const atScale = data.designs.filter((d) => d.scale === scale);
  const msTicks = niceTicks(Math.max(...atScale.map((d) => d.p90Ms)) / 1000);
  const nTicks = niceTicks(Math.max(...atScale.map((d) => d.neuronsPerRun)));
  const typeRow = (design: string, type: string) =>
    data.byType.find((t) => t.design === design && t.scale === scale && t.type === type) ?? { right: 0, decided: 0 };

  const headline = statTiles(data.designs);

  return (
    <section className="results viz-root" aria-labelledby="results-h">
      <h2 id="results-h">Results of the full experiment</h2>
      <p className="muted">
        {data.conversations} test conversations × 3 designs × 3 repeats × 2 lengths ({data.runs} runs) on {data.model}.
        Fact questions only unless noted; {data.humanLabels} answers carry a hand label, which overrides the grader.
      </p>

      <ul className="stat-tiles" aria-label={`Headline numbers, ${LENGTH_LABEL(headline.scale).toLowerCase()} conversations`}>
        {headline.tiles.map((t) => (
          <li key={t.key} className="stat-tile" style={{ borderTopColor: `var(--series-${t.key})` }}>
            <span className="stat-design">{t.label}</span>
            <span className="stat-value">{fmtPct(t.factPct)}</span>
            <span className="stat-caption">of facts recalled · {LENGTH_LABEL(headline.scale).toLowerCase()}</span>
            <span className="stat-meta">
              {t.replySeconds.toFixed(1)} s median reply · {Math.round(t.neuronsPerRun)} neurons per conversation
            </span>
          </li>
        ))}
      </ul>

      <ChartCard
        title="Forgetting curve"
        subtitle="Share of fact questions answered right, as conversations get longer"
        legend={<Legend series={SERIES} mark="line" />}
        table={{
          head: ["Design", ...scales.map(LENGTH_LABEL)],
          rows: SERIES.map((s) => [s.label, ...scales.map((sc) => { const r = row(s.key, sc); return `${fmtPct(factPct(s.key, sc))} (${r.fact.right}/${r.fact.decided})`; })])
        }}
      >
        <LineChart
          series={SERIES}
          xLabels={scales.map(LENGTH_LABEL)}
          values={Object.fromEntries(SERIES.map((s) => [s.key, scales.map((sc) => factPct(s.key, sc))]))}
          details={Object.fromEntries(SERIES.map((s) => [s.key, scales.map((sc) => { const r = row(s.key, sc); return `${r.fact.right}/${r.fact.decided}`; })]))}
          yTicks={[0, 25, 50, 75, 100]}
          format={fmtPct}
        />
      </ChartCard>

      <div className="results-filter" role="radiogroup" aria-label="Conversation length for the charts below">
        <span className="viz-muted">Length for the charts below:</span>
        {scales.map((s) => (
          <label key={s}>
            <input type="radio" name="length" checked={scale === s} onChange={() => setScale(s)} />
            {LENGTH_LABEL(s)}
          </label>
        ))}
      </div>

      <div className="results-grid">
        <ChartCard
          title="Accuracy by question type"
          subtitle={`Share answered right · ${LENGTH_LABEL(scale)}; "never" = says it was never told`}
          legend={<Legend series={SERIES} mark="rect" />}
          table={{
            head: ["Question type", ...SERIES.map((s) => s.label)],
            rows: TYPES.map((t) => [t, ...SERIES.map((s) => { const r = typeRow(s.key, t); return `${fmtPct(pct(r.right, r.decided))} (${r.right}/${r.decided})`; })])
          }}
        >
          <BarChart
            series={SERIES}
            categories={TYPES}
            values={Object.fromEntries(SERIES.map((s) => [s.key, TYPES.map((t) => { const r = typeRow(s.key, t); return pct(r.right, r.decided); })]))}
            details={Object.fromEntries(SERIES.map((s) => [s.key, TYPES.map((t) => { const r = typeRow(s.key, t); return `${r.right}/${r.decided}`; })]))}
            yTicks={[0, 25, 50, 75, 100]}
            format={fmtPct}
          />
        </ChartCard>

        <ChartCard
          title="Reply time"
          subtitle={`Seconds per reply: bar = median, tick = 90th percentile (p90) · ${LENGTH_LABEL(scale)}`}
          legend={<Legend series={SERIES} mark="rect" />}
          table={{
            head: ["Design", "Median", "90th percentile"],
            rows: SERIES.map((s) => { const r = row(s.key, scale); return [s.label, `${(r.medianMs / 1000).toFixed(1)} s`, `${(r.p90Ms / 1000).toFixed(1)} s`]; })
          }}
        >
          <DesignBars
            series={SERIES}
            values={Object.fromEntries(SERIES.map((s) => [s.key, row(s.key, scale).medianMs / 1000]))}
            markers={Object.fromEntries(SERIES.map((s) => [s.key, row(s.key, scale).p90Ms / 1000]))}
            markerLabel="p90"
            yTicks={msTicks}
            format={(v) => `${v.toFixed(1)} s`}
          />
        </ChartCard>

        <ChartCard
          title="Cost per conversation"
          subtitle={`Workers AI neurons per run (turns plus summaries) · ${LENGTH_LABEL(scale)}`}
          legend={<Legend series={SERIES} mark="rect" />}
          table={{
            head: ["Design", "Neurons per run"],
            rows: SERIES.map((s) => [s.label, Math.round(row(s.key, scale).neuronsPerRun)])
          }}
        >
          <DesignBars
            series={SERIES}
            values={Object.fromEntries(SERIES.map((s) => [s.key, row(s.key, scale).neuronsPerRun]))}
            yTicks={nTicks}
            format={compact}
          />
        </ChartCard>
      </div>
    </section>
  );
}

// "Start over" gives this browser a fresh set of three demo assistants.
const GEN_KEY = "cf_ai_memory_test:demo-generation";
function readGeneration(): number {
  try {
    return Number(window.localStorage.getItem(GEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeGeneration(n: number) {
  try {
    window.localStorage.setItem(GEN_KEY, String(n));
  } catch {
    // Storage blocked: the new generation lasts for this page load.
  }
}
