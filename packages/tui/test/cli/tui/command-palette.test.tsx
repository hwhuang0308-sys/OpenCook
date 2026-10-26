/** @jsxImportSource @opentui/solid */
import { InputRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onMount } from "solid-js"
import { ConfigProvider, resolve, type Info, type Interface } from "../../../src/config"
import { CommandPaletteDialog } from "../../../src/component/command-palette"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider } from "../../../src/context/theme"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"

test.each([
  { query: "sound", width: 100 },
  { query: "提示音", width: 68 },
])("finds bilingual settings with $query at width $width and saves stable values", async ({ query, width }) => {
  await using temporary = await tmpdir()
  let current: Info = {}
  const service: Interface = {
    get: async () => current,
    update: async (update) => {
      const draft = structuredClone(current)
      update(draft)
      current = draft
      return current
    },
  }

  function Fixture() {
    const dialog = useDialog()
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.new",
          title: "New session",
          group: "Session",
          palette: true,
          run() {},
        },
        {
          id: "model.list",
          title: "Switch model",
          group: "Agent",
          palette: true,
          run() {},
        },
      ],
    }))
    onMount(() => dialog.replace(() => <CommandPaletteDialog />))
    return null
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={temporary.path}
        paths={{ home: temporary.path, state: temporary.path, worktree: temporary.path }}
      >
        <ConfigProvider config={resolve(current, { terminalSuspend: true })} service={service}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Fixture />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24, kittyKeyboard: true },
  )
  app.renderer.start()

  try {
    await app.waitForFrame((frame) => frame.includes("New session"))
    expect(app.captureCharFrame()).not.toContain("Animations")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)

    app.mockInput.pressArrow("down")
    app.mockInput.typeText(query)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Settings 设置") && frame.includes("Sounds 提示音"))
    expect(app.captureCharFrame()).toContain("off 关闭")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitFor(() => current.attention?.sound === true)
  } finally {
    app.renderer.destroy()
  }
})
