// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"
import type { OpenCook } from "./client.js"

export * from "./generated/index"
export { OpenCook } from "./client.js"
export type {
  AgentApi,
  AppApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcClient,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@opencook/schema/agent"
export { Command } from "@opencook/schema/command"
export { Config } from "@opencook/schema/config"
export { Credential } from "@opencook/schema/credential"
export { Event } from "@opencook/schema/event"
export { EventLog } from "@opencook/schema/event-log"
export { FileSystem } from "@opencook/schema/filesystem"
export { Form } from "@opencook/schema/form"
export { Integration } from "@opencook/schema/integration"
export { Location } from "@opencook/schema/location"
export { Model } from "@opencook/schema/model"
export { Permission } from "@opencook/schema/permission"
export { PermissionSaved } from "@opencook/schema/permission-saved"
export { Project } from "@opencook/schema/project"
export { Worktree } from "@opencook/schema/worktree"
export { Vcs } from "@opencook/schema/vcs"
export { Provider } from "@opencook/schema/provider"
export { Pty } from "@opencook/schema/pty"
export { Question } from "@opencook/schema/question"
export { Reference } from "@opencook/schema/reference"
export { WebSearch } from "@opencook/schema/websearch"
export { AbsolutePath, RelativePath } from "@opencook/schema/schema"
export { Session } from "@opencook/schema/session"
export { SessionInbox } from "@opencook/schema/session-inbox"
export { SessionMessage } from "@opencook/schema/session-message"
export { Skill } from "@opencook/schema/skill"
export { Prompt } from "@opencook/schema/prompt"
export { PromptInput } from "@opencook/schema/prompt-input"
export type { OpenCookEvent } from "@opencook/protocol/groups/event"
export type OpenCookClient = Effect.Success<ReturnType<typeof OpenCook.make>>
