import { Database } from "@opencook/core/database/database"
import { V1Migration } from "@opencook/core/database/v1-migration"
import { App } from "@opencook/core/app"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Node } from "@opencook/util/effect/app-node"
import { httpClient } from "@opencook/util/effect/app-node-platform"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { Bus } from "@opencook/core/bus"
import { EventLogger } from "@opencook/core/event-logger"
import { FileSystemSearch } from "@opencook/core/filesystem/search"
import { Credential } from "@opencook/core/credential"
import { Config } from "@opencook/core/config"
import { KitchenDevices } from "@opencook/core/cooking/devices/service"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { CookingExecution } from "@opencook/core/cooking/execution"
import { CookingSpeech } from "@opencook/core/cooking/speech"
import { PermissionSaved } from "@opencook/core/permission/saved"
import { PtyTicket } from "@opencook/core/pty/ticket"
import { PersistentPty } from "@opencook/core/persistent-pty"
import { Project } from "@opencook/core/project"
import { Worktree } from "@opencook/core/worktree"
import { Session } from "@opencook/core/session"
import { Instance } from "@opencook/core/instance/service"
import { SessionTransfer } from "@opencook/core/session/transfer"
import { ShellSelect } from "@opencook/core/shell/select"
import { Job } from "@opencook/core/job"
import { Mcp } from "@opencook/core/mcp/index"
import { Global } from "@opencook/util/global"
import { InstructionDiscovery } from "@opencook/core/instruction-discovery"
import { LocationServiceMap } from "@opencook/core/location-service-map"
import { LocationActivity } from "@opencook/core/location-activity"
import { SessionRestart } from "@opencook/core/session/execution/restart"
import { PluginUpdate } from "@opencook/core/plugin/update"
import { SdkPlugins } from "@opencook/core/plugin/sdk"
import { WellKnown } from "@opencook/core/wellknown"
import { Workspace } from "@opencook/core/workspace"
import { Watcher } from "@opencook/core/filesystem/watcher"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Context, Effect, Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { CorsConfig } from "./cors"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { ServerPairing } from "./pairing"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
import { ServerInfo } from "./server-info"
import type { ServerOptions } from "./options"

const applicationServiceNodes = [
  KitchenSettings.node,
  KitchenDevices.node,
  CookingExecution.node,
  CookingSpeech.node,
  Global.node,
  Database.node,
  Bus.node,
  EventLogger.node,
  httpClient,
  Job.node,
  Project.node,
  Project.sweepNode,
  Worktree.node,
  Session.node,
  Instance.node,
  SessionTransfer.node,
  SdkPlugins.node,
  PluginUpdate.node,
  PermissionSaved.node,
  PtyTicket.node,
  PersistentPty.node,
  Credential.node,
  WellKnown.node,
  PtyEnvironment.node,
  ServerPairing.node,
  LocationServiceMap.node,
  LocationActivity.node,
  SessionRestart.node,
  Workspace.node,
] as const
const applicationServices = LayerNode.group(applicationServiceNodes)

export function createRoutes(
  options: ServerOptions = {},
  serviceURLs: () => ReadonlyArray<string> = () => [],
  overrides: LayerNode.Replacements = [],
) {
  return makeRoutes(
    options.password
      ? ServerAuth.Config.configLayer({ password: Option.some(options.password) })
      : ServerAuth.Config.layer,
    options,
    serviceURLs,
    overrides,
  )
}

type InstanceNode = (
  replacements: () => LayerNode.Replacements,
) => LayerNode.Provider<Instance.Service, never, typeof Node.tags.values.global>

export function createEmbeddedRoutes(
  options: ServerOptions = {},
  overrides: LayerNode.Replacements = [],
  instances?: InstanceNode,
) {
  return makeRoutes(ServerAuth.Config.configLayer({ password: Option.none() }), options, () => [], overrides, instances)
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options: ServerOptions,
  serviceURLs: () => ReadonlyArray<string>,
  // Runtime-profile replacements (e.g. workerd) applied after the standard set, so later entries win.
  overrides: LayerNode.Replacements,
  instances?: InstanceNode,
) {
  const standard: LayerNode.Replacements = [
    KitchenSettings.node.replace(
      KitchenSettings.configured({
        file: options.config?.file,
        content: options.config?.content,
        project: options.config?.directory ? false : options.config?.project !== false,
      }),
    ),
    Database.node.replace(Database.configured(options.database)),
    PersistentPty.node.replace(PersistentPty.configured(options.pty)),
    Bus.node.replace(Bus.configured({ persist: options.events?.persist })),
    App.node.replace(App.configured(options.app)),
    Watcher.node.replace(Watcher.configured({ enabled: options.fs?.filewatcher })),
    FileSystemSearch.node.replace(FileSystemSearch.configured({ fff: options.fs?.fff })),
    Global.node.replace(Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})),
    Config.node.replace(
      Config.configured({
        project: options.config?.project,
        claude: options.config?.claude,
        file: options.config?.file,
        content: options.config?.content,
      }),
    ),
    InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: options.config?.project })),
    ShellSelect.node.replace(ShellSelect.configured({ gitbash: options.windows?.gitbash })),
    Mcp.node.replace(
      Mcp.configured({
        clientInfo: {
          name: "opencook",
          version: options.app?.version ?? "unknown",
        },
      }),
    ),
  ]
  const build = (overrides: LayerNode.Replacements) => {
    const replacements: LayerNode.Replacements = [
      ...standard,
      // Private instances resolve this list lazily so they inherit the complete host graph, including the selector.
      ...(instances ? [Instance.node.replace(instances(() => replacements))] : []),
      ...overrides,
    ]
    return AppNodeBuilder.build(applicationServices, replacements)
  }
  const serviceLayer = options.simulation
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements } = yield* Effect.promise(() => import("@opencook/simulation/backend"))
          const simulation = yield* simulationReplacements({ version: App.make(options.app).version })
          return build([...overrides, ...simulation])
        }),
      )
    : build(overrides)
  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      const services = Layer.succeedContext(context)
      const requestServices = Layer.merge(
        Layer.succeedContext(
          Context.pick(
            Database.Service,
            Credential.Service,
            PermissionSaved.Service,
            PluginUpdate.Service,
            Project.Service,
            WellKnown.Service,
          )(context),
        ),
        ServerInfo.layer(serviceURLs, Context.get(context, Global.Service).tmp, options.app),
      )
      const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers.pipe(Layer.provide(services), Layer.provide(Layer.succeed(CorsConfig, options)))),
        Layer.provide(formLocationLayer),
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(services),
        Layer.provideMerge(HttpRouter.layer),
      )
      return Layer.merge(api, V1Migration.layer.pipe(Layer.provide(services)))
    }),
  )
}
