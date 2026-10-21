import budgetModule from "./wasm/budget.wasm?module";
import { createBudgetEngine } from "./budget-wasm-glue";

// The Worker's instance of the Rust token-budget module, created once per
// isolate when this file is first loaded. `.wasm?module` makes the bundler
// ship the file as a compiled WebAssembly module.
export const budget = createBudgetEngine(budgetModule);
