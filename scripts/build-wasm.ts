// Builds the Rust token-budget crate (rust/budget) to WebAssembly and copies
// the module to src/memory/wasm/budget.wasm, where the Worker imports it.
// Runs before `npm test`, `npm run build`, `npm run dev` and `npm run deploy`.
//
//   npm run build:wasm
//
// Needs Rust with the wasm32 target:
//   rustup target add wasm32-unknown-unknown

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRATE = "rust/budget";
const TARGET = "wasm32-unknown-unknown";
const BUILT = join(CRATE, "target", TARGET, "release", "budget.wasm");
const OUT_DIR = "src/memory/wasm";
const OUT = join(OUT_DIR, "budget.wasm");

// Use cargo from PATH, or from rustup's default location if PATH lacks it.
function cargo(): string {
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return "cargo";
  } catch {
    const fallback = join(homedir(), ".cargo", "bin", "cargo");
    if (existsSync(fallback)) return fallback;
    console.error(
      "cargo not found. Install Rust (https://rustup.rs), then run:\n  rustup target add wasm32-unknown-unknown"
    );
    process.exit(1);
  }
}

execFileSync(cargo(), ["build", "--release", "--target", TARGET, "--manifest-path", join(CRATE, "Cargo.toml")], {
  stdio: "inherit"
});
mkdirSync(OUT_DIR, { recursive: true });
copyFileSync(BUILT, OUT);
console.log(`${OUT}: ${statSync(OUT).size} bytes`);
