/** @jsxImportSource @opentui/solid */
import { beforeEach, expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { mkdir, symlink } from "node:fs/promises"
import path from "node:path"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { renderLocal } from "./fixture/local"
import { tmpdir } from "./fixture/fixture"
import { DialogIntegration } from "../src/component/dialog-integration"
import { takeDraft } from "../src/component/prompt/draft-stash"

beforeEach(() => {
  takeDraft(undefined)
})

test("external services are labeled separately and do not include model configuration", async () => {
  await using setup = await renderLocal({
    fetch: async (url) => {
      if (url.pathname !== "/api/integration") return
      return json({
        location: { directory },
        data: [
          { id: "opencook", name: "OpenCook 对话模型", methods: [{ type: "key", label: "API Key" }], connections: [] },
          {
            id: "opencook-vision",
            name: "OpenCook 多模态模型",
            methods: [{ type: "key", label: "API Key" }],
            connections: [],
          },
          { id: "exa", name: "Exa", methods: [{ type: "key", label: "API Key" }], connections: [] },
        ],
      })
    },
  })
  await setup.data.location.integration.sync()
  setup.dialog.replace(() => <DialogIntegration />)
  await setup.renderOnce()
  const frame = setup.captureCharFrame()
  expect(frame).toContain("连接外部服务")
  expect(frame).toContain("联网搜索与网页服务")
  expect(frame).toContain("Exa")
  expect(frame).not.toContain("OpenCook 对话模型")
  expect(frame).not.toContain("OpenCook 多模态模型")
  setup.dialog.clear()
  await setup.renderOnce()
})

test("missing chat model opens all five model settings even when a search service is connected", async () => {
  await using plugin = await tmpdir()
  const pluginDirectory = path.join(plugin.path, "kitchen-ready")
  await mkdir(pluginDirectory)
  await symlink(path.join(import.meta.dir, "../node_modules"), path.join(pluginDirectory, "node_modules"))
  await Bun.write(
    path.join(pluginDirectory, "tui.tsx"),
    Bun.file(path.join(import.meta.dir, "fixture/plugin/kitchen-ready/tui.tsx")),
  )
  const profile = {
    enabled: false,
    base_url: "",
    model: "",
    context: 128000,
    output: 8192,
    has_key: false,
    source: "unconfigured",
  }
  const serial = {
    enabled: false,
    port: "",
    baud_rate: 9600,
    timeout_ms: 1000,
    sample_period_ms: 500,
    buffer_seconds: 60,
  }
  await using setup = await createAppFixture({
    config: { animations: false, plugins: [pluginDirectory], debug: { devtools: true } },
    fetch: async (url) => {
      const requested = url.searchParams.get("location[directory]") ?? directory
      const location = { directory: requested, project: { id: "project", directory: requested, canonical: requested } }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "cook", name: "Cook", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/integration")
        return json({
          location,
          data: [{ id: "exa", name: "Exa", methods: [], connections: [{ type: "env", name: "EXA_API_KEY" }] }],
        })
      if (url.pathname === "/api/kitchen/settings")
        return json({
          models: {
            chat: profile,
            vision: profile,
            speech: profile,
            embedding: profile,
            rerank: profile,
          },
          devices: {
            camera: { enabled: false, rtsp_url: "", buffer_frames: 60, ffmpeg_path: "" },
            temperature: serial,
            sound: serial,
            air: serial,
          },
          camera_has_password: false,
          recording: { enabled: false, directory: "/tmp/opencook-test-captures" },
        })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Kitchen catalog ready"))
  await setup.waitFor(() => setup.renderer.currentFocusedRenderable instanceof TextareaRenderable)
  await setup.mockInput.typeText("你好")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("模型服务") && frame.includes("文本对话"))
  const frame = setup.captureCharFrame()
  for (const label of ["多模态视觉", "语音合成 TTS", "Embedding", "Rerank"]) expect(frame).toContain(label)
  expect(frame).not.toContain("语音识别")
  expect(frame).not.toContain("Connect an integration")
  expect(frame).not.toContain("Exa")
  const labels = ["Server 服务", "UI 界面", "Theme 主题", "Tools 工具", "Experiments 实验"]
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => labels.every((label) => frame.includes(label)))
  setup.resize(44, 30)
  await setup.waitForFrame((frame) => labels.every((label) => frame.includes(label)))
})
