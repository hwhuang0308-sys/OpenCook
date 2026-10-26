/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { onCleanup } from "solid-js"
import { DialogProvider } from "../../../src/ui/dialog"
import { DialogSecret } from "../../../src/ui/dialog-secret"
import { ThemeProvider } from "../../../src/context/theme"
import { ConfigProvider } from "../../../src/config"
import { ToastProvider } from "../../../src/ui/toast"
import { Keymap } from "../../../src/context/keymap"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

test.each([100, 44])("secret editor masks typed and pasted credentials at width %d", async (width) => {
  await using temporary = await tmpdir()
  const confirmed: string[] = []
  let cancelled = 0
  function Secret() {
    onCleanup(Keymap.use().mode.push("modal"))
    return <DialogSecret title="API Key" onConfirm={(value) => confirmed.push(value)} onCancel={() => cancelled++} />
  }
  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={temporary.path}
        paths={{ home: temporary.path, state: path.join(temporary.path, "state"), worktree: temporary.path }}
      >
        <ConfigProvider config={createTuiResolvedConfig({})}>
          <Keymap.Provider>
            <ThemeProvider mode="dark" source={emptyThemeSource}>
              <ToastProvider>
                <DialogProvider>
                  <Secret />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </Keymap.Provider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 24, kittyKeyboard: true },
  )
  try {
    await app.renderOnce()
    await app.mockInput.typeText("private-key")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("●")
    expect(app.captureCharFrame()).not.toContain("private-key")
    app.mockInput.pressBackspace()
    app.mockInput.pressEnter()
    expect(confirmed).toEqual(["private-ke"])
    app.mockInput.pressKey("u", { ctrl: true })
    await app.mockInput.pasteBracketedText("pasted-secret\n")
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("pasted-secret")
    app.mockInput.pressEnter()
    expect(confirmed).toEqual(["private-ke", "pasted-secret"])
    app.mockInput.pressEscape()
    expect(cancelled).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
