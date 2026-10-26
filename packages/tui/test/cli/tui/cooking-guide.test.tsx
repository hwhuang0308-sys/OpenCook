/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { TextRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { Cooking } from "@opencook/schema/cooking"
import { createSignal, onMount, Show } from "solid-js"
import {
  CookingGuide,
  CookingGuideButton,
  CookingGuideView,
  type CookingGuideState,
} from "../../../src/component/cooking-guide"
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

const run: Cooking.Run = {
  id: "run-test",
  session_id: "session-test",
  status: "running",
  index: 0,
  elapsed_ms: 0,
  started_at: 0,
  updated_at: 0,
  completions: [],
  plan: {
    task_id: "recipe-test",
    revision: 1,
    dish: "测试菜",
    recipe_text: "测试配方",
    program: "测试程序谱",
    actions: "测试动作谱",
    steps: [
      { action: "清洗西红柿", continuous: false, seconds: 0, conditions: [], logic: "" },
      { action: "切西红柿成块", continuous: false, seconds: 0, conditions: [], logic: "" },
    ],
  },
}

test.each([
  { width: 240, height: 72, action: "清洗西红柿" },
  { width: 100, height: 40, action: "清洗西红柿" },
  { width: 44, height: 32, action: "清洗西红柿" },
  {
    width: 100,
    height: 32,
    action: "将切好的西红柿放入锅中，小心热油溅出，沿锅边轻轻倒入，然后缓慢翻动食材。".repeat(20).slice(0, 600),
  },
  {
    width: 44,
    height: 32,
    action: "加入鸡蛋液后轻轻推动锅边的蛋液，等待底部凝固，再用锅铲翻动，最后关火。".repeat(10).slice(0, 300),
  },
])("fits the complete action and keyboard controls at $width columns", async ({ width, height, action }) => {
  await using temporary = await tmpdir()
  const controls: string[] = []
  const initial = { ...run, plan: { ...run.plan, steps: [{ ...run.plan.steps[0], action }, run.plan.steps[1]] } }
  function View() {
    const [current, setCurrent] = createSignal(initial)
    return (
      <CookingGuideView
        run={current()}
        devices={[]}
        busy={false}
        error=""
        control={(action) => {
          controls.push(action)
          if (action === "pause") setCurrent({ ...initial, status: "paused" })
          if (action === "resume") setCurrent(initial)
          if (action === "stop") setCurrent({ ...initial, status: "stopped" })
        }}
      />
    )
  }
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <View />, undefined, { size: "xlarge" }))
    return null
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ home: temporary.path, state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Open />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导"))
    const source = app.renderer.root.findDescendantById("cooking-action-full-text")
    const screen = app.renderer.root.findDescendantById("cooking-guide-screen")
    const footer = app.renderer.root.findDescendantById("cooking-guide-controls")
    if (!(source instanceof TextRenderable) || !screen || !footer) throw new Error("Cooking screen is incomplete")
    expect(source.plainText.replace(/\n/g, "")).toBe(action)
    expect(source.y).toBeGreaterThanOrEqual(screen.y)
    expect(source.y + source.height).toBeLessThanOrEqual(footer.y)
    expect(footer.y + footer.height).toBeLessThanOrEqual(height)
    expect(screen.width).toBe(width > 80 ? Math.floor(width * 0.75) : width - 2)
    expect(screen.height).toBeLessThanOrEqual(Math.floor(height * 0.75))
    if (action === "清洗西红柿") {
      if (width > 44) expect(app.captureCharFrame()).toContain("下一步：切西红柿成块")
      expect(app.captureCharFrame()).toContain("手动确认")
      expect(app.captureCharFrame()).toMatch(/[▀▄█]/)
    }
    for (const device of ["camera", "temperature", "sound", "air"]) {
      const light = app.renderer.root.findDescendantById(`cooking-device-${device}-light`)
      if (!light) throw new Error(`Missing ${device} connectivity light`)
      expect(light.y).toBeLessThan(source.y)
    }
    app.mockInput.pressEnter()
    await app.waitFor(() => controls.length === 1)
    expect(controls).toEqual(["confirm"])
    app.mockInput.pressKey("p")
    await app.waitForFrame((frame) => frame.includes("已暂停"))
    expect(app.captureCharFrame()).toContain("已暂停")
    app.mockInput.pressEnter()
    expect(controls).toEqual(["confirm", "pause"])
    app.mockInput.pressKey("p")
    app.mockInput.pressKey("q")
    await app.waitForFrame((frame) => frame.includes("本次烹饪引导已中途结束"))
    expect(controls).toEqual(["confirm", "pause", "resume", "stop"])
    expect(app.captureCharFrame()).toContain("本次烹饪引导已中途结束")
  } finally {
    app.renderer.destroy()
  }
})

test("opens the cooking screen from server state, sends current run/index, and pauses when dismissed", async () => {
  await using temporary = await tmpdir()
  const commands: Cooking.Control[] = []
  let current = { ...run }
  let polled: (() => void) | undefined
  let commandsInUi: ReturnType<typeof Keymap.useCommands>
  function Screen() {
    commandsInUi = Keymap.useCommands()
    const [state, setState] = createSignal<CookingGuideState>()
    return (
      <>
        <CookingGuide sessionID="session-test" onChange={setState} />
        <Show when={state()?.run}>
          {(current) => <CookingGuideButton run={current()} open={() => state()?.open()} />}
        </Show>
      </>
    )
  }
  const api = createApi(
    createFetch(async (url, request) => {
      if (url.pathname === "/api/kitchen/cooking") {
        polled?.()
        polled = undefined
        return json(current)
      }
      if (url.pathname === "/api/kitchen/cooking/speech") return json({ status: "disabled" })
      if (url.pathname === "/api/kitchen/status") return json([{ id: "temperature", state: "connected", value: 65 }])
      if (url.pathname === "/api/kitchen/cooking/control") {
        const command = (await request.json()) as Cooking.Control
        commands.push(command)
        current = { ...current, status: command.action === "pause" ? "paused" : "running" }
        return json(current)
      }
    }).fetch,
  )
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ home: temporary.path, state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ClientProvider api={api}>
                <ToastProvider>
                  <DialogProvider>
                    <Screen />
                  </DialogProvider>
                </ToastProvider>
              </ClientProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 100, height: 32, kittyKeyboard: true },
  )
  app.renderer.start()
  try {
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("温度在线"))
    app.mockInput.pressEscape()
    await app.waitFor(() => commands.length === 1)
    expect(commands[0]).toEqual({ session_id: "session-test", run_id: "run-test", index: 0, action: "pause" })
    await app.waitForFrame((frame) => !frame.includes("全程烹饪指导") && frame.includes("[打开 · /cooking]"))
    const command = commandsInUi!().find((command) => command.id === "cooking.open")
    expect(command?.slash?.name).toBe("cooking")
    expect(command?.bind).toBeUndefined()
    command?.run()
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("已暂停"))
    expect(commands).toHaveLength(1)
    app.mockInput.pressKey("p")
    await app.waitFor(() => commands.length === 2)
    await app.waitForFrame((frame) => frame.includes("进行中"))
    expect(commands[1]).toEqual({ session_id: "session-test", run_id: "run-test", index: 0, action: "resume" })
    app.mockInput.pressEscape()
    await app.waitFor(() => commands.length === 3)
    await app.waitForFrame((frame) => !frame.includes("全程烹饪指导") && frame.includes("返回烹饪引导"))
    const button = app.renderer.root.findDescendantById("sidebar-cooking-guide")
    if (!button) throw new Error("Missing cooking sidebar button")
    await app.mockMouse.click(button.x + 2, button.y + 1)
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("已暂停"))
    expect(commands).toHaveLength(3)
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("全程烹饪指导"))
    const nextPoll = Promise.withResolvers<void>()
    polled = nextPoll.resolve
    current = { ...current, status: "running" }
    await nextPoll.promise
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("进行中"))
    expect(current.index).toBe(0)
    expect(current.id).toBe("run-test")
    app.mockInput.pressEscape()
    await app.waitFor(() => commands.length === 4)
    await app.waitForFrame((frame) => !frame.includes("全程烹饪指导"))
    const openPoll = Promise.withResolvers<void>()
    polled = openPoll.resolve
    current = { ...current, status: "paused", display_request: "requested-by-cook" }
    await openPoll.promise
    await app.waitForFrame((frame) => frame.includes("全程烹饪指导") && frame.includes("已暂停"))
    expect(commands).toHaveLength(4)
    expect(current.index).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test.each([44, 100])(
  "emergency instructions fit in full and require a distinct safe-scene action at width %s",
  async (width) => {
    await using temporary = await tmpdir()
    const controls: string[] = []
    const action =
      "疑似着火！能安全操作时立即关火；不要向油锅泼水，不要移动燃烧的锅。火势失控或无法安全处理时，立即撤离并拨打当地消防电话（中国大陆 119）。"
    function View() {
      const [current, setCurrent] = createSignal<Cooking.Run>({
        ...run,
        status: "paused",
        emergency: {
          id: "incident",
          kind: "fire",
          index: 0,
          steps: [action],
          interrupted_step: 0,
          time: 0,
        },
      })
      return (
        <CookingGuideView
          run={current()}
          devices={[]}
          busy={false}
          error=""
          control={(value) => {
            controls.push(value)
            if (value === "emergency_confirm")
              setCurrent({ ...current(), emergency: { ...current().emergency!, index: 1 } })
            if (value === "stop") setCurrent({ ...current(), status: "stopped" })
          }}
        />
      )
    }
    function Open() {
      const dialog = useDialog()
      onMount(() => dialog.replace(() => <View />, undefined, { size: "viewport" }))
      return null
    }
    const app = await testRender(
      () => (
        <TestTuiContexts directory={temporary.path} paths={{ home: temporary.path, state: temporary.path }}>
          <ConfigProvider config={createTuiResolvedConfig({})}>
            <Keymap.Provider>
              <ThemeProvider mode="dark" source={emptyThemeSource}>
                <ToastProvider>
                  <DialogProvider>
                    <Open />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width, height: 40, kittyKeyboard: true },
    )
    app.renderer.start()
    try {
      await app.waitForFrame((frame) => frame.includes("应急处理中"))
      const source = app.renderer.root.findDescendantById("cooking-action-full-text")
      if (!(source instanceof TextRenderable)) throw new Error("Missing emergency instruction")
      expect(source.plainText.replace(/\n/g, "")).toBe(action)
      app.mockInput.pressKey("p")
      app.mockInput.pressKey("s")
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("S 确认现场已安全"))
      expect(controls).toEqual(["emergency_confirm"])
      app.mockInput.pressEnter()
      app.mockInput.pressKey("p")
      app.mockInput.pressKey("s")
      await app.waitFor(() => controls.length === 2)
      expect(controls).toEqual(["emergency_confirm", "emergency_resolve"])
      app.mockInput.pressKey("q")
      await app.waitForFrame((frame) => frame.includes("本次烹饪引导已中途结束"))
      expect(app.captureCharFrame()).not.toContain("应急处理中")
      expect(app.captureCharFrame()).not.toContain("S 确认现场已安全")
      app.mockInput.pressEnter()
      app.mockInput.pressKey("s")
      await app.renderOnce()
      expect(controls).toEqual(["emergency_confirm", "emergency_resolve", "stop"])
    } finally {
      app.renderer.destroy()
    }
  },
)
