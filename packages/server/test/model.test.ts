import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("waits for plugin initialization before listing models", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-model-endpoint-")))
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "opencook.json"),
        JSON.stringify({
          cooking_models: {
            chat: {
              enabled: true,
              base_url: "https://provider.example/v1",
              model: "fixture-chat",
              context: 128000,
              output: 8192,
              api_key: "fixture-only",
            },
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const url = new URL("/api/model", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))

    expect(response.status).toBe(200)
    const body: unknown = yield* Effect.promise(() => response.json())
    if (!isRecord(body) || !Array.isArray(body["data"])) throw new Error("Expected a model list response")
    expect(
      body["data"].some((model) => isRecord(model) && model["providerID"] === "opencook" && model["id"] === "cook"),
    ).toBeTrue()
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
