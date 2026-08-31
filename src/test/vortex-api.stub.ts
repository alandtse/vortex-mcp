// Test-only resolution target for the `@nexusmods/vortex-api` specifier.
// At runtime, Vortex's require() patch intercepts that specifier and hands
// back its live API object (see extensionRequire.ts) — there is no real
// npm module to resolve, so Vite needs *something* on disk here. Actual
// test doubles are supplied per-test via `vi.mock("@nexusmods/vortex-api")`.
export const stub = undefined;
