import { decodePasteBytes } from "@opentui/core"
import { useKeyboard, usePaste } from "@opentui/solid"
import { createSignal } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout } from "./dialog"

// Keep the secret outside renderable text buffers and terminal selection/copy paths.
export function DialogSecret(props: {
  title: string
  value?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const theme = useTheme().surface("dialog")
  const [value, setValue] = createSignal(props.value ?? "")
  const append = (text: string) => setValue((previous) => previous + text.replace(/[\r\n\x00-\x1f\x7f]/g, ""))
  usePaste((event) => {
    event.preventDefault()
    append(decodePasteBytes(event.bytes))
  })
  useKeyboard((event) => {
    if (event.ctrl || event.meta || event.name === "return" || event.name === "escape" || event.name === "backspace")
      return
    if (event.sequence && !event.sequence.startsWith("\x1b")) {
      event.preventDefault()
      event.stopPropagation()
      append(event.sequence)
    }
  })
  Keymap.createLayer(() => ({
    mode: "modal",
    enabled: true,
    priority: 2,
    commands: [
      { bind: "return", title: "Save 保存", run: () => props.onConfirm(value()) },
      { bind: "escape", title: "Back 返回", run: props.onCancel },
      {
        bind: "backspace",
        title: "Delete 删除",
        run: () => setValue((text) => Array.from(text).slice(0, -1).join("")),
      },
      { bind: "ctrl+u", title: "Clear 清空", run: () => setValue("") },
    ],
  }))
  return (
    <DialogLayout
      header={<DialogHeader title={props.title} onClose={props.onCancel} />}
      footer={{
        actions: {
          primary: [
            { title: "Save 保存", key: "enter", onTrigger: () => props.onConfirm(value()) },
            { title: "Clear 清空", key: "ctrl+u", onTrigger: () => setValue("") },
          ],
        },
      }}
    >
      <text fg={theme.text.muted}>
        Input is masked; paste supported. Ctrl+U clears. / 输入内容仅显示为圆点，可粘贴；Ctrl+U 清空输入。
      </text>
      <text fg={theme.text.formfield.base}>
        {"●".repeat(Math.min(Array.from(value()).length, 44)) || "Enter secret… 请输入…"}
      </text>
    </DialogLayout>
  )
}
