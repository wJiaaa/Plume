# 架构

一页地图。每一节都指向真正的东西——目录、文件、或者一条记录了当初为什么这么定的 ADR。

## 一句话

Plume 是一个 agent 运行时加桌面端与原生手机端。`packages/core` 平台无关，桌面端（Electron）驱动它的
`AgentSession`；手机直连桌面，使用同一份会话和运行时。

## 包

| 包 | 是什么 | 依赖谁 |
| --- | --- | --- |
| `core` | agent 内核：provider 适配、agent loop、工具、skill、MCP、会话存储 | 只依赖 `registry-shared` |
| `cli` | 非交互命令行：用桌面端的设置跑完一个任务，给评测用，见 [ADR-0031](docs/adr/0031-headless-cli-for-evaluation.md) | `core` |
| `desktop` | Electron 应用。`electron/` 主进程，`src/` 渲染进程，`shared/` 两边共有 | `core`、`contract` |
| `contract` | 渲染进程与主进程之间的 IPC 契约：方法表（`methods.ts`）、每个方法的参数与返回值（`api.ts` 拼起各主题的文件）、跨边界的载荷类型 | 只从 `core` 的两个类型入口拿类型，见边界第 5 条 |
| `client-runtime` | 无 UI 的远程连接、状态与消息合并；桌面复用消息合并 | `contract` 的手机入口（`@plume/contract/mobile`）、core 类型 |
| `mobile` | 独立 React Native / Expo 手机界面 | `client-runtime` |
| `registry-shared` | 插件市场的契约：索引能说什么、API 答什么 | 谁也不依赖 |

界面语言的来源、进程边界与不翻译的内容见 [界面国际化](docs/architecture/i18n.md)。
缓存、骨架屏与空结果在视图切换时的约定见 [视图切换与加载](docs/architecture/view-loading.md)。
桌面端的颜色、字阶、尺寸、深度、动效与基础组件见 [设计体系](docs/architecture/design-system.md)。
模型请求的来源分段、固定预算和用量统计见 [上下文组装与统计](docs/architecture/context-assembly.md)。
会话之间互相发现、发消息、等对方做完见 [会话之间的消息](docs/architecture/session-messaging.md)。
MCP 的提示词、填表（elicitation）与 OAuth 登录见 [MCP 客户端](docs/architecture/mcp-client.md)。
MCP 工具多了以后不进工具表、按需搜索，内置工具为什么一律常驻，见 [工具延迟加载](docs/architecture/mcp-search.md)。
原移动端与中转曾移除，见 [ADR-0026](docs/adr/0026-remove-mobile-and-relay.md)；新的原生手机端复用逻辑、独立 UI，见 [ADR-0041](docs/adr/0041-native-mobile-shared-runtime.md)。桌面 Web 访问仍已移除，见 [ADR-0027](docs/adr/0027-web-access.md)。

## 渲染进程的 9 个目录

```
src/
├── main.tsx      入口
├── app/          窗口怎么装起来：布局、快捷键、启动屏、窗口按钮、对话独立窗
├── features/     26 个用户看得见的域，各自一个目录
├── ui/           谁都能用的组件——换个产品也成立
├── lib/          纯逻辑：没有 React，没有主进程，不需要 DOM 就能测
├── services/     跟主进程说话的唯一出口
├── store/        跨域共享的状态；只有一个域用的留在那个域里
├── styles/       样式，一个主题一个文件
└── assets/
```

新文件该放哪，按依赖判断而不是按名字：

| 它 | 就放 |
| --- | --- |
| 不引 React，不碰主进程 | `lib/` |
| 是组件，但不读 store、不调 service | `ui/` |
| 知道「会话」「分支」「插件」是什么 | `features/<域>/` |
| 只有一个域读写的状态 | `features/<域>/store.ts` |
| 两个以上域读写的状态 | `store/` |

**「读写」两个字都算，数的时候别只数读。** 2026-09-12 的审计按「有几个文件读它」判断，点名
`store/index.ts` 里七个字段「只有一个 feature 文件读，违反这条规则」——逐个查下来七个全是跨域的，
而且是最典型的那种：`composerDraft` 一个域读、**七个域写**（子智能体面板、吐司、插件、PR、Git、
空状态都往主输入框塞过文字），`settingsSection` 九处写。一个域读、多个域写，正是这张表存在的理由，
不是违反它。

前两条由 `pnpm arch` 与 oxlint 强制。

## 主进程的域

`electron/` 也按域分目录。域按依赖和职责划，不按文件名前缀：`session-peers.ts` 在 `peer/`，
`diff-parse.ts` 只有 forge 用，就在 `forge/`。

```
electron/
├── main.ts preload.ts window.ts sandbox-runner.ts   入口与装配
├── i18n.ts app-settings.ts path-key.ts find-executable.ts   谁都能用的
├── ipc/           每个域一份 IPC 注册，和 main.ts 一样是装配层
├── app/           应用外壳：菜单、托盘、深链、常亮、系统通知、窗口安全与状态、随包资源在哪
├── browser/       内置浏览器：工作区、给模型的工具、对话框、本地页面
├── capabilities/  命令目录、MCP 探测、定义文件删除、skill 列出的可读文件
├── files/         文件面板：路径边界、读、定位、消息附件的读取放行、表格类文档
├── forge/         代码托管平台：账号、PR、评审、Release 用的请求
├── git/           Git 与会话工作树
├── images/        网络图片：头像与磁盘缓存
├── mobile/        手机直连：服务、中转、RPC
├── models/        模型服务商的连通测试
├── open-targets/  「在…中打开」：编辑器、终端与它们的图标
├── peer/          会话之间互相发消息
├── plugins/       插件市场：索引、说明、更新、图标
├── preview/       `ly-media`/`ly-preview` 协议、缩略图、分段读取、生成页自检
├── screenshot/    截图、钉图、快捷键与 macOS 取屏小程序
├── session/       会话：活着的会话表、建会话、转录、交付、摘要、定时任务、会话里跑着的服务
├── terminal/      终端：pty、环境、前台进程
├── update/        应用内更新：校验、安装
└── usage/         用量页：扫描、价格、缓存
```

域与域之间只经对方的 `index.ts`，index 只列别的域真在用的（「边界」第 12 条）。`ipc/`、`main.ts`、
`window.ts` 是装配层，直接引各域的文件，和渲染进程的壳一样。新文件放哪：只有一个域用，放那个域；
几个域都用、又不属于其中哪一个，放根目录。

## core 的 runtime

`packages/core/src/runtime/` 是驱动 agent 循环的那一层。它按职责分组，组与组之间从上往下引，
由 `.dependency-cruiser.cjs` 里的 `runtime-layer-*` 规则守（类型也算）：

| 层 | 目录 | 是什么 |
| --- | --- | --- |
| 会话驱动 | `agent-session/` | `AgentSession`（`session.ts`）和从它身上拆出来的部件：回合怎么开（`session-turn.ts`、`turn-config.ts`）、谁占着历史、后台结果送回、插话、撤回、换模型、手动与空闲压缩 |
| 被驱动的运行 | `sub-agent/`、`side-chat/` | 子代理与侧边聊天。借会话的记录和能力，不认识会话本身 |
| 记录 | `record/` | 会话记下了什么（`SessionLog`），以及从记录里读出来的东西：只读的会话事实、状态与上下文分布、缓存诊断 |
| 装配 | `setup/` | 会话装上了什么：工具、技能、插件、MCP、子智能体定义，变化时重装，以及据此拼的提示词上下文 |
| 叶子 | `policy/`、`plan/`、`compaction/`、`memory/`、`queue/`、`summary/` | 每种运行共用的规矩（审批、钩子、工具策略与环境、续跑、委派上限）、计划模式、压缩、记忆与沉淀的技能、任务队列、标题与摘要（连同三处共用的一次性旁路请求读取 `one-shot.ts`） |

同层之间随意引，叶子之间也一样（压缩读计划快照）。新文件放进它真正依赖的那一层；哪一层都放
不下、放哪儿都要往上引，说明它的边界不对，先拆它而不是给规则开口子。顶层的 `src/session/` 是
会话**存储**，和这里的 `agent-session/` 不是一回事。

## 边界

由 `.dependency-cruiser.cjs` 与 `.oxlintrc.json` 执行，`pnpm arch` 与 `pnpm lint` 检查，
pre-push 里都是必过项：

1. **`core` 不 import 桌面端。** 它是平台无关的运行时，一旦引了桌面端就不再是。
2. **渲染进程从 `core` 只能 `import type`**，白名单子入口除外。从根入口导入*值*会把整个
   index 拉进浏览器包，而它一路连到 `node:fs`——窗口一片空白。类型编译期就擦掉了，免费。
3. **渲染进程不从 `electron/` 导入值。** 值就是把另一个进程的模块链进了这个包。边界的描述
   在 `@plume/contract`，跨边界的类型也从那里拿，渲染进程没有理由点名 `electron/` 里的文件。
4. **`shared/` 不依赖任何一个进程。** 它是两个进程共有的判断（比如「这个文件该用哪种查看器」），
   偏向任何一端就有一端用不了它。它判断的对象若是跨边界的载荷（浏览器标签、文件面板状态），
   类型从 `@plume/contract` 拿——契约在两个进程之下，不偏向任何一端。
5. **`@plume/contract` 只有类型依赖。** 它有两个消费者——主进程按它注册、preload 按它生成——
   手机端也读它的类型；它引了谁的值，就把谁拖进每一个构建里。所以它只许 `import type`，
   来源只限 `@plume/core` 的两个类型入口：`contract-types`（跨 IPC 的 core 类型）与
   `client-types`（手机共用的那部分）。手机只经 `@plume/contract/mobile` 进来，那条路只碰
   `client-types`。见 [ADR-0055](docs/adr/0055-contract-owns-ipc-types.md)。
6. **`ui/` 与 `lib/` 是叶子。** 见上一节。
7. **`window.plume` 只在 `services/bridge.ts`。** 由 oxlint 守；`host.ts` 读平台，是唯一的例外。
8. **`store`/`ui`/`lib`/`services` 不伸进某个功能域里点名文件。** 第 6 条的另一半：
   那一条只管域与域之间，从下面伸上去它看不见。壳（`app/`、`main.tsx`）不在此列——
   它们 `lazy()` 各域的整屏视图，而把那些视图放进域的出口会让打包器把整个域并回主 chunk。
9. **`core` 里没有模块 import `kernel/`，类型也不行。** `kernel/host.ts` 是宿主装配，只有根入口
   `src/index.ts` 转出它；接口跟着实现它的模块走（ADR-0054）。
10. **agent 循环不 import `runtime/`、`session/`、`kernel/`。** 会话、子代理、侧聊驱动循环，循环不认识
   它们；压缩、审批、钩子、中途换模型都经 `AgentRunConfig` 交进来。循环自己做的历史剪枝在 `agent/`，
   token 估算在 `tokens.ts`。类型也算——从 `runtime/` 拿一个类型，下一次就是拿一个值。
11. **`runtime/` 内部只往下引。** 会话驱动在最上面，子代理与侧聊、记录、装配、叶子依次往下，
   见上一节「core 的 runtime」。
12. **主进程的域之间只经对方的 `index.ts`。** 和渲染进程 `features/` 是同一条正门：index 是一个域对外的
   承诺，没列进去的文件可以随意改名、挪动。`ipc/`、`main.ts`、`window.ts` 是装配层，不在此列；类型也算。
   见「主进程的域」。

循环依赖是 error，垫着一份已有的 18 条的基线（`.dependency-cruiser-known-violations.json`，
连同第 8 条那两处有理由的破例共 20 条）：新加一条会让 `pnpm arch` 变红，已有那些照旧通过。
这个数字每次 `pnpm arch` 都会印出来，少一条就 `pnpm arch:baseline` 重生成一次——那是让它下降的
正常动作，也是唯一能让它上升的动作。

从前这条规则是 warn 配一句「数字是要盯的东西」，没有东西在盯，于是它从 53 涨到了 159。装上棘轮
之后清了两轮没人用的转出，掉到 142——其中最后 16 条是删掉 `electron/git.ts` 里一个空的
`export {} from "./forge/index.ts"` 断掉的。每一次下降都由 `test/docs-numbers.test.ts` 逼着改
这一段：它要求这里写的数和基线里的一样多。最近一次是循环的契约类型拆进 `agent/run-config.ts`
（118 → 116）：`tool-run.ts` 不再为了类型回头引用 `agent/loop.ts`，经过它闭合的两条环随之消失。
手机端共享消息合并函数时移除了它对桌面 store 类型的反向引用，循环基线进一步从 116 降到 114。侧边聊天改成会话、旧的侧聊消息行删掉之后，经过它和输入框上下文表的五条环跟着消失，降到 109。`errorResult` 从 `agent/tool-run.ts` 挪进 `tools/result.ts` 之后，工具不再为了一个报错构造器回头引用循环的执行器，`skills/tool.ts` 与它之间那条环随之断开，降到 108。内置面板的注册表从 `features/dock/panels/` 挪到 `app/panels.tsx` 之后，`dock` 的出口不再挂着那张 import 了几乎所有功能域的表，各域「打开一个面板」不再绕回自己；`Markdown` 连同它画代码块、图表、路径菜单的那一簇搬进独立的 `features/markdown/`，Git、文件、设置不再为了渲染一段文字经过对话域；主进程里跨进程的 git 结构收进 `ipc-shapes.ts`，`isGitRepo`、`gitBranch` 挪进 `git-probe.ts`，git 各模块不再经 `git.ts` 的转出回头引用自己。三处合起来降到 30，主进程那一侧清零。随后拆掉了当初为绕开这些环而写的参数注入（`Markdown` 由调用方传进气泡、审批卡、计划面板），`SubAgentPanel`、`TaskPanel` 这两个只有面板注册表用的面板也撤出了各自域的出口、由 `app/panels.tsx` 直接引用，功能域之间的环随之清零，降到 21。后台会话和屏上会话收进同一个事件归并（`cached-event.ts` 的 `foldEvent`）之后，`apply-event` 不再直接引工具事件那一层，读会话也不再经 `index.ts`、`session-slice.ts` 回头引 `session-read.ts`，降到 18。剩下的每一条都要经过一个 `import type` 才闭合——store 的各个 slice 回头拿 `AppState` 就是这一种——只看值依赖，整个仓库没有环。

## 要做某件事，去哪

| 想做的 | 去 |
| --- | --- |
| 加一个 IPC | `packages/contract/src/methods.ts` 登记 channel，签名与载荷类型写进 `contract/src/` 里对应主题的文件（`api.ts` 把各组拼成 `PlumeApi`）→ `electron/ipc/<域>.ts` 注册 → `electron/preload.ts` 暴露；契约的测试会检查三处一致。手机默认调不到；要开放就加进 `contract/src/mobile.ts` 的 `MOBILE_METHODS` 并在 `electron/mobile/mobile-rpc.ts` 实现 |
| 加一个内置工具 | `core/src/tools/`，登记进 `tools/groups.ts` 的分组；漏登记 `test/tool-registry.test.ts` 会红 |
| 加一个右侧面板 | `src/app/panels.tsx` 的 `BUILTIN_PANELS` 加一条；类型在 `features/dock/panels/registry.ts` |
| 维护模型价格、能力和中转别名 | `core/src/model-catalog.ts` 与 `scripts/update-model-catalog.mjs`；`pnpm catalog:update` 更新离线数据 |
| 某家模型的思考开关特例 | `core/src/ai/vendors/index.ts` 的 `RULES`，只收撞到过、学习表认领不了的；端点会报错并点名原因的，走 `ai/*-compat.ts` 那几张学习表 |
| 宿主启动时的装配 | `core/src/kernel/host.ts` 的 `bootHostKernel`：建会话存储、绑宿主的 skill 注册表；桌面端与终端共用。替换一条进程级的缝（沙箱、压缩、审批……）用各模块的 `useX`，宿主给会话加工具走 `AgentSessionOptions.extraTools`，见 ADR-0054 |
| 斜杠命令、skill 的解析与展开 | `core/src/commands/invoke.ts`（`@plume/core/commands-view`）；桌面端输入框和命令行都走它 |
| 默认子智能体定义 | `core/src/agents-builtin.ts`；运行时与设置页共用，浏览器从 `@plume/core/agents-builtin` 导入 |
| 改设计 token | `src/styles.css` 的 `@theme` 段 |
| 加一个基础组件 | `src/ui/<组>/`，配一条 `test/ui/` 的测试 |
| 加一个功能 | `src/features/<域>/`；跨域只经对方的 index |
| 主进程那一半 | `electron/<域>/`；跨域只经对方的 index，IPC 在 `electron/ipc/<域>.ts` 注册 |
| 调主进程 | `import { bridge } from "@/services"` |
| 判断命令危不危险 | `core/src/tools/risk*.ts` |
| 发版 | `pnpm release patch` |

## 检查

```bash
pnpm check   # lint + typecheck + test
pnpm arch    # 依赖方向
pnpm test:e2e  # 真实 Electron 窗口
```

`pnpm test`：纯逻辑的在各包 `test/` 下，组件的在 `packages/desktop/test/ui/`（happy-dom 真挂载）。
条数不写在这里——一个只会过期的数字，而它对任何决定都不起作用；要知道就跑一次。
e2e 在干净的 main 上有稳定失败和时好时坏的用例，清单在
[docs/architecture/testing.md › 干净 main 上的已知失败](docs/architecture/testing.md#干净-main-上的已知失败)。
e2e 红了先对照它：不在清单里的失败按新回归处理。

## 决策记录

改动与这里写的不一致时，改这里，并在 [docs/adr/](docs/adr/) 里留一条。
