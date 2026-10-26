<p align="center">
  <a href="https://github.com/hwhuang0308-sys/OpenCook">
    <picture>
      <source srcset="docs/assets/wordmark-dark.svg" media="(prefers-color-scheme: dark)">
      <img src="docs/assets/wordmark-light.svg" alt="OpenCook" width="560">
    </picture>
  </a>
</p>
<p align="center">The open source cooking agent for your terminal.</p>
<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-292524?style=flat-square"></a>
  <a href="https://github.com/hwhuang0308-sys/OpenCook/actions/workflows/check.yml"><img alt="Checks" src="https://img.shields.io/github/actions/workflow/status/hwhuang0308-sys/OpenCook/check.yml?branch=main&style=flat-square&label=checks"></a>
  <a href="https://bun.sh"><img alt="Bun 1.4.2" src="https://img.shields.io/badge/bun-1.4.2-f9a875?style=flat-square"></a>
</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh.md">简体中文</a></p>

---

OpenCook brings cooking conversations, recipe planning, and step-by-step guidance into one terminal. Ask a question, plan a family dinner, write a teaching document, or cook a dish with live guidance.

### Getting started

Install [Bun 1.4.2](https://bun.sh), then run from source:

```sh
git clone https://github.com/hwhuang0308-sys/OpenCook.git
cd OpenCook
bun install --frozen-lockfile
bun run dev --standalone
```

Open `/settings`, or press `Ctrl+P` and choose **Settings 设置 → Model services 模型服务**. Enter your own service URL, model name, and API key. The chat model must support OpenAI-compatible Chat Completions and tool calling.

> [!TIP]
> Text chat needs only the chat model. Vision, TTS, and devices are optional. Serial sensors require Node.js 22+; cameras require system FFmpeg or its executable path in settings.

### Cook

Cook is the main agent. It combines the conversation with your ingredients, equipment, preferences, and changes of plan, asking for clarification when missing information affects the result.

- **Cooking conversations** — techniques, substitutions, menus, banquet plans, and teaching materials.
- **Recipes on demand** — suggest dish names, find a reference recipe, and adapt it when your requirements call for a change.
- **Traceable sources** — search imported cooking passages or the web, and keep track of recipe sources.
- **Personal cooking memory** — save feedback and lasting preferences locally for future recipes. Inspect, correct, or forget memories at any time.
- **Guided cooking** — after your confirmation, open a dedicated interface with large instructions, timing, progress, and sensor status.
- **Voice and devices** — optional TTS, RTSP camera, temperature, sound-level, and air-quality inputs. Sensor recording is off by default.

Try asking:

```text
I have tomatoes and eggs. Suggest something quick for dinner.
Plan a six-person family dinner with a shopping list.
Make this recipe less salty, keeping the original technique.
Start the cooking guide, then remember my feedback for next time.
```

### Guided cooking

Once you approve a recipe and agree to start, Cook prepares a program plan and an action plan. A deterministic execution service manages steps, timing, sensor conditions, pauses, and emergency interruptions.

Press `Enter` to confirm a step, `P` to pause or resume, and `Esc` to pause and return to chat. Use `/cooking`, the sidebar button, or a natural request to return to the same guide. Finishing the guide sends its result back to the conversation, where you can leave feedback for future meals.

Without connected devices, the guide uses manual confirmation and recommended timing. Sensor and visual alerts assist the cook; validate their behavior with your actual hardware and kitchen setup.

### Configuration

Chat, vision, TTS, embeddings, and reranking have separate settings. Keys are written to a private `opencook.json` or `opencook.jsonc`; an empty [configuration example](opencook.example.json) is included. No personal API keys are distributed.

Current knowledge retrieval uses local lexical matching over imported passages with source metadata. Book content is not bundled. Embedding and reranking settings are available; their retrieval pipeline and PDF import are planned features.

### Documentation

- [Configuration, devices, memory, and knowledge import](docs/operations.md)
- [Cooking architecture and recipe workflow](docs/cooking-architecture.md)
- [Conversation evaluation guide](docs/testing-cooking-agent.md)

The detailed guides are currently in Chinese.

### Development

```sh
# Lint and type checks, from the repository root
bun run check

# Focused domain tests, from the core package
cd packages/core
bun run test test/cooking.test.ts test/plugin/cook.test.ts test/plugin/model-runtime.test.ts
```

Contributions are welcome through [issues](https://github.com/hwhuang0308-sys/OpenCook/issues) and pull requests. Keep personal configuration, conversation data, sensor captures, and local evaluation outputs out of commits.

### License and acknowledgements

OpenCook is built on [OpenCode](https://github.com/anomalyco/opencode) and adapted for cooking. It is an independent project and is not affiliated with the original project team.

Released under the [MIT License](LICENSE). Original copyright notices and third-party attribution are retained in [LICENSE](LICENSE) and [NOTICE](NOTICE).
