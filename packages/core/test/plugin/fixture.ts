import { Global } from "@opencook/util/global"
import { tempGlobalLayer } from "../fixture/global"
import { Agent } from "@opencook/core/agent"
import { AISDK } from "@opencook/core/aisdk"
import { Command } from "@opencook/core/command"
import { Config } from "@opencook/core/config"
import { Credential } from "@opencook/core/credential"
import { Database } from "@opencook/core/database/database"
import { FileAccess } from "@opencook/core/file-access"
import { LayerNodePlatform } from "@opencook/util/effect/app-node-platform"
import { AppProcess } from "@opencook/util/process"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { Bus } from "@opencook/core/bus"
import { FileSystem } from "@opencook/core/filesystem"
import { FSUtil } from "@opencook/util/fs-util"
import { Form } from "@opencook/core/form"
import { Generate } from "@opencook/core/generate"
import { Integration } from "@opencook/core/integration"
import { KV } from "@opencook/core/kv"
import { KitchenSettings } from "@opencook/core/cooking/settings"
import { Location } from "@opencook/core/location"
import { ManagedPolicy } from "@opencook/core/managed-policy"
import { Mcp } from "@opencook/core/mcp/index"
import { Model } from "@opencook/core/model"
import { ModelResolver } from "@opencook/core/model-resolver"
import { Npm } from "@opencook/util/npm"
import { Plugin } from "@opencook/core/plugin"
import { PluginHooks } from "@opencook/core/plugin/hooks"
import { Provider } from "@opencook/core/provider"
import { Session } from "@opencook/core/session"
import { PersistentPty } from "@opencook/core/persistent-pty"
import { LocationServiceMap } from "@opencook/core/location-service-map"
import { AppNodeBuilder } from "@opencook/core/effect/app-node-builder"
import { Permission } from "@opencook/core/permission"
import { Reference } from "@opencook/core/reference"
import { Rpc } from "@opencook/core/rpc"
import { Skill } from "@opencook/core/skill"
import { SkillDiscovery } from "@opencook/core/skill/discovery"
import { Watcher } from "@opencook/core/filesystem/watcher"
import { Tool } from "@opencook/core/tool"
import { Vcs } from "@opencook/core/vcs"
import { WebSearch } from "@opencook/core/websearch"
import { Worktree } from "@opencook/core/worktree"
import { WorktreeStrategies } from "@opencook/core/worktree/strategies"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const configLayer = Config.testLayer()

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
  }),
)

export const makePluginTestLayer = <const Extra extends readonly LayerNode.Graph<never>[] = []>(
  permission = permissionLayer,
  ...extra: Extra
) =>
  AppNodeBuilder.build(
    LayerNode.group([
      AppProcess.node,
      FileSystem.node,
      FSUtil.node,
      Location.node,
      Npm.node,
      Credential.node,
      Config.node,
      Database.node,
      FileAccess.node,
      Bus.node,
      Form.node,
      Generate.node,
      LayerNodePlatform.httpClient,
      Plugin.node,
      Agent.node,
      AISDK.node,
      Provider.node,
      Model.node,
      ModelResolver.node,
      Command.node,
      Integration.node,
      KV.node,
      KitchenSettings.node,
      ManagedPolicy.node,
      Mcp.node,
      Session.node,
      PersistentPty.node,
      LocationServiceMap.node,
      Permission.node,
      PluginHooks.node,
      Reference.node,
      Rpc.node,
      Skill.node,
      SkillDiscovery.node,
      Tool.node,
      Vcs.node,
      Watcher.node,
      WebSearch.node,
      Worktree.node,
      WorktreeStrategies.node,
      ...extra,
    ]),
    [
      Location.node.replace(tempLocationLayer),
      Npm.node.replace(npmLayer),
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(configLayer),
      Mcp.node.replace(emptyMcpLayer),
      Generate.node.replace(generateLayer),
      Permission.node.replace(permission),
    ],
  ).pipe(Layer.provideMerge(configLayer))

export const PluginTestLayer = makePluginTestLayer()
