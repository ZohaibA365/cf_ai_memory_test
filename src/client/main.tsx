import { useAgentChat } from "@cloudflare/think/react";
import { useAgent } from "agents/react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
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

function Chat() {
  const agent = useAgent({ agent: "ChatAgent", name: instanceId });
  const { messages, sendMessage, status, connectionError } = useAgentChat({
    agent
  });
  const [draft, setDraft] = useState("");
  const busy = status === "submitted" || status === "streaming";

  return (
    <main>
      <header>
        <h1>Memory test assistant</h1>
        <p className="muted">Your own private chat. Refreshing keeps it.</p>
      </header>

      <ol className="messages">
        {messages.map((msg) => (
          <li key={msg.id} className={`msg ${msg.role}`}>
            {msg.parts.map((part, i) =>
              part.type === "text" ? <span key={i}>{part.text}</span> : null
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Chat />);
