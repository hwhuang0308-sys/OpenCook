export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@opencook/plugin/effect/plugin"
import { Effect, Stream } from "effect"
import path from "path"
import { Config } from "../../config.js"
import { Global } from "@opencook/util/global"
import { Permission } from "../../permission.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"

type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "read", "edit"] as const satisfies readonly PathAction[]

export const Plugin = define({
  id: "opencook.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const load = () =>
      config.entries().pipe(Effect.map((entries) => entries.filter((entry) => entry.type === "document")))
    const loaded = { documents: yield* load() }
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        load().pipe(
          Effect.tap((documents) =>
            Effect.sync(() => {
              loaded.documents = documents
            }),
          ),
          Effect.andThen(ctx.agent.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.agent.transform((editor) => {
      const documents = loaded.documents
      const permissions = expandPermissions(
        documents.flatMap((document) => document.info.permissions ?? []),
        global.home,
      )
      for (const current of editor.list()) {
        const specific = documents.flatMap((document) => document.info.agents?.[current.id]?.permissions ?? [])
        editor.update(current.id, (agent) => {
          agent.permissions.push(...permissions, ...expandPermissions(specific, global.home))
        })
      }
    })
  }),
})

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string): action is PathAction {
  return pathActions.some((item) => item === action)
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}
