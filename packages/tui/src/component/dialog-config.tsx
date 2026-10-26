import { createMemo, createSignal } from "solid-js"
import { useConfig, useNewDesigns } from "../config"
import { useThemes } from "../context/theme"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { useDialog } from "../ui/dialog"
import { DialogKitchen } from "./dialog-kitchen"
import { DialogIntegration } from "./dialog-integration"

type Setting = {
  title: string
  category: string
  path: string[]
  default: unknown
  values?: readonly unknown[]
  labels?: readonly string[]
  step?: number
  min?: number
  max?: number
  format?: (value: unknown) => string
  keywords?: readonly string[]
}

export const settings: Setting[] = [
  {
    title: "Theme 主题",
    category: "Appearance 外观",
    path: ["theme", "name"],
    default: "opencook",
    keywords: ["color scheme", "colors"],
  },
  {
    title: "Color mode 配色模式",
    category: "Appearance 外观",
    path: ["theme", "mode"],
    default: "system",
    values: ["system", "dark", "light"],
    labels: ["system 跟随系统", "dark 深色", "light 浅色"],
    keywords: ["dark mode", "light mode", "system theme"],
  },
  {
    title: "Animations 动画",
    category: "Appearance 外观",
    path: ["animations"],
    default: true,
    values: [false, true],
    labels: ["off 关闭", "on 开启"],
    keywords: ["animation", "motion", "steam", "蒸汽"],
  },
  {
    title: "Thinking 思考过程",
    category: "Session 会话",
    path: ["session", "thinking"],
    default: "hide",
    values: ["hide", "show"],
    labels: ["hide 隐藏", "show 显示"],
    keywords: ["reasoning", "chain of thought"],
  },
  {
    title: "Markdown 文本显示",
    category: "Session 会话",
    path: ["session", "markdown"],
    default: "rendered",
    values: ["source", "rendered"],
    labels: ["source 源文本", "rendered 渲染"],
    keywords: ["syntax", "concealment", "rendering"],
  },
  {
    title: "Verbosity 详细程度",
    category: "Session 会话",
    path: ["session", "verbosity"],
    default: "medium",
    values: ["low", "medium", "high"],
    labels: ["low 简洁", "medium 适中", "high 详细"],
    keywords: ["detail", "activity", "summary", "transcript"],
  },
  {
    title: "Scroll speed 滚动速度",
    category: "Input 输入",
    path: ["scroll", "speed"],
    default: 3,
    step: 0.25,
    min: 0.25,
    max: 10,
    format: (value) => Number(value).toFixed(2),
    keywords: ["scrolling"],
  },
  {
    title: "Mouse 鼠标",
    category: "Input 输入",
    path: ["mouse"],
    default: true,
    values: [false, true],
    labels: ["off 关闭", "on 开启"],
    keywords: ["mouse capture"],
  },
  {
    title: "Large pastes 长文本粘贴",
    category: "Input 输入",
    path: ["prompt", "paste"],
    default: "compact",
    values: ["compact", "full"],
    labels: ["compact 折叠", "full 完整显示"],
    keywords: ["paste summary", "clipboard", "pasted content"],
  },
  {
    title: "Notifications 桌面通知",
    category: "Alerts 提醒",
    path: ["attention", "notifications"],
    default: false,
    values: [false, true],
    labels: ["off 关闭", "on 开启"],
    keywords: ["system notifications", "desktop notifications", "alerts"],
  },
  {
    title: "Sounds 提示音",
    category: "Alerts 提醒",
    path: ["attention", "sound"],
    default: false,
    values: [false, true],
    labels: ["off 关闭", "on 开启"],
    keywords: ["audio", "sound effects", "alerts"],
  },
  {
    title: "Volume 提示音音量",
    category: "Alerts 提醒",
    path: ["attention", "volume"],
    default: 0.4,
    step: 0.1,
    min: 0,
    max: 1,
    format: (value) => `${Math.round(Number(value) * 100)}%`,
    keywords: ["sound volume", "audio volume"],
  },
  {
    title: "Window title 窗口标题",
    category: "Terminal 终端",
    path: ["terminal", "title"],
    default: true,
    values: [false, true],
    labels: ["off 关闭", "on 开启"],
    keywords: ["terminal title", "tab title"],
  },
]

export function settingID(setting: Setting) {
  return setting.path.join(".")
}

export function DialogConfig(props: { current?: string }) {
  const config = useConfig()
  const newDesigns = useNewDesigns()
  const toast = useToast()
  const themes = useThemes()
  const dialog = useDialog()
  const current = Math.max(
    0,
    settings.findIndex((setting) => settingID(setting) === props.current),
  )
  const [selected, setSelected] = createSignal(current)
  const [saving, setSaving] = createSignal(false)

  const value = (setting: Setting) => {
    const current = setting.path.reduce<unknown>((result, key) => {
      if (!result || typeof result !== "object") return undefined
      return (result as Record<string, unknown>)[key]
    }, config.data)
    if (setting.path.join(".") === "theme.name") return current ?? themes.selected
    return current ?? setting.default
  }
  const values = (setting: Setting) =>
    setting.path.join(".") === "theme.name"
      ? Object.keys(themes.all()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
      : setting.values
  const display = (setting: Setting) => {
    const current = value(setting)
    if (setting.format) return setting.format(current)
    const index = setting.values?.indexOf(current)
    return index === undefined || index < 0 ? String(current) : (setting.labels?.[index] ?? String(current))
  }
  const options = createMemo(() => [
    {
      title: "Model services 模型服务",
      category: "OpenCook",
      searchText: "model api key 文本 视觉 语音 embedding rerank",
      footer: "Configure 配置",
      value: -1,
    },
    {
      title: "Camera & sensors 摄像头与传感器",
      category: "OpenCook",
      searchText: "camera rtsp serial sensor 设备 连接",
      footer: "Status 连接状态",
      value: -2,
    },
    {
      title: "Sensor debug 传感器调试模式",
      category: "OpenCook",
      searchText: "debug recording 调试 保存 记录",
      footer: "Configure 配置",
      value: -3,
    },
    {
      title: "Web services 联网搜索与网页服务",
      category: "OpenCook",
      searchText: "web search exa tavily firecrawl parallel tinyfish 联网 搜索 网页",
      footer: "Connect 按需连接",
      value: -4,
    },
    ...settings.map((setting, index) => ({
      title: setting.title,
      category: setting.category,
      searchText: setting.keywords?.join(" "),
      footer: display(setting),
      value: index,
    })),
  ])

  async function change(direction: number, index = selected()) {
    if (saving()) return
    if (index < 0) {
      if (index === -4) {
        dialog.replace(() => <DialogIntegration />)
        return
      }
      dialog.replace(() => <DialogKitchen section={index === -1 ? "models" : index === -2 ? "devices" : "recording"} />)
      return
    }
    const setting = settings[index]
    const current = value(setting)
    const choices = values(setting)
    const next = choices
      ? choices[(choices.indexOf(current) + direction + choices.length) % choices.length]
      : Math.min(setting.max!, Math.max(setting.min!, Number(current) + direction * setting.step!))
    if (next === current) return
    setSaving(true)
    await config
      .update((draft) => {
        const parent = setting.path.slice(0, -1).reduce<Record<string, unknown>>((result, key) => {
          if (!result[key] || typeof result[key] !== "object") result[key] = {}
          return result[key] as Record<string, unknown>
        }, draft)
        parent[setting.path.at(-1)!] = next
      })
      .catch(toast.error)
      .finally(() => setSaving(false))
  }

  return (
    <DialogSelect
      title="Settings 设置"
      searchInTitle
      titlePlaceholder="Search settings 搜索设置"
      options={options()}
      current={current}
      filterThreshold={0.7}
      onMove={(option) => setSelected(option.value)}
      onSelect={(option) => void change(1, option.value)}
      footerHints={newDesigns() ? [] : [{ title: "change 修改", label: "←/→" }]}
      bindings={[
        {
          bind: "left",
          title: "Previous value 上一个值",
          group: "Settings 设置",
          run: () => void change(-1),
        },
        {
          bind: "right",
          title: "Next value 下一个值",
          group: "Settings 设置",
          run: () => void change(1),
        },
      ]}
    />
  )
}
