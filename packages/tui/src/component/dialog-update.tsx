import { createEffect, createMemo, createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Keymap } from "../context/keymap"
import { useNewDesigns } from "../config"
import { useTheme } from "../context/theme"
import type { UpdateState } from "../context/update-notification"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { errorMessage } from "../util/error"
import { Spinner } from "./spinner"

export function DialogUpdate(props: {
  check?: (signal: AbortSignal) => Promise<string | undefined>
  state: () => UpdateState | undefined
  skip: () => void
  install: () => Promise<void>
  restart: () => void
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const [error, setError] = createSignal<string>()
  const [active, setActive] = createSignal(0)
  const controller = new AbortController()
  onCleanup(() => controller.abort())

  dialog.setCentered(true)

  const [check] = createResource(
    () => props.check,
    (check) =>
      check(controller.signal).catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error))
        return undefined
      }),
  )
  const state = createMemo(() => {
    const message = error()
    if (message) return { type: "check-failed" as const, message }
    const current = props.state()
    if (current?.type === "installing") return current
    if (check.loading) return { type: "checking" as const }
    const unavailable = check()
    if (unavailable) return { type: "unavailable" as const, message: unavailable }
    return current ?? { type: "current" as const }
  })
  const buttons = createMemo(() => {
    const type = state().type
    if (type === "installing") return []
    const confirm =
      type === "available"
        ? { label: "Update 更新", run: props.install }
        : type === "installed"
          ? { label: "Restart 重启", run: props.restart }
          : undefined
    return [
      {
        label: "Skip 跳过",
        run: () => {
          props.skip()
          dialog.clear()
        },
      },
      ...(confirm ? [confirm] : []),
    ]
  })

  createEffect(() => setActive(Math.max(0, buttons().length - 1)))

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "return",
        title: "Confirm update action 确认更新操作",
        group: "Dialog 对话框",
        run: () => void buttons()[newDesigns() ? buttons().length - 1 : active()]?.run(),
      },
      ...(newDesigns() ? [] : ["left", "right", "tab", "shift+tab"]).map((bind) => ({
        bind,
        title:
          bind === "left" || bind === "shift+tab"
            ? "Previous update action 上一个更新操作"
            : "Next update action 下一个更新操作",
        group: "Dialog 对话框",
        run: () => {
          const count = buttons().length
          if (count) setActive((value) => (value + 1) % count)
        },
      })),
    ],
  }))

  return (
    <DialogLayout
      header={
        <DialogHeader
          title={
            state().type === "installing"
              ? "Updating OpenCook 正在更新 OpenCook"
              : state().type === "available" || state().type === "failed"
                ? "Update available 有可用更新"
                : "Update 更新"
          }
        />
      }
      footer={{
        actions: {
          primary: buttons().map((button, index) => ({
            title: button.label.toLowerCase(),
            key: index === buttons().length - 1 ? "enter" : undefined,
            onTrigger: () => void button.run(),
          })),
        },
      }}
      legacyFooter={
        <Show when={buttons().length > 0}>
          <box flexDirection="row" justifyContent="flex-end">
            <For each={buttons()}>
              {(button, index) => (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={active() === index() ? theme.background.action.primary.focused : undefined}
                  onMouseUp={() => void button.run()}
                >
                  <text fg={active() === index() ? theme.text.action.primary.focused : theme.text.muted}>
                    {button.label}
                  </text>
                </box>
              )}
            </For>
          </box>
        </Show>
      }
    >
      <Show when={state()} keyed>
        {(current) => (
          <Switch>
            <Match when={current.type === "checking"}>
              <Spinner shimmer={theme.text.base}>Checking for updates… 正在检查更新…</Spinner>
            </Match>
            <Match when={current.type === "available"}>
              <text fg={theme.text.muted}>
                An update is available. After installing, you'll be prompted to restart OpenCook.
                有可用更新，安装完成后会提示重启 OpenCook。
              </text>
            </Match>
            <Match when={current.type === "installing"}>
              <Spinner shimmer={theme.text.base}>
                {current.type === "installing" ? `Installing OpenCook ${current.version}…` : ""}
              </Spinner>
            </Match>
            <Match when={current.type === "installed"}>
              <text fg={theme.text.muted} wrapMode="word">
                Update successful! A restart is required. Any active sessions will be resumed automatically.
                更新完成，请重启；活动会话将自动恢复。
              </text>
            </Match>
            <Match when={current.type === "current"}>
              <text fg={theme.text.muted}>OpenCook is already up to date. OpenCook 已是最新版本。</text>
            </Match>
            <Match when={current.type === "unavailable"}>
              <text fg={theme.text.muted} wrapMode="word">
                {current.type === "unavailable" ? current.message : ""}
              </text>
            </Match>
            <Match when={current.type === "failed" || current.type === "check-failed"}>
              <text fg={theme.text.feedback.error.base}>
                {current.type === "failed" || current.type === "check-failed" ? current.message : ""}
              </text>
            </Match>
          </Switch>
        )}
      </Show>
    </DialogLayout>
  )
}
