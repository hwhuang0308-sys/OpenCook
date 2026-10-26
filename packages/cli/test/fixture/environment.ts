import os from "node:os"
import path from "node:path"

// Each isolated home gets its own XDG_CACHE_HOME, where Bun would otherwise keep its transpiler cache,
// so every spawned CLI process would transpile the source from scratch. Share one cache instead.
export const transpilerCache = path.join(os.tmpdir(), "opencook-test-transpiler-cache")

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: transpilerCache,
    HOME: root,
    OPENCOOK_CLI_CONFIG_CONTENT: undefined,
    OPENCOOK_CONFIG_CONTENT: "{}",
    OPENCOOK_CONFIG_DIR: path.join(root, "config"),
    OPENCOOK_DB: path.join(root, "opencook.db"),
    OPENCOOK_DISABLE_FILEWATCHER: "true",
    OPENCOOK_DISABLE_MODELS_FETCH: "true",
    OPENCOOK_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}
