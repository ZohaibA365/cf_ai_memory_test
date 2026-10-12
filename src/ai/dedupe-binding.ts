// Workaround for a known workers-ai-provider bug (3.1.14 through 4.0.0).
//
// Workers AI streams some models' output in two formats at once: each SSE
// chunk carries the native `response` / `tool_calls` fields AND the
// OpenAI-style `choices[0].delta`. The provider reads both, so every word is
// emitted twice ("HelloHello world world") and streamed tool-call arguments
// are duplicated, which breaks the JSON the model sends to tools.
//
// We wrap the AI binding and drop the native copy whenever the OpenAI copy
// carries the same kind of content, the same approach as the proposed
// upstream fix:
//   https://github.com/cloudflare/ai/pull/663
//   https://github.com/cloudflare/agents/issues/2482
// Remove this wrapper once a fixed provider version is released.

type Chunk = {
  response?: unknown;
  tool_calls?: unknown;
  choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>;
};

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * The native `response` field is not always a string: for digit tokens
 * Workers AI sends a JSON number ({"response": 2}), which the provider turns
 * into text. Any non-empty value counts as a copy.
 */
function hasNativeText(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** Removes the native copy from a dual-format chunk. Returns null if unchanged. */
export function dedupeChunk(chunk: Chunk): Chunk | null {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return null;
  let changed = false;
  const out: Chunk = { ...chunk };
  if (hasText(delta.content) && hasNativeText(out.response)) {
    delete out.response;
    changed = true;
  }
  if (hasItems(delta.tool_calls) && hasItems(out.tool_calls)) {
    delete out.tool_calls;
    changed = true;
  }
  return changed ? out : null;
}

function dedupeLine(line: string): string {
  const match = /^data:\s?(.*)$/.exec(line);
  if (!match) return line;
  const data = match[1];
  if (!data.startsWith("{")) return line;
  try {
    const fixed = dedupeChunk(JSON.parse(data) as Chunk);
    return fixed ? `data: ${JSON.stringify(fixed)}` : line;
  } catch {
    return line;
  }
}

/** Rewrites an SSE byte stream line by line, keeping partial lines buffered. */
export function dedupeSseStream(
  input: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return input.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (lines.length > 0) {
          controller.enqueue(encoder.encode(lines.map(dedupeLine).join("\n") + "\n"));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer) controller.enqueue(encoder.encode(dedupeLine(buffer)));
      }
    })
  );
}

/** Returns the AI binding with streamed `run()` output de-duplicated. */
export function dedupeWorkersAI(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      if (prop !== "run") {
        // Bindings are native objects: keep methods bound to the real one.
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: Parameters<Ai["run"]>) => {
        const result = await target.run(...args);
        return result instanceof ReadableStream
          ? dedupeSseStream(result as ReadableStream<Uint8Array>)
          : result;
      };
    }
  });
}
