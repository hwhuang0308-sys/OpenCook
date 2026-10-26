import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "./dialog"

export function DialogHelp() {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const shortcuts = Keymap.useShortcuts()

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "Close help 关闭帮助", group: "Dialog 对话框", run: () => dialog.clear() },
      { bind: "escape", title: "Close help 关闭帮助", group: "Dialog 对话框", run: () => dialog.clear() },
    ],
  }))

  return (
    <DialogLayout
      header={<DialogHeader title="Help 帮助" closeLabel="Esc / Enter 关闭" />}
      footer={{ actions: { primary: [{ title: "ok 确定", key: "enter", onTrigger: () => dialog.clear() }] } }}
      legacyFooter={
        <box flexDirection="row" justifyContent="flex-end">
          <box
            paddingLeft={3}
            paddingRight={3}
            backgroundColor={theme.background.action.primary.focused}
            onMouseUp={() => dialog.clear()}
          >
            <text fg={theme.text.action.primary.focused}>ok 确定</text>
          </box>
        </box>
      }
    >
      <text fg={theme.text.muted}>
        Press {shortcuts.get("command.palette.show")} to see all commands. 按此快捷键查看命令与设置。
      </text>
    </DialogLayout>
  )
}
