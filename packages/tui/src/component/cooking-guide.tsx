import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Cooking } from "@opencook/schema/cooking"
import { Kitchen } from "@opencook/schema/kitchen"
import { SessionID } from "@opencook/schema/session-id"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { DialogHeader, dialogWidth, useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { CookingNarration } from "../util/cooking-narration"
import { cookingDisplay } from "../util/cooking-display"
import { stringWidth } from "../util/string-width"

const names = { running: "进行中", paused: "已暂停", completed: "已完成", stopped: "已结束" }
const monitorNames = {
  unavailable: "无有效观测",
  checking: "检测中",
  clear: "未检出异常",
  alert: "疑似异常",
  error: "检测失败",
}
const deviceNames = { camera: "摄像头", temperature: "温度", sound: "声音", air: "空气" }
const deviceStates = {
  connected: "在线",
  disconnected: "离线",
  connecting: "连接中",
  disabled: "停用",
  unconfigured: "未配置",
}
const duration = (ms: number) =>
  `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`

export type CookingGuideState = { run: Cooking.Run | null; open: () => void }

export function CookingGuide(props: {
  sessionID: string
  showLauncher?: boolean
  onChange?: (state: CookingGuideState) => void
}) {
  const client = useClient()
  const dialog = useDialog()
  const theme = useTheme()
  const toast = useToast()
  const [run, setRun] = createSignal<Cooking.Run | null>(null)
  const [devices, setDevices] = createSignal<readonly Kitchen.DeviceStatus[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [dismissed, setDismissed] = createSignal("")
  const [muted, setMuted] = createSignal(false)
  const [replay, setReplay] = createSignal(0)
  const [speechError, setSpeechError] = createSignal("")
  const activeRun = createMemo(() => {
    const current = run()
    return current?.status === "running" || current?.status === "paused" ? current : null
  })
  const reports = new Set<string>()
  const report = (current: Cooking.Run) => {
    if (reports.has(current.id)) return
    reports.add(current.id)
    void client.api.kitchen
      .cookingReport({ session_id: SessionID.make(current.session_id), run_id: current.id })
      .catch(() => {
        toast.show({
          variant: "error",
          message: "烹饪引导已结束，结果暂未送回对话。",
          action: {
            label: "Retry 重试",
            run: () => {
              reports.delete(current.id)
              report(current)
            },
          },
        })
      })
  }
  const narration = new CookingNarration({
    synthesize: (request, signal) => client.api.kitchen.speech(request, { signal }),
    play: async (bytes, signal) => {
      const audio = await import("../audio")
      if (signal.aborted) return
      setSpeechError("")
      await audio.playSpeech(bytes, signal)
    },
    error: () => setSpeechError("语音暂不可用，屏幕指导继续运行。请检查 TTS 设置和播放设备。"),
  })
  createEffect(() => narration.update(busy() || dialog.key !== "cooking-guide" ? null : run(), muted(), replay()))
  onCleanup(() => {
    void narration.dispose()
  })
  let version = 0
  let pauseAfterControl = false
  const receive = (next: Cooking.Run | null) => {
    const previous = untrack(run)
    if (
      (next?.display_request && next.display_request !== previous?.display_request) ||
      (next?.id === previous?.id && previous?.status === "paused" && next?.status === "running")
    )
      setDismissed("")
    setRun(next)
  }
  const control = async (action: Cooking.Control["action"]) => {
    const current = run()
    if (!current || busy()) return
    narration.cancel()
    version++
    setBusy(true)
    await client.api.kitchen
      .cookingControl({
        session_id: props.sessionID,
        run_id: current.id,
        index: current.index,
        action,
        emergency_id: current.emergency?.id,
        emergency_index: current.emergency?.index,
      })
      .then((value) => {
        receive(value)
        setError("")
      })
      .catch((cause) => {
        setError("操作未成功，请核对当前步骤后重试。")
        toast.error(cause)
      })
      .finally(() => {
        setBusy(false)
        if (!pauseAfterControl) return
        pauseAfterControl = false
        if (run()?.status === "running") void control("pause")
      })
  }
  const open = () => {
    if (!run() || dialog.key === "cooking-guide") return
    dialog.replace(
      () => (
        <CookingGuideView
          run={run()}
          devices={devices()}
          busy={busy()}
          error={error() || speechError()}
          control={control}
          muted={muted()}
          toggleSpeech={() => {
            setMuted(!muted())
            setSpeechError("")
          }}
          replaySpeech={() => {
            setMuted(false)
            setSpeechError("")
            setReplay((value) => value + 1)
          }}
        />
      ),
      () => {
        const current = untrack(run)
        if (!current) return
        setDismissed(current.id)
        narration.cancel()
        if (current.status === "running") {
          if (busy()) pauseAfterControl = true
          else void control("pause")
        }
      },
      { key: "cooking-guide", size: "viewport" },
    )
  }
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !!activeRun() && dialog.stack.length === 0,
    commands: [
      {
        id: "cooking.open",
        title: "Open cooking guide 打开烹饪指导",
        group: "Cooking 烹饪",
        palette: true,
        slash: { name: "cooking", aliases: ["guide", "烹饪"] },
        run: open,
      },
    ],
  }))
  createEffect(() => props.onChange?.({ run: activeRun(), open }))
  onCleanup(() => props.onChange?.({ run: null, open }))

  createEffect(() => {
    const sessionID = props.sessionID
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setRun(null)
    setDismissed("")
    const poll = async () => {
      try {
        const requested = version
        const next = await client.api.kitchen.cooking({ session_id: sessionID })
        if (disposed) return
        if (requested !== version) return
        receive(next)
        if (next && (next.status === "running" || next.status === "paused" || dialog.key === "cooking-guide")) {
          const status = await client.api.kitchen.status()
          if (!disposed) setDevices(status)
        }
        if (!disposed) setError("")
      } catch {
        narration.cancel()
        if (!disposed) setDevices([])
        if (!disposed && untrack(run)) setError("暂时无法连接后台，显示的是上次收到的进度。")
      } finally {
        if (!disposed) timer = setTimeout(poll, 500)
      }
    }
    void poll()
    onCleanup(() => {
      disposed = true
      clearTimeout(timer)
    })
  })
  createEffect(() => {
    const current = run()
    if (!current || current.id === dismissed() || dialog.key === "cooking-guide") return
    if (dialog.stack.length && !current.emergency) return
    if (current.status === "running" || current.status === "paused") open()
  })
  createEffect(() => {
    const current = run()
    if (current && (current.status === "completed" || current.status === "stopped") && dialog.key !== "cooking-guide")
      report(current)
  })
  return (
    <Show when={props.showLauncher !== false && activeRun()}>
      {(current) => (
        <box paddingTop={1} flexDirection="row" gap={1} flexWrap="wrap" flexShrink={0}>
          <text fg={theme.text.action.primary.base} attributes={TextAttributes.BOLD} onMouseUp={open}>
            烹饪指导 · {current().plan.dish}
          </text>
          <text fg={theme.text.muted}>
            {names[current().status]} · {Math.min(current().index + 1, current().plan.steps.length)}/
            {current().plan.steps.length}
          </text>
          <text fg={theme.text.action.primary.base} onMouseUp={open}>
            [打开 · /cooking]
          </text>
        </box>
      )}
    </Show>
  )
}

export function CookingGuideButton(props: { run: Cooking.Run; open: () => void }) {
  const theme = useTheme()
  const renderer = useRenderer()
  const [hovered, setHovered] = createSignal(false)
  return (
    <box
      id="sidebar-cooking-guide"
      border
      borderStyle="rounded"
      borderColor={theme.border.base}
      padding={1}
      marginBottom={1}
      flexShrink={0}
      backgroundColor={hovered() ? theme.background.action.primary.hovered : theme.background.action.primary.base}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseUp={(event) => {
        if (renderer.getSelection()?.getSelectedText()) return
        event.stopPropagation()
        props.open()
      }}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text.action.primary.base}>
        {props.run.emergency ? "应急处理中 · 返回引导" : "返回烹饪引导"}
      </text>
      <text fg={theme.text.base} wrapMode="word">
        {props.run.plan.dish}
      </text>
      <text fg={theme.text.muted}>
        {names[props.run.status]} · 第 {Math.min(props.run.index + 1, props.run.plan.steps.length)} /{" "}
        {props.run.plan.steps.length} 步
      </text>
      <text fg={theme.text.muted}>点击打开 · /cooking</text>
    </box>
  )
}

export function CookingGuideView(props: {
  run: Cooking.Run | null
  devices: readonly Kitchen.DeviceStatus[]
  busy: boolean
  error: string
  control: (action: Cooking.Control["action"]) => void
  muted?: boolean
  toggleSpeech?: () => void
  replaySpeech?: () => void
}) {
  const theme = useTheme().surface("dialog")
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  dialog.setCentered(true)
  dialog.setSize("viewport")
  const active = () => props.run?.status === "running" || props.run?.status === "paused"
  const devices = createMemo(() =>
    Kitchen.deviceIDs.map((id) => {
      const state = props.devices.find((device) => device.id === id)?.state
      return { id, state, label: `${deviceNames[id]}${state ? deviceStates[state] : "未知"}` }
    }),
  )
  const emergency = () => (active() ? props.run?.emergency : undefined)
  const step = () => props.run?.plan.steps[props.run.index]
  const confirm = () => {
    if (props.busy) return
    if (emergency()) {
      if (emergency()!.index < emergency()!.steps.length) props.control("emergency_confirm")
      return
    }
    if (props.run?.status === "running") props.control("confirm")
  }
  const pause = () => {
    if (!props.busy && active() && !emergency()) props.control(props.run?.status === "paused" ? "resume" : "pause")
  }
  const stop = () => {
    if (!props.busy && active()) props.control("stop")
  }
  const buttons = createMemo(() => [
    ...(active()
      ? [
          ...(emergency()
            ? emergency()!.index < emergency()!.steps.length
              ? [{ label: "Enter 应急操作已完成", run: confirm }]
              : [
                  {
                    label: "S 确认现场已安全",
                    run: () => {
                      if (!props.busy) props.control("emergency_resolve")
                    },
                  },
                ]
            : [
                { label: "Enter 已完成", run: confirm },
                { label: props.run?.status === "paused" ? "P 恢复" : "P 暂停", run: pause },
              ]),
          { label: "Q 结束", run: stop },
          ...(props.toggleSpeech
            ? [
                { label: props.muted ? "V 语音关" : "V 语音开", run: () => props.toggleSpeech?.() },
                { label: "R 重播", run: () => props.replaySpeech?.() },
              ]
            : []),
        ]
      : []),
    { label: "Esc 返回对话", run: () => dialog.clear() },
  ])
  const frame = createMemo(() => {
    const width = Math.max(1, Math.min(dimensions().width - 2, dialogWidth("viewport", dimensions().width)) - 4)
    const height = Math.min(dimensions().height - 2, Math.max(8, Math.floor(dimensions().height * 0.75)))
    let footerRows = 1
    let used = 0
    for (const button of buttons()) {
      const size = stringWidth(button.label)
      if (used && used + 2 + size > width) {
        footerRows++
        used = 0
      }
      used += (used ? 2 : 0) + size
    }
    let deviceRows = 1
    used = 0
    for (const device of devices()) {
      const size = stringWidth(`● ${device.label}`)
      if (used && used + 2 + size > width) {
        deviceRows++
        used = 0
      }
      used += (used ? 2 : 0) + size
    }
    const source = emergency()
      ? (emergency()!.steps[emergency()!.index] ?? "应急步骤已完成。请检查现场，确认安全后按 S；普通烹饪仍保持暂停。")
      : props.run?.status === "completed"
        ? "本次烹饪引导已完毕。"
        : props.run?.status === "stopped"
          ? "本次烹饪引导已中途结束。"
          : (step()?.action ?? "正在读取当前动作…")
    const native = cookingDisplay(source, width, 0)
    const budget = Math.max(native.rows, height - footerRows - deviceRows - 4)
    const candidates = [
      ...(props.run?.warning || props.error ? [{ text: props.error || props.run!.warning!, warning: true }] : []),
      ...(props.run?.monitoring
        ? [
            {
              text: `着火监测：${monitorNames[props.run.monitoring.fire]} · 糊锅监测：${monitorNames[props.run.monitoring.burnt]}`,
              warning: false,
            },
          ]
        : []),
      ...(step() && active() && !emergency()
        ? [
            {
              text: step()!.continuous
                ? `持续动作 · 已用 ${duration(props.run!.elapsed_ms)} · 推荐剩余 ${duration(step()!.seconds * 1000 - props.run!.elapsed_ms)}（估算）`
                : "瞬时动作 · 手动确认：Enter 已完成",
              warning: false,
            },
          ]
        : []),
      ...(props.run?.completions.at(-1)?.reason === "duration"
        ? [{ text: "上一步按推荐时长结束，尚未通过传感器确认。", warning: true }]
        : []),
      ...(active() && !props.devices.some((device) => device.state === "connected")
        ? [{ text: "当前无设备观测，使用手动确认与推荐时长。", warning: false }]
        : []),
      ...(step()?.conditions.length
        ? [
            {
              text: step()!
                .conditions.map((condition) => `${condition.condition}（${condition.duration} 秒）`)
                .join("；"),
              warning: false,
            },
          ]
        : []),
    ]
    const details: { text: string; warning: boolean; rows: number }[] = []
    let remaining = budget
    const preferred = Math.max(native.rows, Math.min(20, Math.ceil(budget * 0.8)))
    const preview = cookingDisplay(source, width, preferred)
    // Reserve enough space for large lettering before adding optional detail rows.
    const legible = preview.banner ? preview : cookingDisplay(source, width, budget)
    const minimum = Math.max(preferred, legible.banner ? legible.rows : native.rows)
    for (const candidate of candidates) {
      const wrapped = cookingDisplay(candidate.text, width, 0)
      if (remaining - wrapped.rows < (candidate.warning ? native.rows : minimum)) continue
      details.push({ ...candidate, text: wrapped.source, rows: wrapped.rows })
      remaining -= wrapped.rows
    }
    const next = emergency() ? undefined : props.run?.plan.steps[props.run.index + 1]?.action
    if (next && remaining - 1 >= minimum) {
      details.push({ text: `下一步：${next}`, warning: false, rows: 1 })
      remaining--
    }
    return {
      width,
      height,
      footerRows,
      deviceRows,
      details,
      heroHeight: remaining,
      display: cookingDisplay(source, width, remaining),
    }
  })
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "return", title: "确认当前动作完成", group: "烹饪", run: confirm },
      {
        bind: "s",
        title: "确认现场已安全",
        group: "烹饪",
        run: () => {
          if (!props.busy && emergency() && emergency()!.index === emergency()!.steps.length)
            props.control("emergency_resolve")
        },
      },
      { bind: "p", title: "暂停或恢复指导", group: "烹饪", run: pause },
      { bind: "q", title: "结束指导", group: "烹饪", run: stop },
      { bind: "v", title: "切换语音播报", group: "烹饪", run: () => props.toggleSpeech?.() },
      { bind: "r", title: "重播当前步骤", group: "烹饪", run: () => props.replaySpeech?.() },
    ],
  }))
  return (
    <box id="cooking-guide-screen" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box height={1} flexShrink={0}>
        <DialogHeader title="全程烹饪指导" closeLabel="Esc 返回" />
      </box>
      <text height={1} flexShrink={0} wrapMode="none" truncate fg={theme.text.muted}>
        {props.run
          ? `${emergency() ? "应急处理中 · " + (emergency()!.kind === "fire" ? "疑似着火" : "疑似糊锅") : names[props.run.status]} · 步骤 ${Math.min(props.run.index + 1, props.run.plan.steps.length)} / ${props.run.plan.steps.length} · ${props.run.plan.dish}`
          : "正在读取烹饪进度…"}
      </text>
      <box
        id="cooking-device-status"
        height={frame().deviceRows}
        flexShrink={0}
        flexDirection="row"
        columnGap={2}
        flexWrap="wrap"
      >
        <For each={devices()}>
          {(device) => (
            <box height={1} flexShrink={0} flexDirection="row" gap={1}>
              <text
                id={`cooking-device-${device.id}-light`}
                fg={
                  device.state === "connected"
                    ? theme.text.feedback.success.base
                    : device.state === "disconnected"
                      ? theme.text.feedback.error.base
                      : device.state === "connecting"
                        ? theme.text.feedback.warning.base
                        : theme.text.muted
                }
              >
                ●
              </text>
              <text fg={theme.text.muted} wrapMode="none">
                {device.label}
              </text>
            </box>
          )}
        </For>
      </box>
      <box
        id="cooking-current-action"
        height={frame().heroHeight}
        flexShrink={0}
        justifyContent="center"
        alignItems="center"
      >
        <Show when={frame().display.banner}>
          {(banner) => (
            <text wrapMode="none" flexShrink={0} fg={theme.text.base}>
              {banner()}
            </text>
          )}
        </Show>
        <text
          id="cooking-action-full-text"
          width={frame().width}
          wrapMode="none"
          flexShrink={0}
          marginTop={frame().display.banner ? 1 : 0}
          attributes={TextAttributes.BOLD}
          fg={theme.text.base}
        >
          {frame().display.source}
        </text>
      </box>
      <For each={frame().details}>
        {(detail) => (
          <text
            height={detail.rows}
            flexShrink={0}
            wrapMode={detail.rows === 1 ? "none" : "word"}
            truncate={detail.rows === 1}
            fg={detail.warning ? theme.text.feedback.warning.base : theme.text.muted}
          >
            {detail.text}
          </text>
        )}
      </For>
      <box
        id="cooking-guide-controls"
        height={frame().footerRows}
        flexShrink={0}
        flexDirection="row"
        columnGap={2}
        flexWrap="wrap"
      >
        <For each={buttons()}>
          {(button) => (
            <text
              height={1}
              flexShrink={0}
              wrapMode="none"
              fg={props.busy ? theme.text.action.primary.disabled : theme.text.action.primary.base}
              onMouseUp={button.run}
            >
              {button.label}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
