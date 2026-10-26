import { createMemo, createSignal, For } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { useRoute } from "../context/route"
import { useLocal } from "../context/local"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { describeOS, describeTerminal } from "../util/system"
import { useTuiApp } from "../context/runtime"
import { useNewDesigns } from "../config"

export function DialogDebug() {
  const theme = useTheme()
  const dialog = useDialog()
  const route = useRoute()
  const local = useLocal()
  const clipboard = useClipboard()
  const toast = useToast()
  const app = useTuiApp()
  const newDesigns = useNewDesigns()
  const [copied, setCopied] = createSignal(false)

  dialog.setSize("large")

  const entries = createMemo(() => {
    const model = local.model.current()
    return [
      { label: "Version 版本", value: `${app.version} (${app.channel})` },
      { label: "Date 日期", value: new Date().toISOString() },
      { label: "OS 操作系统", value: describeOS() },
      { label: "Terminal 终端", value: describeTerminal() },
      { label: "Session ID 会话编号", value: route.data.type === "session" ? route.data.sessionID : "n/a" },
      { label: "Model 模型", value: model ? `${model.providerID}/${model.modelID}` : "n/a" },
    ]
  })

  const copy = () => {
    const text = entries()
      .map((entry) => `${entry.label}: ${entry.value}`)
      .join("\n")
    void clipboard
      .write(text)
      .then(() => {
        setCopied(true)
        toast.show({ message: "Debug info copied to clipboard 调试信息已复制到剪贴板", variant: "info" })
      })
      .catch(toast.error)
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: newDesigns() ? "c" : "return", title: "Copy debug info 复制调试信息", group: "Dialog 对话框", run: copy },
    ],
  }))

  const copyAction = () => ({
    title: copied() ? "✓ copied 已复制" : "copy 复制",
    key: newDesigns() ? "c" : "enter",
    color: copied() ? theme.text.feedback.success.base : undefined,
    onTrigger: copy,
  })

  return (
    <DialogLayout
      header={
        <DialogHeader title="Debug 调试" description="Share this when reporting an issue 反馈问题时可附上这些信息" />
      }
      footer={{
        actions: { primary: [copyAction()] },
        get children() {
          if (newDesigns()) return undefined
          return <text fg={theme.text.muted}>Share this when reporting an issue. 反馈问题时可附上这些信息。</text>
        },
      }}
    >
      {/* No click-to-copy here: releasing a mouse selection must trigger the
          global copy-on-select so users can copy a single value, e.g. the session id. */}
      <For each={entries()}>
        {(entry) => (
          <box flexDirection="row" gap={1}>
            <text flexShrink={0} fg={theme.text.muted}>
              {entry.label.padEnd(10)}
            </text>
            <text fg={theme.text.base} wrapMode="word">
              {entry.value}
            </text>
          </box>
        )}
      </For>
    </DialogLayout>
  )
}
