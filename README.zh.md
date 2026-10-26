<p align="center">
  <a href="https://github.com/hwhuang0308-sys/OpenCook">
    <picture>
      <source srcset="docs/assets/wordmark-dark.svg" media="(prefers-color-scheme: dark)">
      <img src="docs/assets/wordmark-light.svg" alt="OpenCook" width="560">
    </picture>
  </a>
</p>
<p align="center">开源的终端烹饪智能体。</p>
<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-292524?style=flat-square"></a>
  <a href="https://github.com/hwhuang0308-sys/OpenCook/actions/workflows/check.yml"><img alt="Checks" src="https://img.shields.io/github/actions/workflow/status/hwhuang0308-sys/OpenCook/check.yml?branch=main&style=flat-square&label=checks"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.2" src="https://img.shields.io/badge/bun-1.4.2-f9a875?style=flat-square"></a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></p>

---

OpenCook 把烹饪对话、菜谱规划和全程做菜指导放进同一个终端。你可以问一个烹饪问题、安排一顿家宴、编写教学文档，也可以打开独立引导界面，跟着步骤完成一道菜。

### 开始使用

安装 [Bun 1.4.2](https://bun.sh)，然后从源码启动：

```sh
git clone https://github.com/hwhuang0308-sys/OpenCook.git
cd OpenCook
bun install --frozen-lockfile
bun run dev --standalone
```

输入 `/settings`，或按 `Ctrl+P` 进入 **Settings 设置 → Model services 模型服务**，填写自己的服务地址、模型名称和 API Key。对话模型需要兼容 OpenAI Chat Completions 接口，并支持工具调用。

> [!TIP]
> 文字对话只需要配置对话模型。视觉、TTS 和厨房设备均为可选功能。串口传感器需要 Node.js 22 或更新版本；摄像头需要系统安装 FFmpeg，或在设置中指定其可执行文件路径。

### Cook

Cook 是主智能体。它结合对话理解你的目标、食材、设备、偏好及最新修改，在缺少的信息会影响结果时进行澄清。

- **烹饪对话**：解释技法、食材替代，制定菜单、宴席方案和教学材料。
- **按需生成菜谱**：推荐菜名、取得参考配方，存在特别要求时再进行个性化调整。
- **可追溯的来源**：按意图检索已导入的烹饪资料或联网搜索，保存菜谱来源。
- **个人烹饪记忆**：在本机保存评价和长期偏好，在之后制定菜谱时参考；支持查看、修正和遗忘。
- **全程烹饪指导**：经你确认后，打开独立界面，用大字显示操作、计时、进度与设备状态。
- **语音和设备**：可选 TTS 播报、RTSP 摄像头、温度、声音强度与空气质量输入；传感器调试记录默认关闭。

你可以这样说：

```text
我有西红柿和鸡蛋，推荐一道快手家常菜。
今晚六个人吃饭，帮我安排一份菜单和采购清单。
保留这道菜原来的做法，但口味清淡一点。
开始全程做菜指导，做完以后帮我记住需要调整的地方。
```

### 全程烹饪指导

菜谱确认并获得你的启动同意后，Cook 将菜谱转换为程序谱和动作谱，由确定性执行服务管理步骤、计时、传感器判定、暂停和异常中断。

`Enter` 确认当前步骤，`P` 暂停或继续，`Esc` 暂停并返回聊天。输入 `/cooking`、点击侧边栏入口，或直接告诉 Cook 想接着做，都可以回到原来的引导。结束后，执行结果会回到对话，你可以评价口味和操作体验，供下次做菜参考。

没有连接设备时，系统使用手动确认和推荐时长。传感器与视觉提醒用于辅助做菜，实际效果仍需结合自己的硬件和厨房环境验证。

### 配置

分别配置对话、视觉、TTS、Embedding 和 Rerank 模型。设置及密钥写入私有的 `opencook.json` 或 `opencook.jsonc`，仓库提供空白的[配置示例](opencook.example.json)，不分发个人 API Key。

当前知识库使用带出处信息的本地词法检索，需自行导入语料，未内置书籍内容。Embedding 和 Rerank 已提供设置入口，对应的向量检索、重排流水线及 PDF 导入后续提供。

### 文档

- [运行配置、设备、个人记忆与知识导入](docs/operations.md)
- [烹饪架构与菜谱工作流](docs/cooking-architecture.md)
- [对话回归评测指南](docs/testing-cooking-agent.md)

### 开发与贡献

```sh
# 在仓库根目录运行代码风格和类型检查
bun run check

# 在 core 包内运行烹饪领域测试
cd packages/core
bun run test test/cooking.test.ts test/plugin/cook.test.ts test/plugin/model-runtime.test.ts
```

欢迎通过 [Issue](https://github.com/hwhuang0308-sys/OpenCook/issues) 和 Pull Request 参与。请勿提交个人配置、聊天数据、传感器采集文件和本地评测结果。

### 许可与致谢

OpenCook 基于 [OpenCode](https://github.com/anomalyco/opencode) 开发，是面向烹饪场景的独立项目，与原项目团队无隶属关系。

项目采用 [MIT 许可](LICENSE)，原始版权及第三方归属声明保留在 [LICENSE](LICENSE) 和 [NOTICE](NOTICE) 中。
