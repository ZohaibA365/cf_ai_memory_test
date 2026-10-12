import { routeAgentRequest } from "agents";
import { MemoryAgent } from "./memory/agent";
import { builtinDesign } from "./memory/builtin";
import { cutoffDesign } from "./memory/cutoff";
import { searchDesign } from "./memory/search";

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

export class SearchAgent extends MemoryAgent {
  get design() {
    return searchDesign;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

export { ExperimentRunner } from "./experiment/runner";
