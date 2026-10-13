import { routeAgentRequest } from "agents";
import { MemoryAgent } from "./memory/agent";
import { builtinDesign, builtinShippedDesign } from "./memory/builtin";
import { cutoffDesign } from "./memory/cutoff";
import { searchDesign } from "./memory/search";
import { PUBLIC_EXPERIMENTS, resultsFor } from "./results";

// The same assistant three times, one per memory design. Each visitor gets
// their own instance of each (see src/client/instance.ts).

export class CutoffAgent extends MemoryAgent {
  get design() {
    return cutoffDesign;
  }
}

export class BuiltinAgent extends MemoryAgent {
  get design() {
    return builtinDesign;
  }
}

/** Built-in with the original memory-block wording (stage 4 pilot only). */
export class BuiltinShippedAgent extends MemoryAgent {
  get design() {
    return builtinShippedDesign;
  }
}

export class SearchAgent extends MemoryAgent {
  get design() {
    return searchDesign;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/results" && request.method === "GET") {
      const id = url.searchParams.get("experiment") ?? PUBLIC_EXPERIMENTS[0];
      if (!PUBLIC_EXPERIMENTS.includes(id)) return new Response("Unknown experiment", { status: 404 });
      return Response.json(await resultsFor(env.DB, id), {
        headers: { "Cache-Control": "public, max-age=300" }
      });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

export { ExperimentRunner } from "./experiment/runner";
