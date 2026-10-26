# Cook 对话回归评测

离线回归测试覆盖已确认条件的来源、库存数量、局部更新、菜谱校验与内部修复、重复请求、旧任务规则失效、编译和确定性执行。按仓库规则从 `packages/core` 运行：

```sh
bun run test test/cooking-requirements.test.ts test/cooking.test.ts test/cooking-memory.test.ts test/cooking-execution.test.ts test/plugin/cook.test.ts test/plugin/tool-input-repair.test.ts test/tool-schema.test.ts
```

真实模型评测通过生产 `SessionRunner`、持久化消息、实际工具注册与执行服务运行，不另写测试专用对话循环。每个场景使用隔离的内存数据库与临时目录，禁用物理设备和语音播放，不修改个人聊天或长期记忆。书库和网页使用明确标记的合成资料；HTTP拒绝等失败通过外部边界夹具注入。这项评测验证模型与程序的协作，不能替代实体设备及真实站点连通性测试。

配置测试服务后从 `packages/core` 运行；密钥从环境读取，不写入测试轨迹：

```sh
export OPENCOOK_EVAL_BASE_URL='服务地址'
export OPENCOOK_EVAL_MODEL='模型名称'
read -rs OPENCOOK_EVAL_API_KEY
export OPENCOOK_EVAL_API_KEY
bun script/cooking-eval.ts --output /tmp/opencook-eval
```

可使用 `--only identity-replan,successive-corrections` 选择场景。场景清单位于 `script/cooking-eval/cases.ts`，共21个，覆盖身份介绍后推荐、只要菜名、再次要求不同建议、口语化数量与地域情绪、先预览完整菜谱再启动、标准配方、连续更改口味、老抽替代、换菜、旧任务恢复、严格库存、暂停恢复、停止重开、知识问答、明确联网、禁止联网的草稿、来源不可用、必要澄清和完成后的反馈记忆。

重规划专项场景为 `replan-existing-reference` 和 `replan-replace-reference`：前者在去糖少油、插入原理追问、改四人份后核对任务ID、参考配方、版本和检索行为；后者提供内容确实不同的网页样例，核对明确换来源时替换了参考，且没有误启动引导。`changed-dish` 同时检查换菜后原参考不再被用作新菜。完整菜谱展示检查接受等义的食材、调料、步骤标题；结构化工具仍由代码生成固定三段格式。

每个场景输出完整的实际用户/助手消息、工具参数与结果、辅助生成、最终执行状态、断言以及独立对话检查结果。`summary.json` 汇总结果；任何断言失败使进程返回非零状态。检查既包含实际引导是否启动、运行ID与进度是否保留、配方是否遵守最新要求，也包含来源不足时是否保持未就绪。独立文本检查要求引用真实助手原文，用于发现普通烹饪追问、虚构用户事实、未保存的配方改动和聊天中的并行引导；其发现仍应结合原轨迹人工复核，不能把模型评分当成全部正确性的证明。

评测结果是当前代码、模型与这些场景下的证据，不代表所有输入均无错误。修改提示词、模型路由、条件整理或工具契约后应重新运行相关场景及仓库根目录的 `bun run check`。测试轨迹属于本地开发产物，不应提交到仓库。
