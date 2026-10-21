// `.wasm?module` imports are compiled WebAssembly modules (the Cloudflare
// Vite plugin bundles them as Worker "CompiledWasm" modules).
declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}
