import path from "node:path"
import { describe, expect } from "bun:test"
import { SdkPlugins } from "@opencook/core/plugin/sdk"
import { Effect, Layer, Schedule } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { ServerFetch } from "../src/fetch"

it.live("does not initialize Git without a registered extension", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-no-git-extension-")))
    const server = yield* startServer(path.join(tmp.path, "config"))
    const url = new URL("/api/vcs/init", server.base)
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
    expect(response.status).toBe(400)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      field: "provider",
      message: "Unknown VCS provider",
    })
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git/HEAD")).exists())).toBe(false)
  }),
)

it.live(
  "does not create a project directory while initializing Git",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-vcs-missing-")))
      const server = yield* startServer(path.join(tmp.path, "config"))
      const directory = path.join(tmp.path, "absent")
      const url = new URL("/api/vcs/init", server.base)
      url.searchParams.set("location[directory]", directory)
      const response = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
      expect(response.status).not.toBe(204)
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, ".git", "HEAD")).exists())).toBe(false)
    }),
  15_000,
)

it.live(
  "rejects unregistered providers without initializing",
  () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-vcs-provider-")))
      const server = yield* startServer(path.join(tmp.path, "config"))
      const url = new URL("/api/vcs/init", server.base)
      url.searchParams.set("location[directory]", tmp.path)
      url.searchParams.set("provider", "unknown")
      const unsupported = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
      expect(unsupported.status).toBe(400)
      expect(yield* Effect.promise(() => unsupported.json())).toMatchObject({
        _tag: "InvalidRequestError",
        field: "provider",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "HEAD")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".hg", "requires")).exists())).toBe(false)
      url.searchParams.set("provider", "git")
      const initialized = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
      expect(initialized.status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "HEAD")).exists())).toBe(false)
    }),
  15_000,
)

it.live("returns 501 when a registered VCS provider has no initializer", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-vcs-no-init-")))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path },
        fs: { filewatcher: false },
      },
      {
        overrides: [
          SdkPlugins.node.replace(
            Layer.succeed(
              SdkPlugins.Service,
              SdkPlugins.Service.of({
                register: () => Effect.void,
                all: () => [
                  {
                    id: "read-only-vcs",
                    revision: "test",
                    effect: (ctx) =>
                      ctx.vcs
                        .transform((editor) => {
                          editor.add({
                            id: "read-only",
                            name: "Read-only VCS",
                            info: () => Effect.succeed({ branch: {} }),
                            branches: () => Effect.succeed([]),
                            status: () => Effect.succeed([]),
                            diff: () => Effect.succeed([]),
                          })
                        })
                        .pipe(Effect.asVoid),
                  },
                ],
              }),
            ),
          ),
        ],
      },
    )
    const url = new URL("http://opencook.local/api/vcs/init")
    url.searchParams.set("location[directory]", tmp.path)
    url.searchParams.set("provider", "read-only")
    const response = yield* Effect.promise(() => handler(new Request(url, { method: "POST" })))
    expect(response.status).toBe(501)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "VcsInitNotSupportedError",
      providerID: "read-only",
    })
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "HEAD")).exists())).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".hg", "requires")).exists())).toBe(false)
  }),
)

const describeHg = Bun.which("hg") ? describe : describe.skip

describeHg("Mercurial initialization", () => {
  it.live(
    "initializes and serves an untracked-file diff through the Hg provider",
    () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-vcs-hg-init-")))
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "hello.txt"), "hello\n"))
        const server = yield* startServer(path.join(tmp.path, "config"))
        const url = new URL("/api/vcs/init", server.base)
        url.searchParams.set("location[directory]", tmp.path)
        url.searchParams.set("provider", "hg")
        const initialized = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
        expect(initialized.status).toBe(400)
        expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".hg", "requires")).exists())).toBe(true)
        url.pathname = "/api/vcs"
        const info = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(url, { headers: server.headers })
            const body: unknown = await response.json()
            if (!isRecord(body) || !isRecord(body.data) || body.data.provider !== "hg")
              throw new Error("Mercurial provider not ready")
            return body
          },
          catch: (cause) => cause,
        }).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("2 seconds"))
        expect(info).toMatchObject({ data: { provider: "hg" } })
        url.pathname = "/api/vcs/diff"
        url.searchParams.set("mode", "working")
        const diff = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
        expect(diff.status).toBe(200)
        expect(yield* Effect.promise(() => diff.json())).toMatchObject({
          data: expect.arrayContaining([expect.objectContaining({ file: "hello.txt" })]),
        })
        url.pathname = "/api/vcs/init"
        url.searchParams.delete("mode")
        url.searchParams.set("provider", "git")
        const repeated = yield* Effect.promise(() => fetch(url, { method: "POST", headers: server.headers }))
        expect(repeated.status).toBe(409)
      }),
    15_000,
  )
})

it.live("maps a failing base provider to HTTP 503 instead of null metadata", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencook-vcs-failure-")))
    const handler = yield* ServerFetch.make(
      {
        database: { path: ":memory:" },
        config: { directory: tmp.path },
        fs: { filewatcher: false },
      },
      {
        overrides: [
          SdkPlugins.node.replace(
            Layer.succeed(
              SdkPlugins.Service,
              SdkPlugins.Service.of({
                register: () => Effect.void,
                all: () => [
                  {
                    id: "failing-vcs",
                    revision: "test",
                    effect: (ctx) =>
                      ctx.vcs
                        .transform((editor) => {
                          editor.add({
                            id: "failing",
                            name: "Failing VCS",
                            info: () => Effect.succeed({ branch: {} }),
                            branches: () => Effect.succeed([]),
                            status: () => Effect.succeed([]),
                            diff: () => Effect.succeed([]),
                            base: () => Effect.fail(new Error("provider failure")),
                          })
                          editor.default.set("failing")
                        })
                        .pipe(Effect.asVoid),
                  },
                ],
              }),
            ),
          ),
        ],
      },
    )
    const url = new URL("http://opencook.local/api/vcs/base")
    url.searchParams.set("location[directory]", tmp.path)
    const response = yield* Effect.promise(() => handler(new Request(url))).pipe(
      Effect.filterOrFail((response) => response.status === 503),
      Effect.retry(Schedule.spaced("10 millis")),
      Effect.timeout("2 seconds"),
    )
    expect(response.status).toBe(503)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({
      _tag: "ServiceUnavailableError",
      service: "vcs",
      message: "VCS provider could not resolve a review base",
    })
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
