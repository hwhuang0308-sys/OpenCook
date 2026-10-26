/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { Kitchen } from "@opencook/schema/kitchen"
import { DialogKitchen } from "../../../src/component/dialog-kitchen"
import { ClientProvider } from "../../../src/context/client"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ThemeProvider } from "../../../src/context/theme"
import { ConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { Keymap } from "../../../src/context/keymap"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createApi, createFetch, json } from "../../fixture/tui-client"

const model = {
  enabled: false,
  base_url: "",
  model: "",
  context: 128000,
  output: 8192,
  has_key: false,
  source: "unconfigured",
} as const
const serial = {
  enabled: false,
  port: "",
  baud_rate: 9600,
  timeout_ms: 1000,
  sample_period_ms: 500,
  buffer_seconds: 60,
}
const settings: Kitchen.Settings = {
  models: { chat: model, vision: model, speech: model, embedding: model, rerank: model },
  devices: {
    camera: { enabled: false, rtsp_url: "", buffer_frames: 60, ffmpeg_path: "" },
    temperature: serial,
    sound: serial,
    air: serial,
  },
  camera_has_password: false,
  recording: { enabled: false, directory: "/tmp/opencook-test-captures" },
}

test.each(
  (["models", "devices", "recording"] as const).flatMap((section) => [100, 68].map((width) => ({ section, width }))),
)("renders bilingual $section settings and supports keyboard editing at width $width", async ({ section, width }) => {
  await using temporary = await tmpdir()
  const saved: unknown[] = []
  const api = createApi(
    createFetch(async (url, request) => {
      if (url.pathname === "/api/kitchen/settings") return json(settings)
      if (url.pathname === "/api/kitchen/status")
        return json([
          { id: "camera", state: "disabled" },
          { id: "temperature", state: "connected", value: 81.2, unit: "°C" },
          { id: "sound", state: "disconnected", message: "串口连接失败" },
          { id: "air", state: "connecting" },
        ])
      if (url.pathname === "/api/kitchen/recording" || url.pathname === "/api/kitchen/model") {
        saved.push(await request.json())
        return json(settings)
      }
    }).fetch,
  )
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogKitchen section={section} />))
    return null
  }
  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={temporary.path}
        paths={{ home: temporary.path, state: temporary.path, worktree: temporary.path }}
      >
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ClientProvider api={api}>
                <ToastProvider>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ToastProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 32, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) =>
      frame.includes(section === "models" ? "文本对话" : section === "devices" ? "声音强度传感器" : "编辑调试记录设置"),
    )
    if (section === "models") {
      for (const name of [
        "Text chat 文本对话",
        "Multimodal vision 多模态视觉",
        "Speech 语音合成 TTS",
        "Embedding 向量模型",
        "Rerank 重排模型",
      ])
        expect(app.captureCharFrame()).toContain(name)
      await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
      app.mockInput.pressArrow("down")
      app.mockInput.pressArrow("down")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("播报音色") && frame.includes("female_news"))
      await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
      app.mockInput.typeText("播报音色")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("选择播报音色") && frame.includes("丽娃"))
      await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
      app.mockInput.typeText("丽娃")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("播报音色") && frame.includes("liwa"))
      await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
      app.mockInput.typeText("保存")
      app.mockInput.pressEnter()
      await app.waitFor(() => saved.length === 1)
      expect(saved[0]).toMatchObject({ role: "speech", profile: { voice: "liwa", speed: 1 } })
      return
    }
    if (section === "devices") {
      await app.waitForFrame(
        (frame) => frame.includes("已连接") && frame.includes("未连接") && frame.includes("连接中"),
      )
      expect(app.captureCharFrame()).toContain("●")
      expect(app.captureCharFrame()).toContain("Connected 已连接")
      expect(app.captureCharFrame()).toContain("Disconnected 未连接")
      return
    }
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("传感器调试记录") && frame.includes("保存目录"))
    expect(app.captureCharFrame()).toContain("Off 关闭")
    expect(app.captureCharFrame()).toContain("Debug mode 调试模式")
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("开启"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitFor(() => saved.length === 1)
    expect(saved).toEqual([{ enabled: true, directory: settings.recording.directory }])
  } finally {
    app.renderer.destroy()
  }
})
