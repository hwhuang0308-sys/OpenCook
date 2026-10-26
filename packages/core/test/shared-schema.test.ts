import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "@opencook/core/agent"
import { Session } from "@opencook/core/session"
import { SessionStore } from "@opencook/core/session/store"
import { Location } from "@opencook/schema/location"
import { Model } from "@opencook/schema/model"
import { Provider } from "@opencook/schema/provider"
import { Project } from "@opencook/schema/project"
import { Worktree } from "@opencook/schema/worktree"
import { Prompt } from "@opencook/schema/prompt"
import { SessionInbox } from "@opencook/schema/session-inbox"
import { SessionMessage } from "@opencook/schema/session-message"
import { Workspace } from "@opencook/schema/workspace"
import { Command } from "@opencook/schema/command"
import { Connection } from "@opencook/schema/connection"
import { Credential } from "@opencook/schema/credential"
import { FileSystem } from "@opencook/schema/filesystem"
import { Integration } from "@opencook/schema/integration"
import { LLM } from "@opencook/schema/llm"
import { Permission } from "@opencook/schema/permission"
import { Pty } from "@opencook/schema/pty"
import { Reference } from "@opencook/schema/reference"
import { Skill } from "@opencook/schema/skill"
import { AbsolutePath, optional, statics } from "@opencook/schema/schema"

test("Core reuses the canonical shared schemas", async () => {
  const schemaAgent = await import("@opencook/schema/agent")
  const schemaSession = await import("@opencook/schema/session")
  const [
    coreCommand,
    coreConnection,
    coreCredential,
    coreFileSystem,
    coreIntegration,
    coreLocation,
    coreAI,
    coreModel,
    corePermission,
    coreWorktree,
    corePty,
    coreProject,
    coreProvider,
    coreReference,
    coreSessionInbox,
    coreSessionMessage,
    coreSkill,
    coreSchema,
    coreWorkspace,
  ] = await Promise.all([
    import("@opencook/core/command"),
    import("@opencook/core/integration/connection"),
    import("@opencook/core/credential"),
    import("@opencook/core/filesystem"),
    import("@opencook/core/integration"),
    import("@opencook/core/location"),
    import("@opencook/ai"),
    import("@opencook/core/model"),
    import("@opencook/core/permission"),
    import("@opencook/core/worktree"),
    import("@opencook/core/pty"),
    import("@opencook/core/project/schema"),
    import("@opencook/core/provider"),
    import("@opencook/core/reference"),
    import("@opencook/core/session/inbox"),
    import("@opencook/core/session/message"),
    import("@opencook/core/skill"),
    import("@opencook/core/schema"),
    import("@opencook/core/workspace"),
  ])

  const schemas = [
    [Agent.ID, schemaAgent.Agent.ID],
    [Agent.Name, schemaAgent.Agent.Name],
    [Agent.Color, schemaAgent.Agent.Color],
    [Agent.Info, schemaAgent.Agent.Info],
    [coreCommand.Info, Command.Info],
    [coreConnection.CredentialInfo, Connection.CredentialInfo],
    [coreConnection.EnvInfo, Connection.EnvInfo],
    [coreConnection.Info, Connection.Info],
    [coreCredential.ID, Credential.ID],
    [coreCredential.OAuth, Credential.OAuth],
    [coreCredential.Key, Credential.Key],
    [coreCredential.Value, Credential.Value],
    [coreFileSystem.Entry, FileSystem.Entry],
    [coreFileSystem.Submatch, FileSystem.Submatch],
    [coreFileSystem.Match, FileSystem.Match],
    [coreIntegration.ID, Integration.ID],
    [coreIntegration.MethodID, Integration.MethodID],
    [coreIntegration.OAuthMethod, Integration.OAuthMethod],
    [coreIntegration.KeyMethod, Integration.KeyMethod],
    [coreIntegration.EnvMethod, Integration.EnvMethod],
    [coreIntegration.Method, Integration.Method],
    [coreIntegration.Ref, Integration.Ref],
    [coreLocation.Ref, Location.Ref],
    [coreAI.FinishReason, LLM.FinishReason],
    [coreModel.ID, Model.ID],
    [coreModel.VariantID, Model.VariantID],
    [coreModel.Ref, Model.Ref],
    [coreModel.Family, Model.Family],
    [coreModel.Capabilities, Model.Capabilities],
    [coreModel.Cost, Model.Cost],
    [coreModel.Info, Model.Info],
    [coreProvider.ID, Provider.ID],
    [coreProvider.Request, Provider.Request],
    [coreProvider.Compaction, Provider.Compaction],
    [coreProvider.Transport, Provider.Transport],
    [coreProvider.Settings, Provider.Settings],
    [coreProvider.Info, Provider.Info],
    [corePermission.Effect, Permission.Effect],
    [corePermission.Rule, Permission.Rule],
    [corePermission.Ruleset, Permission.Ruleset],
    [coreWorktree.CreateInput, Worktree.CreateInput],
    [coreWorktree.RemoveInput, Worktree.RemoveInput],
    [coreWorktree.Info, Worktree.Info],
    [coreWorktree.List, Worktree.List],
    [coreWorktree.Event, Worktree.Event],
    [corePty.Info, Pty.Info],
    [corePty.Event, Pty.Event],
    [coreProject.ID, Project.ID],
    [coreProject.Current, Project.Current],
    [coreReference.LocalSource, Reference.LocalSource],
    [coreReference.GitSource, Reference.GitSource],
    [coreReference.Source, Reference.Source],
    [Session.ID, schemaSession.Session.ID],
    [Session.Info, schemaSession.Session.Info],
    [Session.ListAnchor, schemaSession.Session.ListAnchor],
    [Session.ListInput, SessionStore.ListInput],
    [coreSessionInbox.Delivery, SessionInbox.Delivery],
    [coreSessionInbox.Item, SessionInbox.Item],
    [coreSessionInbox.User, SessionInbox.User],
    [coreSessionInbox.Synthetic, SessionInbox.Synthetic],
    [coreSessionMessage.ID, SessionMessage.ID],
    [coreSessionMessage.AssistantRetry, SessionMessage.AssistantRetry],
    [coreSessionMessage.AgentSelected, SessionMessage.AgentSelected],
    [coreSessionMessage.ModelSelected, SessionMessage.ModelSelected],
    [coreSessionMessage.LocationSwitched, SessionMessage.LocationSwitched],
    [coreSessionMessage.User, SessionMessage.User],
    [coreSessionMessage.Synthetic, SessionMessage.Synthetic],
    [coreSessionMessage.System, SessionMessage.System],
    [coreSessionMessage.Shell, SessionMessage.Shell],
    [coreSessionMessage.ToolStateStreaming, SessionMessage.ToolStateStreaming],
    [coreSessionMessage.ToolStateRunning, SessionMessage.ToolStateRunning],
    [coreSessionMessage.ToolStateCompleted, SessionMessage.ToolStateCompleted],
    [coreSessionMessage.ToolStateError, SessionMessage.ToolStateError],
    [coreSessionMessage.ToolState, SessionMessage.ToolState],
    [coreSessionMessage.AssistantTool, SessionMessage.AssistantTool],
    [coreSessionMessage.AssistantText, SessionMessage.AssistantText],
    [coreSessionMessage.AssistantReasoning, SessionMessage.AssistantReasoning],
    [coreSessionMessage.AssistantContent, SessionMessage.AssistantContent],
    [coreSessionMessage.Assistant, SessionMessage.Assistant],
    [coreSessionMessage.Compaction, SessionMessage.Compaction],
    [coreSessionMessage.Info, SessionMessage.Info],
    [coreSkill.DirectorySource, Skill.DirectorySource],
    [coreSkill.UrlSource, Skill.UrlSource],
    [coreSkill.EmbeddedSource, Skill.EmbeddedSource],
    [coreSkill.Source, Skill.Source],
    [coreSkill.Info, Skill.Info],
    [coreSchema.optional, optional],
    [coreSchema.statics, statics],
    [coreWorkspace.ID, Workspace.ID],
  ]
  for (const [core, shared] of schemas) expect(core).toBe(shared)

  expect(coreModel.Info.default(coreProvider.ID.make("test"), coreModel.ID.make("model"))).toEqual(
    Model.Info.default(Provider.ID.make("test"), Model.ID.make("model")),
  )
  expect(coreProvider.Info.empty(coreProvider.ID.make("test"))).toEqual(Provider.Info.empty(Provider.ID.make("test")))
  expect(Skill.Source.key(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/tmp") }))).toBe(
    "directory:/tmp",
  )
})

test("shared record schemas construct and decode plain objects", () => {
  const made = Prompt.make({ text: "hello" })
  const decoded = Schema.decodeUnknownSync(Prompt)({ text: "hello" })
  const content = Schema.decodeUnknownSync(SessionMessage.AssistantText)({ type: "text", text: "hi" })

  expect(Object.getPrototypeOf(made)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(Object.getPrototypeOf(content)).toBe(Object.prototype)
  expect(Prompt.ast.annotations?.identifier).toBe("Prompt")
  expect(SessionMessage.AssistantText.ast.annotations?.identifier).toBe("Session.Message.Assistant.Text")
  expect(Prompt.equivalence(Prompt.make({ text: "hello" }), decoded)).toBe(true)
  expect(Prompt.fromUserMessage({ text: "hello" })).toEqual(made)
  expect(Workspace.ID.ascending("")).toStartWith("wrk_")
})
