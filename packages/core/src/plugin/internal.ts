export * as PluginInternal from "./internal.js"

import { LLMClient } from "@opencook/ai"
import type { Plugin } from "@opencook/plugin/effect/plugin"
import { LayerNode } from "@opencook/util/effect/layer-node"
import { httpClient } from "@opencook/util/effect/app-node-platform"
import { AppProcess } from "@opencook/util/process"
import { Context, Effect, Scope } from "effect"
import { HttpClient } from "effect/http"
import { Agent } from "../agent.js"
import { Model } from "../model.js"
import { ModelRuntimePlugin } from "./model-runtime.js"
import { KitchenSettings } from "../cooking/settings.js"
import { Provider } from "../provider.js"
import { Command } from "../command.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { llmClient } from "../effect/app-node-platform.js"
import { ConfigAgentPlugin } from "../config/plugin/agent.js"
import { ConfigCompactionPlugin } from "../config/plugin/compaction.js"
import { ConfigFormatterPlugin } from "../config/plugin/formatter.js"
import { ConfigImagePlugin } from "../config/plugin/image.js"
import { ConfigLocationWatcherPlugin } from "../config/plugin/location-watcher.js"
import { ConfigMcpPlugin } from "../config/plugin/mcp.js"
import { ConfigPolicyPlugin } from "../config/plugin/policy.js"
import { ConfigReferencePlugin } from "../config/plugin/reference.js"
import { ConfigShellPlugin } from "../config/plugin/shell.js"
import { ConfigSnapshotPlugin } from "../config/plugin/snapshot.js"
import { ConfigCompatibilityPlugin } from "../config/plugin/compatibility.js"
import { ConfigWorktreePlugin } from "../config/plugin/worktree.js"
import { ConfigToolOutputPlugin } from "../config/plugin/tool-output.js"
import { ConfigWebSearchPlugin } from "../config/plugin/websearch.js"
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { FileMutation } from "../file-mutation.js"
import { Formatter } from "../formatter.js"
import { Form } from "../form.js"
import { FileSystem } from "../filesystem.js"
import { LocationWatcherPolicy } from "../filesystem/location-watcher-policy.js"
import { FSUtil } from "@opencook/util/fs-util"
import { Global } from "@opencook/util/global"
import { Image } from "../image.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Integration } from "../integration.js"
import { Job } from "../job.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { ManagedPolicy } from "../managed-policy.js"
import { Mcp } from "../mcp/index.js"
import { Npm } from "@opencook/util/npm"
import { Permission } from "../permission.js"
import { Reference } from "../reference.js"
import { WebSearch } from "../websearch.js"
import { Ripgrep } from "../ripgrep.js"
import { Session } from "../session.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionInstructions } from "../session/instructions.js"
import { SubagentJob } from "../session/subagent-job.js"
import { Shell } from "../shell.js"
import { ShellSelect } from "../shell/select.js"
import { Snapshot } from "../snapshot.js"
import { Skill } from "../skill.js"
import { SkillDiscovery } from "../skill/discovery.js"
import { Watcher } from "../filesystem/watcher.js"
import { EditTool } from "../tool/plugin/edit.js"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { McpResourceTools } from "../tool/plugin/mcp-resource.js"
import { ConversationTools } from "../tool/plugin/conversation.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { ReadTool } from "../tool/plugin/read.js"
import { ShellTool } from "../tool/plugin/shell.js"
import { SkillTool } from "../tool/plugin/skill.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { WebFetchTool } from "../tool/plugin/webfetch.js"
import { WebSearchTool } from "../tool/plugin/websearch.js"
import { WellKnown } from "../wellknown.js"
import { WriteTool } from "../tool/plugin/write.js"
import { AgentPlugin } from "./agent.js"
import { CookingPlugin } from "./cooking.js"
import { CookingKnowledge } from "../cooking/knowledge.js"
import { CookingWorkflow } from "../cooking/workflow.js"
import { CookingCompiler } from "../cooking/compiler.js"
import { CookingExecution } from "../cooking/execution.js"
import { CookingMemory } from "../cooking/memory.js"
import { CookingRequirements } from "../cooking/requirements.js"
import { SessionStore } from "../session/store.js"
import BrowserPlugin from "@opencook/plugin-browser"
import { CommandPlugin } from "./command.js"
import { IdentityPlugin } from "./identity.js"
import { McpCodeModeDefaultsPlugin } from "./mcp-codemode-defaults.js"
import { WebSearchPlugins } from "./websearch/index.js"
import { ToolInputRepairPlugin } from "./tool-input-repair.js"
import { VerbosityPlugin } from "./verbosity.js"
import { WarmingPlugin } from "./warming.js"
import { WellKnownPlugin } from "../wellknown/plugin.js"

const services = [
  KitchenSettings.Service,
  Agent.Service,
  CookingKnowledge.Service,
  CookingWorkflow.Service,
  CookingCompiler.Service,
  CookingExecution.Service,
  CookingMemory.Service,
  CookingRequirements.Service,
  SessionStore.Service,
  AppProcess.Service,
  Provider.Service,
  Model.Service,
  Command.Service,
  Config.Service,
  Credential.Service,
  Bus.Service,
  Environment.Service,
  FileAccess.Service,
  FileMutation.Service,
  Formatter.Service,
  LocationWatcherPolicy.Service,
  FileSystem.Service,
  FSUtil.Service,
  Global.Service,
  HttpClient.HttpClient,
  Image.Service,
  InstructionDiscovery.Service,
  Integration.Service,
  Job.Service,
  KV.Service,
  LLMClient.Service,
  Location.Service,
  ManagedPolicy.Service,
  Mcp.Service,
  Npm.Service,
  Permission.Service,
  Form.Service,
  ReadToolFileSystem.Service,
  Reference.Service,
  WebSearch.Service,
  Ripgrep.Service,
  Session.Service,
  SessionCompaction.Service,
  SessionInstructions.Service,
  SubagentJob.Service,
  Shell.Service,
  ShellSelect.Service,
  Snapshot.Service,
  Skill.Service,
  SkillDiscovery.Service,
  Tool.Service,
  ToolOutput.Service,
  Watcher.Service,
  WellKnown.Service,
  Worktree.Service,
  WorktreeStrategies.Service,
] as const

export type Requirements = Context.Service.Identifier<(typeof services)[number]>

export const requirements = LayerNode.group([
  KitchenSettings.node,
  Agent.node,
  CookingKnowledge.node,
  CookingWorkflow.node,
  CookingCompiler.node,
  CookingExecution.node,
  CookingMemory.node,
  CookingRequirements.node,
  SessionStore.node,
  AppProcess.node,
  Provider.node,
  Model.node,
  Command.node,
  Config.node,
  Credential.node,
  Bus.node,
  Environment.node,
  FileAccess.node,
  FileMutation.node,
  Formatter.node,
  LocationWatcherPolicy.node,
  FileSystem.node,
  FSUtil.node,
  Global.node,
  httpClient,
  Image.node,
  InstructionDiscovery.node,
  Integration.node,
  Job.node,
  KV.node,
  llmClient,
  Location.node,
  ManagedPolicy.node,
  Mcp.node,
  Npm.node,
  Permission.node,
  Form.node,
  ReadToolFileSystem.node,
  Reference.node,
  WebSearch.node,
  Ripgrep.node,
  Session.node,
  SessionCompaction.node,
  SessionInstructions.node,
  SubagentJob.node,
  Shell.node,
  ShellSelect.node,
  Snapshot.node,
  Skill.node,
  SkillDiscovery.node,
  Tool.node,
  ToolOutput.node,
  Watcher.node,
  WellKnown.node,
  Worktree.node,
  WorktreeStrategies.node,
])

export type InternalPlugin = Plugin<Requirements | Scope.Scope>

const pre = [
  ToolInputRepairPlugin.Plugin,
  ConfigWorktreePlugin.Plugin,
  ConfigMcpPlugin.Plugin,
  McpCodeModeDefaultsPlugin.Plugin,
  WellKnownPlugin.Plugin,
  AgentPlugin.Plugin,
  CookingPlugin.Plugin,
  CommandPlugin.Plugin,
  ...WebSearchPlugins,
  VerbosityPlugin.Plugin,
  IdentityPlugin.Plugin,
  EditTool.Plugin,
  GlobTool.Plugin,
  GrepTool.Plugin,
  ConversationTools.Plugin,
  McpResourceTools.Plugin,
  QuestionTool.Plugin,
  ReadTool.Plugin,
  ShellTool.Plugin,
  SkillTool.Plugin,
  SubagentTool.Plugin,
  WebFetchTool.Plugin,
  WebSearchTool.Plugin,
  WriteTool.Plugin,
  WarmingPlugin.Plugin,
] as const satisfies readonly InternalPlugin[]

const post = [
  ConfigReferencePlugin.Plugin,
  ConfigAgentPlugin.Plugin,
  BrowserPlugin,
  ConfigCompactionPlugin.Plugin,
  ConfigFormatterPlugin.Plugin,
  ConfigImagePlugin.Plugin,
  ConfigLocationWatcherPlugin.Plugin,
  ConfigShellPlugin.Plugin,
  ConfigSnapshotPlugin.Plugin,
  ConfigToolOutputPlugin.Plugin,
  ConfigCompatibilityPlugin.Plugin,
  ConfigWebSearchPlugin.Plugin,
  ConfigPolicyPlugin.Plugin,
  ModelRuntimePlugin.Plugin,
] as const satisfies readonly InternalPlugin[]

// Product model routing and access policy cannot be disabled by workspace configuration.
export const guarded: ReadonlySet<string> = new Set([ModelRuntimePlugin.Plugin.id, ConfigPolicyPlugin.Plugin.id])

export const list = Effect.fn("PluginInternal.list")(function* () {
  // Capture only services; activation supplies the child Scope and batching context.
  const context = Context.pick(...services)(yield* Effect.context<Requirements>())
  const resolve = (plugins: readonly InternalPlugin[]) =>
    plugins.map(
      (plugin): Plugin => ({
        id: plugin.id,
        effect: (host) => plugin.effect(host).pipe(Effect.provide(context)),
      }),
    )
  return {
    pre: resolve(pre),
    post: resolve(post),
  }
})
