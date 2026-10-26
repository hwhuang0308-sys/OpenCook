import { Document, Info, type Entry } from "@opencook/schema/config"
import { Config } from "@opencook/core/config"
import { ShellSelect } from "@opencook/core/shell/select"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const ConfigHandler = HttpApiBuilder.group(Api, "server.config", (handlers) =>
  handlers
    .handle("config.get", () => Config.Service.use((config) => config.entries().pipe(Effect.map(redact))))
    .handle(
      "config.update",
      Effect.fn(function* (ctx) {
        const config = yield* Config.Service
        if (!config.update) return yield* Effect.die(new Error("Config updates are unavailable"))
        return yield* config.update(ctx.payload).pipe(Effect.orDie)
      }),
    )
    .handle(
      "config.shells",
      Effect.fn(function* () {
        const shell = yield* ShellSelect.Service
        if (!shell.list) return yield* Effect.die(new Error("Shell discovery is unavailable"))
        return yield* shell.list()
      }),
    ),
)

function redact(entries: Entry[]) {
  return entries.map((entry) =>
    entry.type !== "document" || !entry.info.cooking_models
      ? entry
      : new Document({
          ...entry,
          info: new Info({
            ...entry.info,
            cooking_models: Object.fromEntries(
              Object.entries(entry.info.cooking_models).map(([role, profile]) => [
                role,
                profile ? { ...profile, api_key: undefined } : profile,
              ]),
            ),
          }),
        }),
  )
}
