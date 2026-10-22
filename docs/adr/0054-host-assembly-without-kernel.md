# ADR-0054：删掉插件内核中间层，宿主只剩装配

- 状态：已采纳
- 日期：2026-10-22
- 相关：[ADR-0039](0039-agent-core-boundaries.md)（进程级的缝为什么暂不改注入）、[ADR-0030](0030-plugin-market-keys-and-live-updates.md)
  （`capability.js` 的来历）；core `kernel/host.ts`、`skills/registry.ts`、`sandbox/types.ts`、`search/defaults.ts`、
  `runtime/setup/session-setup.ts`（`loadCapabilities`、`sessionRegistry`）、`runtime/agent-session/session.ts`（`AgentSessionOptions.extraTools`）；
  `.dependency-cruiser.cjs`（`core-does-not-reach-the-host-assembly`）

## 背景

`packages/core/src/kernel/` 原来是三层：宿主层 `host.ts` 读用户插件里的 `capability.js`，用十个默认插件加上它们
建一个 `Context`，再把每个服务用 `useLlmRegistry`、`useToolRegistry`、`useSandbox` 等九个函数抄写到各模块的
模块级变量上；中间层是 `Context`（服务表加撤销日志）、`EventBus`（含 waterfall）、十个默认插件和 `services.ts`
里的 key 与接口；下层是各模块的缝，读到 null 时回退到模块自带的默认实现。

逐个核对下来：

- **默认实现重复。** 每个默认插件登记的，和模块在缝未绑定时用的是同一个东西：沙箱两处都是 `new LocalSandbox()`；
  模型适配器是同样三个；循环都是 `runAgent`；压缩、审批、调度都是内置策略；工具的 `builtinToolGroups()` 和
  `staticTools()` 是同一份分组。宿主绑上去的东西，和不绑时一模一样。
- **零监听的管道。** `tools/call`（每次工具调用过一遍 waterfall）和 `agent/prepare`（每轮过一遍 turn 中间件）
  两条事件管道全仓库没有一个监听者，`TurnPipeline.use` 从未被调用。
- **依赖倒置。** 接口放在 `kernel/services.ts`，于是 `sandbox/`、`runtime/approval-policy.ts`、`runtime/scheduling.ts`、
  `runtime/compaction/`、`skills/registry.ts`、`tools/bash.ts` 这些底层模块反过来 import 内核拿类型。
- **`capability.js` 没有用处。** 它本该让插件替换任意一条缝，但在真实启动顺序下替换不了任何单实现的缝：默认插件
  先 `provide` 了 key，能力插件再 `provide` 同一个 key 抛错，宿主接住后把全部能力插件丢掉重来。市场里也没有一个
  插件带它。
- 宿主对外真正用到的只有两样：`kernel.storage`（一个 `new SessionStore()`）和 `kernel.skills`（桌面端注册浏览器
  skill）。

## 决定

**插件化这次不做，先把分层拆清。**

1. **删掉中间层。** `context.ts`、`events.ts`、`kernel/plugins/*`、`kernel/index.ts`、`services.ts` 全部删除。
   工具调用在 `agent/tool-run.ts` 里直接 `tool.execute`，不再经 `runTool`/`useToolPipeline`；一轮的组装不再经
   `prepareTurn`/`useTurnPipeline`（没有中间件时它是恒等，`reconcilePrompt` 在这条路径上也随之恒等）。
2. **接口回到实现它的模块。** `Sandbox`/`SandboxProcess` → `sandbox/types.ts`；`ApprovalPolicy`/`ApprovalVerdict`
   → `runtime/policy/approval-policy.ts`；`CompactionRequest`/`CompactionStrategy` → `runtime/compaction/compaction.ts`；
   `TaskScheduler` → `runtime/queue/scheduling.ts`；`SkillRegistry` 连同实现（同名后注册者胜）→ `skills/registry.ts`。
   `LlmRegistry`、`ToolRegistry` 收窄成缝真正读的那一个方法（`get`、`all`），放在 `ai/index.ts`、`tools/index.ts`
   ——原来的 `register`/`list`/`byName` 只有被删的内核注册表实现过。
3. **其余 `useX` 缝保留，默认值不变。** 它们是测试和脚本真在用的替换点（`market-verify-probe.ts` 用
   `useToolRegistry` 收窄工具表，沙箱、压缩、审批、调度、循环各有测试换桩）。仍是进程级，理由见 ADR-0039。
4. **宿主收成薄装配。** `bootHostKernel()` 只建 `SessionStore`、建并绑定 skill 注册表，`dispose()` 时解绑；
   仍是进程单例。改成同步，不再接收设置。`registerDefaultSearchProviders` 挪到 `search/defaults.ts`。
5. **`kernel/` 留着，只剩 `host.ts`。** 不改名：`bootHostKernel` 是桌面端和命令行在用的公开名，目录名只在根入口
   和文档里出现，改名换不来什么。由 arch 规则 `core-does-not-reach-the-host-assembly` 守住：core 里除根入口外
   任何模块不得 import `kernel/`，类型也算。

运行时行为不变：宿主之前绑上去的每一样，都等于未绑定时的默认值。

## 工具、skill、MCP 现在怎么进会话

| 来源 | 路径 | 范围 |
| --- | --- | --- |
| 内置工具 | `builtinTools()`，未绑定时就是 `tools/groups.ts` 的分组；`useToolRegistry` 可整表替换 | 进程级 |
| 宿主的工具（桌面端的浏览器、会话间通信、会话操作） | `AgentSessionOptions.extraTools` → `SessionCapabilities` → `loadCapabilities` | 按会话 |
| MCP 工具 | `McpManager` 按 `settings.mcpServers` 向 `AgentSessionOptions.mcpPool` 借连接，见 `mcp/pool.ts`；不给池子（命令行）就自己连一份 | 宿主级共用；标了 `perSession` 的按会话 |
| 宿主的 skill（桌面端的浏览器 skill） | `kernel.skills.register` → `registeredSkills()` → 每个会话的插件 provider | 进程级 |

- 工具表是 `[...builtinTools(), ...extraTools]`：**不去重，同名也不替换**。原来内核工具注册表「后注册的同名工具
  顶掉先注册的」那条规则随内核一起没了；它本来也只在内核注册表内部生效，从没管过 `extraTools`。
- skill 和工具的注入不对称：宿主工具按会话给，宿主 skill 是进程级注册。目前只有桌面端一个调用、所有会话都要它，
  没有造成问题；哪天需要按会话区分，改成 `AgentSessionOptions.extraSkills`，和 `extraTools` 走同一条路。

## 以后做插件化

从按会话注入接：工具走 `extraTools`，循环要的东西走 `AgentRunConfig`（ADR-0034 的四组配置），skill 先补
`extraSkills`。**不要恢复全局 `Context`**——它在进程里只有一份，两个会话想要不同插件配置时正好帮不上，而那正是
插件化要解决的事；它带来的事件总线也已经证明没人用。

## 验证

`pnpm audit:sessions` 在本机真实会话上改前改后输出逐字节相同；core 全量测试通过（变基到 aba1d943 后 2661 条，0 失败）；
`pnpm arch` 循环依赖基线不变（21 条循环，连同两处破例共 23 条），并用一个临时的 `import type` 确认新规则会报错；`pnpm knip` 没有与本次改动相关的报告；
桌面端 `electron-vite build` 成功。
