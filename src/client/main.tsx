import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./demo";
import { getInstanceId } from "./instance";
import "./styles.css";

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const instanceId = getInstanceId(browserStorage());

const DESIGNS = [
  { agent: "CutoffAgent", path: "cutoff-agent", label: "Cut-off" },
  { agent: "BuiltinAgent", path: "builtin-agent", label: "Built-in memory" },
  { agent: "SearchAgent", path: "search-agent", label: "Search" }
] as const;
type Design = (typeof DESIGNS)[number];

function MemoryPanel({ design }: { design: Design }) {
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setError(null);
    try {
      const res = await fetch(`/agents/${design.path}/${instanceId}/inspect`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnapshot(JSON.stringify(await res.json(), null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <section className="memory">
      <button type="button" onClick={load}>
        What does it remember?
      </button>
      {error && <p className="error">Could not load memory: {error}</p>}
      {snapshot && <pre>{snapshot}</pre>}
    </section>
  );
}

function Chat({ design }: { design: Design }) {
  const agent = useAgent({ agent: design.agent, name: instanceId });
  const { messages, sendMessage, status, connectionError } = useAgentChat({
    agent
  });
  const [draft, setDraft] = useState("");
  const busy = status === "submitted" || status === "streaming";

  return (
    <>
      <ol className="messages">
        {messages.map((msg) => (
          <li key={msg.id} className={`msg ${msg.role}`}>
            {msg.parts.map((part, i) =>
              part.type === "text" ? <span key={i}>{part.text.trim()}</span> : null
            )}
          </li>
        ))}
      </ol>

      {connectionError && (
        <p className="error">Connection problem: {connectionError.reason}</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (!text || busy) return;
          sendMessage({ text });
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Send a message…"
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>

      <MemoryPanel key={design.agent} design={design} />
    </>
  );
}

function Nav({ current }: { current: "chat" | "demo" }) {
  return (
    <nav className="top-nav" aria-label="Pages">
      <a href="/" aria-current={current === "chat" ? "page" : undefined}>Chat</a>
      <a href="/demo" aria-current={current === "demo" ? "page" : undefined}>Side by side + results</a>
    </nav>
  );
}

function App() {
  const [design, setDesign] = useState<Design>(DESIGNS[0]);
  return (
    <main>
      <Nav current="chat" />
      <header>
        <h1>Memory test assistant</h1>
        <p className="muted">
          Same assistant, three memory designs. Each keeps its own private chat.
        </p>
        <div className="tabs" role="tablist">
          {DESIGNS.map((d) => (
            <button
              key={d.agent}
              type="button"
              role="tab"
              aria-selected={d.agent === design.agent}
              className={d.agent === design.agent ? "tab active" : "tab"}
              onClick={() => setDesign(d)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </header>
      <Chat key={design.agent} design={design} />
    </main>
  );
}

function Root() {
  if (window.location.pathname.replace(/\/+$/, "") === "/demo") {
    return (
      <>
        <div className="demo-nav-wrap"><Nav current="demo" /></div>
        <Demo visitorId={instanceId} />
      </>
    );
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(<Root />);
