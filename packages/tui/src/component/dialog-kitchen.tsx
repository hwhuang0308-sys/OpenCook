import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import type { Types } from "effect"
import { Kitchen } from "@opencook/schema/kitchen"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSecret } from "../ui/dialog-secret"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

const modelNames: Record<Kitchen.ModelRole, string> = {
  chat: "Text chat 文本对话",
  vision: "Multimodal vision 多模态视觉",
  speech: "Speech 语音合成 TTS",
  embedding: "Embedding 向量模型",
  rerank: "Rerank 重排模型",
}
const deviceNames: Record<Kitchen.DeviceID, string> = {
  camera: "Camera 摄像头",
  temperature: "Temperature 温度传感器",
  sound: "Sound level 声音强度传感器",
  air: "Air quality 空气质量传感器",
}
const stateNames: Record<Kitchen.DeviceStatus["state"], string> = {
  connected: "Connected 已连接",
  disconnected: "Disconnected 未连接",
  connecting: "Connecting 连接中",
  disabled: "Disabled 已停用",
  unconfigured: "Not configured 未配置",
}

export function DialogKitchen(props: { section: "models" | "devices" | "recording" }) {
  const client = useClient()
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const toast = useToast()
  const [error, setError] = createSignal("")
  const [settings] = createResource(() =>
    client.api.kitchen.settings().catch((error) => {
      setError(errorMessage(error))
      return undefined
    }),
  )
  const [status, { refetch }] = createResource(
    () => props.section === "devices",
    (enabled) => (enabled ? client.api.kitchen.status().catch(() => []) : Promise.resolve([])),
  )
  onMount(() => {
    if (props.section !== "devices") return
    const interval = setInterval(() => void refetch(), 1000)
    onCleanup(() => clearInterval(interval))
  })
  const back = () => dialog.replace(() => <DialogKitchen section={props.section} />)
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const config = settings()
    if (!config) return []
    if (props.section === "models")
      return Kitchen.modelRoles.map((role) => ({
        title: modelNames[role],
        value: role,
        footer: config.models[role].enabled ? config.models[role].model : "Disabled 未启用",
        description:
          role === "chat"
            ? "Cook chat, recipes, plans and documents / Cook 对话、菜谱、规划与文档"
            : role === "vision"
              ? "Camera and image understanding / 摄像头图像与图片理解"
              : role === "speech"
                ? "Read cooking instructions aloud / 将指导文字转换为语音"
                : role === "embedding"
                  ? "Knowledge indexing and query vectors / 知识库入库与查询向量"
                  : "Rerank retrieved sources / 对检索候选资料重新排序",
        onSelect: () => dialog.replace(() => <ModelEditor role={role} config={config} onBack={back} />),
      }))
    if (props.section === "recording")
      return [
        {
          title: "Edit debug recording 编辑调试记录设置",
          value: "recording",
          footer: config.recording.enabled ? "On 开启" : "Off 关闭",
          onSelect: () => dialog.replace(() => <RecordingEditor config={config} onBack={back} />),
        },
      ]
    return Kitchen.deviceIDs.map((id) => {
      const live = status()?.find((entry) => entry.id === id)
      const state =
        live?.state ?? (!config.devices[id].enabled ? "disabled" : status.loading ? "connecting" : "disconnected")
      const color =
        state === "connected"
          ? theme.text.feedback.success.base
          : state === "disconnected"
            ? theme.text.feedback.error.base
            : state === "connecting"
              ? theme.text.feedback.warning.base
              : theme.text.muted
      return {
        title: deviceNames[id],
        value: id,
        footer: stateNames[state],
        gutter: () => <text fg={color}>●</text>,
        description: live?.value === undefined ? live?.message : `${live.value.toFixed(2)} ${live.unit ?? ""}`,
        details: [
          live?.last_sample
            ? `Last valid sample 最近有效数据：${new Date(live.last_sample).toLocaleTimeString()}`
            : "No valid samples yet 尚未收到有效数据",
          ...(live?.message ? [live.message] : []),
        ],
        onSelect: () => dialog.replace(() => <DeviceEditor id={id} config={config} onBack={back} />),
      }
    })
  })
  return (
    <DialogSelect
      title={
        props.section === "models"
          ? "Model services 模型服务"
          : props.section === "devices"
            ? "Kitchen devices 厨房设备"
            : "Sensor debug 传感器调试"
      }
      options={options()}
      emptyView={<text fg={theme.text.muted}>{error() || "Loading settings… 正在读取设置…"}</text>}
      footer={
        props.section === "recording" ? (
          <text fg={theme.text.muted}>
            Off: process in memory only. On: save locally. / 关闭时仅在内存中处理传感数据；开启后保存到本机。
          </text>
        ) : props.section === "models" && settings()?.config_file ? (
          <text fg={theme.text.muted} wrapMode="word">
            Config file 配置文件：{settings()!.config_file}
          </text>
        ) : undefined
      }
      actions={
        props.section === "devices"
          ? [
              {
                command: "kitchen.reconnect",
                title: "Reconnect 重新连接",
                bind: "ctrl+r",
                onTrigger: (option) => {
                  const id = Kitchen.deviceIDs.find((id) => id === option.value)
                  if (id)
                    void client.api.kitchen
                      .reconnect({ id })
                      .then(() => refetch())
                      .catch(toast.error)
                },
              },
            ]
          : undefined
      }
    />
  )
}

function ModelEditor(props: { role: Kitchen.ModelRole; config: Kitchen.Settings; onBack: () => void }) {
  const client = useClient()
  const toast = useToast()
  const initial = props.config.models[props.role]
  const [profile, setProfile] = createStore<Types.DeepMutable<Kitchen.ModelProfile>>({
    enabled: initial.enabled,
    base_url: initial.base_url,
    model: initial.model,
    context: initial.context,
    output: initial.output,
    voice: props.role === "speech" ? (initial.voice ?? "female_news") : initial.voice,
    speed: props.role === "speech" ? (initial.speed ?? 1) : initial.speed,
  })
  const [key, setKey] = createSignal<string | null>()
  const [busy, setBusy] = createSignal(false)
  const [choosingVoice, setChoosingVoice] = createSignal(false)
  const [editing, setEditing] = createSignal<{
    title: string
    value: string
    apply: (text: string) => void
    secret?: boolean
  }>()
  const edit = (field: "base_url" | "model" | "context" | "output" | "voice" | "speed", title: string) =>
    setEditing({
      title,
      value: String(profile[field]),
      apply: (text) => {
        if (field === "speed") {
          const speed = Number(text)
          if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
            toast.show({ variant: "error", message: "Speed must be 0.25–4.0 / 语速范围为 0.25 至 4 倍" })
            return
          }
          setProfile("speed", speed)
        } else if (field === "context" || field === "output") {
          const value = Number(text)
          if (!Number.isSafeInteger(value) || value <= 0) {
            toast.show({ variant: "error", message: "Enter a positive integer / 请输入正整数" })
            return
          }
          setProfile(field, value)
        } else setProfile(field, text.trim())
        setEditing(undefined)
      },
    })
  async function save() {
    if (busy()) return
    setBusy(true)
    await client.api.kitchen
      .model({ role: props.role, profile: { ...profile }, api_key: key() })
      .then(props.onBack)
      .catch(toast.error)
      .finally(() => setBusy(false))
  }
  return (
    <>
      {choosingVoice() ? (
        <DialogSelect
          title="Choose voice 选择播报音色"
          onCancel={() => setChoosingVoice(false)}
          options={[
            ...[
              {
                value: "female_sweet",
                title: "Sweet female 甜美女声",
                description: "Bright and friendly / 明亮、亲和",
              },
              { value: "liwa", title: "Liwa 丽娃", description: "Balanced female voice / 音色平衡的女声" },
              {
                value: "female_literary",
                title: "Literary female 文艺女声",
                description: "Gentle and expressive / 舒缓细腻",
              },
              {
                value: "female_news",
                title: "News female 新闻女声",
                description: "Clear and brisk; default cooking voice / 字正腔圆、节奏明快，默认烹饪指导音色",
              },
            ].map((voice) => ({
              ...voice,
              onSelect: () => {
                setProfile("voice", voice.value)
                setChoosingVoice(false)
              },
            })),
            {
              title: "Custom voice ID 自定义音色 ID",
              value: "custom",
              description: "Enter a voice supported by your TTS service / 填写所用 TTS 服务支持的音色",
              onSelect: () => {
                setChoosingVoice(false)
                edit("voice", "Voice ID 音色 ID")
              },
            },
          ]}
        />
      ) : editing() ? (
        <>
          {editing()!.secret ? (
            <DialogSecret
              title={editing()!.title}
              onConfirm={editing()!.apply}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <DialogPrompt
              title={editing()!.title}
              value={editing()!.value}
              onConfirm={editing()!.apply}
              onCancel={() => setEditing(undefined)}
            />
          )}
        </>
      ) : (
        <DialogSelect
          title={modelNames[props.role]}
          locked={busy()}
          onCancel={props.onBack}
          footer={
            <text>
              {props.role === "chat" || props.role === "vision"
                ? "Use a Chat Completions compatible API base URL. / 服务地址填写 API 基础路径，使用 Chat Completions 兼容接口。"
                : "Save the base URL, model name and API key for this role. / 按用途保存服务地址、模型名称和 API Key。"}
            </text>
          }
          options={[
            {
              title: "Enabled 启用",
              value: "enabled",
              footer: profile.enabled ? "Yes 是" : "No 否",
              onSelect: () => setProfile("enabled", !profile.enabled),
            },
            {
              title: "Base URL 服务地址",
              value: "base_url",
              footer: profile.base_url || "Not configured 未配置",
              onSelect: () => edit("base_url", "Base URL 服务地址，如 https://example.com/v1"),
            },
            {
              title: "Model name 模型名称",
              value: "model",
              footer: profile.model || "Not configured 未配置",
              onSelect: () => edit("model", "Model name 模型名称"),
            },
            {
              title: "API Key 接口密钥",
              value: "key",
              footer:
                key() === null
                  ? "Clear on save 保存后清除"
                  : key() || initial.has_key
                    ? "Configured 已配置"
                    : "Not configured 未配置",
              onSelect: () =>
                setEditing({
                  title: "API Key 接口密钥",
                  value: "",
                  secret: true,
                  apply: (text) => {
                    if (text) setKey(text)
                    setEditing(undefined)
                  },
                }),
            },
            { title: "Clear API Key 清除接口密钥", value: "clear", onSelect: () => setKey(null) },
            ...(props.role === "speech"
              ? [
                  {
                    title: "Voice 播报音色",
                    value: "voice",
                    footer: profile.voice ?? "female_news",
                    onSelect: () => setChoosingVoice(true),
                  },
                  {
                    title: "Speech speed 播报语速",
                    value: "speed",
                    footer: `${profile.speed ?? 1}× 倍`,
                    onSelect: () => edit("speed", "Speed (0.25–4.0) 语速倍数（0.25 至 4）"),
                  },
                ]
              : []),
            ...(props.role === "chat" || props.role === "vision"
              ? [
                  {
                    title: "Context length 上下文长度",
                    value: "context",
                    footer: String(profile.context),
                    onSelect: () => edit("context", "Context length 上下文长度"),
                  },
                  {
                    title: "Output limit 输出上限",
                    value: "output",
                    footer: String(profile.output),
                    onSelect: () => edit("output", "Output limit 输出上限"),
                  },
                ]
              : []),
            { title: "Save 保存", value: "save", onSelect: () => void save() },
            { title: "Cancel 取消", value: "back", onSelect: props.onBack },
          ]}
        />
      )}
    </>
  )
}

function DeviceEditor(props: { id: Kitchen.DeviceID; config: Kitchen.Settings; onBack: () => void }) {
  const client = useClient()
  const toast = useToast()
  const [devices, setDevices] = createStore<Types.DeepMutable<Kitchen.Devices>>(structuredClone(props.config.devices))
  const [password, setPassword] = createSignal<string | null>()
  const [editing, setEditing] = createSignal<{
    title: string
    value: string
    secret?: boolean
    apply: (text: string) => void
  }>()
  const [busy, setBusy] = createSignal(false)
  const editNumber = (
    field: "baud_rate" | "timeout_ms" | "sample_period_ms" | "buffer_seconds" | "buffer_frames",
    title: string,
  ) => {
    const value = props.id === "camera" ? devices.camera.buffer_frames : devices[props.id][field as "baud_rate"]
    setEditing({
      title,
      value: String(value),
      apply: (text) => {
        const value = Number(text)
        if (!Number.isSafeInteger(value) || value <= 0) {
          toast.show({ variant: "error", message: "Enter a positive integer / 请输入正整数" })
          return
        }
        if (props.id === "camera") setDevices("camera", "buffer_frames", value)
        else setDevices(props.id, field as "baud_rate", value)
        setEditing(undefined)
      },
    })
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      title: "Enabled 启用",
      value: "enabled",
      footer: devices[props.id].enabled ? "Yes 是" : "No 否",
      onSelect: () => setDevices(props.id, "enabled", !devices[props.id].enabled),
    },
    ...(props.id === "camera"
      ? [
          {
            title: "RTSP URL 地址",
            value: "url",
            footer: devices.camera.rtsp_url ? "Configured (hidden) 已配置（编辑时隐藏）" : "Not configured 未配置",
            onSelect: () =>
              setEditing({
                title: "RTSP URL (hidden; passwords allowed) 地址（隐藏输入，支持密码）",
                value: devices.camera.rtsp_url,
                secret: true,
                apply: (text) => {
                  setDevices("camera", "rtsp_url", text.trim())
                  setEditing(undefined)
                },
              }),
          },
          {
            title: "Camera password 摄像头密码",
            value: "password",
            footer:
              password() === null
                ? "Clear on save 保存后清除"
                : password() || props.config.camera_has_password
                  ? "Configured 已配置"
                  : "Not configured 未配置",
            onSelect: () =>
              setEditing({
                title: "Camera password 摄像头密码",
                value: "",
                secret: true,
                apply: (text) => {
                  if (text) setPassword(text)
                  setEditing(undefined)
                },
              }),
          },
          { title: "Clear camera password 清除摄像头密码", value: "clear", onSelect: () => setPassword(null) },
          {
            title: "Frame buffer 缓存帧数",
            value: "buffer",
            footer: String(devices.camera.buffer_frames),
            onSelect: () => editNumber("buffer_frames", "Camera frame buffer 摄像头缓存帧数"),
          },
          {
            title: "FFmpeg path 路径",
            value: "ffmpeg",
            footer: devices.camera.ffmpeg_path || "Bundled decoder 使用内置解码器",
            onSelect: () =>
              setEditing({
                title: "FFmpeg executable (blank for bundled) 可执行文件路径（留空使用内置）",
                value: devices.camera.ffmpeg_path,
                apply: (text) => {
                  setDevices("camera", "ffmpeg_path", text.trim())
                  setEditing(undefined)
                },
              }),
          },
        ]
      : [
          {
            title: "Serial port 串口",
            value: "port",
            footer: devices[props.id].port || "Not configured 未配置",
            onSelect: () =>
              setEditing({
                title: "Serial port (COM4 or /dev/ttyUSB0) 串口",
                value: (devices[props.id] as Kitchen.Serial).port,
                apply: (text) => {
                  if (props.id !== "camera") setDevices(props.id, "port", text.trim())
                  setEditing(undefined)
                },
              }),
          },
          ...(
            [
              ["baud_rate", "Baud rate 波特率"],
              ["timeout_ms", "Timeout (ms) 串口超时（毫秒）"],
              [
                "sample_period_ms",
                props.id === "air"
                  ? "Upload interval (ms) 预计上传间隔（毫秒）"
                  : "Sample interval (ms) 采样间隔（毫秒）",
              ],
              ["buffer_seconds", "Memory buffer (s) 内存缓存（秒）"],
            ] as const
          ).map(([field, title]) => ({
            title,
            value: field,
            footer: String((devices[props.id] as Kitchen.Serial)[field]),
            onSelect: () => editNumber(field, title),
          })),
        ]),
    {
      title: "Save 保存",
      value: "save",
      onSelect: () => {
        if (busy()) return
        setBusy(true)
        void client.api.kitchen
          .devices({ devices: structuredClone(unwrap(devices)), camera_password: password() })
          .then(props.onBack)
          .catch(toast.error)
          .finally(() => setBusy(false))
      },
    },
    { title: "Cancel 取消", value: "back", onSelect: props.onBack },
  ])
  return (
    <>
      {editing() ? (
        <>
          {editing()!.secret ? (
            <DialogSecret
              title={editing()!.title}
              value={editing()!.value}
              onConfirm={editing()!.apply}
              onCancel={() => setEditing(undefined)}
            />
          ) : (
            <DialogPrompt
              title={editing()!.title}
              value={editing()!.value}
              onConfirm={editing()!.apply}
              onCancel={() => setEditing(undefined)}
            />
          )}
        </>
      ) : (
        <DialogSelect title={deviceNames[props.id]} options={options()} locked={busy()} onCancel={props.onBack} />
      )}
    </>
  )
}

function RecordingEditor(props: { config: Kitchen.Settings; onBack: () => void }) {
  const client = useClient()
  const toast = useToast()
  const [enabled, setEnabled] = createSignal(props.config.recording.enabled)
  const [directory, setDirectory] = createSignal(props.config.recording.directory)
  const [editing, setEditing] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  return (
    <>
      {editing() ? (
        <DialogPrompt
          title="Recording directory (absolute path) 调试记录保存目录（绝对路径）"
          value={directory()}
          onConfirm={(text) => {
            setDirectory(text.trim())
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <DialogSelect
          title="Sensor recording 传感器调试记录"
          locked={busy()}
          onCancel={props.onBack}
          footer={
            <text>
              On: save sensor data and images. Off: keep sampling in memory; existing files remain. /
              开启后保存传感数据与图像。关闭后停止记录，内存采样和判定继续，已有文件保留。
            </text>
          }
          options={[
            {
              title: "Debug mode 调试模式",
              value: "enabled",
              footer: enabled() ? "On 开启" : "Off 关闭",
              onSelect: () => setEnabled(!enabled()),
            },
            { title: "Directory 保存目录", value: "directory", footer: directory(), onSelect: () => setEditing(true) },
            {
              title: "Save 保存",
              value: "save",
              onSelect: () => {
                if (busy()) return
                setBusy(true)
                void client.api.kitchen
                  .recording({ enabled: enabled(), directory: directory() })
                  .then(props.onBack)
                  .catch(toast.error)
                  .finally(() => setBusy(false))
              },
            },
            { title: "Cancel 取消", value: "back", onSelect: props.onBack },
          ]}
        />
      )}
    </>
  )
}
