import path from "path"
import fs from "fs/promises"
import { writeFileSync } from "node:fs"
import { describe, expect } from "bun:test"
import { Document, Info } from "@opencook/schema/config"
import { Config } from "@opencook/core/config"
import { ConfigReferencePlugin } from "@opencook/core/config/plugin/reference"
import { ConfigCompatibilityPlugin } from "@opencook/core/config/plugin/compatibility"
import { Bus } from "@opencook/core/bus"
import { Plugin } from "@opencook/core/plugin"
import { PluginHost } from "@opencook/core/plugin/host"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { Reference } from "@opencook/core/reference"
import { Skill } from "@opencook/core/skill"
import { ShellSelect } from "@opencook/core/shell/select"
import { Job } from "@opencook/core/job"
import { SubagentJob } from "@opencook/core/session/subagent-job"
import { Global } from "@opencook/util/global"
import { Location } from "@opencook/core/location"
import { Credential } from "@opencook/core/credential"
import { WellKnown } from "@opencook/core/wellknown"
import { Watcher } from "@opencook/core/filesystem/watcher"
import { AppProcess } from "@opencook/util/process"
import { Deferred, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { AbsolutePath } from "@opencook/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.merge(
    PluginTestLayer,
    AppNodeBuilder.build(LayerNode.group([AppProcess.node, ShellSelect.node, Job.node, SubagentJob.node])),
  ),
)
const decode = Schema.decodeUnknownSync(Info)

describe("config plugin reloads", () => {
  for (const input of [
    { root: ".agents", global: false },
    { root: "../.claude", global: false },
    { root: "home/.agents", global: true },
    { root: "home/.claude", global: true },
  ]) {
    it.live(`loads skills when ${input.root} appears after startup`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.resolve(project, input.root)
            const file = path.join(project, "opencook.json")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await Bun.write(file, JSON.stringify({ shell: "initial" }))
            })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const host = yield* PluginHost.make(plugins)
              yield* ConfigCompatibilityPlugin.Plugin.effect(host)
              expect(yield* skills.list()).toEqual([])

              // Finish startup by observing an ordinary config reload before creating the root.
              yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "ready" })))
              yield* waitUntil(
                config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "ready")),
              )
              const skill = path.join(root, "skills", "probe", "SKILL.md")
              yield* Effect.promise(() =>
                Bun.write(skill, "---\nname: probe\ndescription: Hot reload\n---\nTest skill"),
              )
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items.some((item) => item.id === "probe"))))
              expect((yield* skills.list())[0]?.path).toBe(AbsolutePath.make(skill))
              yield* Effect.promise(() => fs.rm(root, { recursive: true }))
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(() => Bun.write(skill, "---\nname: probe\ndescription: Recreated\n---\nTest skill"))
              yield* waitUntil(skills.list().pipe(Effect.map((items) => items[0]?.description === "Recreated")))
            }).pipe(Effect.provide(liveConfig(project, undefined, { global: input.global })))
          }),
        ),
      ),
    )
  }

  it.live("retains readiness signalled synchronously during initial config startup", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const native = Watcher.Native.of({
          subscribe: (input) =>
            Effect.sync(() => {
              if (input.type === "entries" && input.target === tmp.path) {
                // No event is emitted: only synchronous readiness can trigger the reload.
                writeFileSync(path.join(tmp.path, "opencook.json"), JSON.stringify({ references: { docs: "./docs" } }))
              }
              return { unsubscribe: () => Promise.resolve() }
            }),
        })
        return Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const references = yield* Reference.Service
          const host = yield* PluginHost.make(plugins)
          yield* ConfigReferencePlugin.Plugin.effect(host)
          yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
          expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "docs")))
        }).pipe(Effect.provide(liveConfig(tmp.path, native)))
      }),
    ),
  )

  it.live("loads the first config written while a new directory watch is starting", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, ".opencook")
          const parent = yield* Deferred.make<(update: Watcher.Update) => void>()
          const starting = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const native = Watcher.Native.of({
            subscribe: (input) =>
              Effect.gen(function* () {
                if (input.type === "entries" && input.target === tmp.path) {
                  yield* Deferred.succeed(parent, input.publish)
                }
                if (input.type === "directory" && input.target === root) {
                  yield* Deferred.succeed(starting, undefined)
                  yield* Deferred.await(release)
                }
                return { unsubscribe: () => Promise.resolve() }
              }),
          })
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const references = yield* Reference.Service
            const host = yield* PluginHost.make(plugins)
            yield* ConfigReferencePlugin.Plugin.effect(host)
            const publish = yield* Deferred.await(parent)
            yield* Effect.promise(() => fs.mkdir(root))
            publish({ path: root, type: "create" })
            yield* Deferred.await(starting).pipe(Effect.timeout("2 seconds"))
            // No file event: the recursive native watch has not been acquired yet.
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, "opencook.json"), JSON.stringify({ references: { docs: "./docs" } })),
            )
            yield* Deferred.succeed(release, undefined)
            yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
            expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(root, "docs")))
          }).pipe(Effect.provide(liveConfig(tmp.path, native)))
        }),
      ),
    ),
  )

  for (const input of [
    { file: "opencook.json", empty: false },
    { file: "../opencook.jsonc", empty: false },
    { file: ".opencook/opencook.json", empty: false },
    { file: "../.opencook/opencook.jsonc", empty: true },
  ]) {
    it.live(`loads references when ${input.file} is first created and keeps watching it`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const target = path.resolve(project, input.file)
            yield* Effect.promise(() => fs.mkdir(project))
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const references = yield* Reference.Service
              const host = yield* PluginHost.make(plugins)
              yield* ConfigReferencePlugin.Plugin.effect(host)
              expect(yield* references.list()).toEqual([])

              if (input.empty) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(target)))
                const config = yield* Config.Service
                yield* waitUntil(
                  config
                    .entries()
                    .pipe(
                      Effect.map((entries) =>
                        entries.some((entry) => entry.type === "directory" && entry.path === path.dirname(target)),
                      ),
                    ),
                )
              }
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))),
              )
              expect((yield* references.list())[0]?.path).toBe(
                AbsolutePath.make(path.join(path.dirname(target), "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )

              yield* Effect.promise(() =>
                fs.rm(input.file.includes(".opencook/") ? path.dirname(target) : target, { recursive: true }),
              )
              yield* waitUntil(references.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )
            }).pipe(Effect.provide(liveConfig(project)))
          }),
        ),
      ),
    )
  }

  it.effect("preserves reference precedence and insertion order across documents", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const host = yield* PluginHost.make(plugins)
      yield* references.transform((editor) =>
        editor.add(
          "external",
          Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/references/external") }),
        ),
      )
      yield* ConfigReferencePlugin.Plugin.effect(host)

      const result = yield* references.list()
      expect(result.map((reference) => reference.name)).toEqual(["external", "shared", "first", "second"])
      expect(result.find((reference) => reference.name === "shared")?.path).toBe(
        AbsolutePath.make(path.resolve("/config/second/shared")),
      )
    }).pipe(
      Effect.provide(
        Config.testLayer([
          referenceConfig("/config/first/opencook.json", {
            shared: "./shared",
            first: "./first",
          }),
          referenceConfig("/config/second/opencook.json", {
            shared: "./shared",
            second: "./second",
          }),
        ]),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )
})

function liveConfig(directory: string, native?: Watcher.NativeInterface, options: Config.Options = { global: false }) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    ...(native
      ? [Watcher.node.replace(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))]
      : []),
  ])
}

function referenceConfig(file: string, references: Record<string, string>) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(file),
    info: decode({ references }),
  })
}

const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* condition) return
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die("Timed out waiting for config plugin reloads")
})
