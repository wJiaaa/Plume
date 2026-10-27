# ADR-0055：IPC 的类型住进契约，契约只从 core 拿类型

- 状态：已采纳；第 3 条的手机入口（`@plume/contract/mobile`、`mobile.ts`）随 [ADR-0059](0059-remove-native-mobile.md) 删除，其余不变
- 日期：2026-10-22
- 相关：`packages/contract/src/`（`api.ts` 与各主题文件、`session.ts`、`mobile.ts`）、
  core `src/contract-types.ts`、`src/client-types.ts`；`.dependency-cruiser.cjs`（`contract-is-a-leaf`、
  `contract-takes-only-types-from-core`）、`.oxlintrc.json`；延续 [ADR-0012](0012-one-contract-not-three.md)

## 背景

ADR-0012 把「有哪些方法、走哪个 channel」收进了 `@plume/contract`，但「每个方法收什么、回什么」
还留在桌面端：`electron/ipc-types.ts`（约 1400 行的 `PlumeApi`）和 `electron/ipc-shapes.ts`。于是：

- 渲染进程有 86 个文件从 `electron/` 引类型。边界第 3 条允许这么做，但这等于让渲染进程认识主进程
  的文件布局——主进程按域分目录时，这 86 处都要跟着改。
- 那些类型的闭包散在主进程的值模块里（`git-release.ts`、`forge/types.ts`、`session-cleanup.ts`……）
  和 `shared/` 里，类型和产生它的代码绑在一起，谁想要一个形状就得引那个模块。
- 手机端拿不到这些类型。`client-runtime` 的推送事件里另写了一份会话变更的形状。
- 契约「零依赖」，所以它想写签名也写不了：签名里到处是 core 的类型。

## 决定

1. **签名与载荷类型迁进契约，按主题分文件。** `api.ts` 只把各组拼成 `PlumeApi`，每组连同它的载荷
   住在自己主题的文件里（`sessions`、`agent`、`files`、`git`、`forge`、`release`、`worktree`、
   `extensions`、`settings`、`usage`、`windows`、`screenshot`、`system`、`mobile`）。`ipc-types.ts`、
   `ipc-shapes.ts`、`worktree-types.ts`、`usage-types.ts`、`shared/session-services.ts` 删掉，不留转发壳；
   其余文件里跨边界的纯类型（`GitStatus`、`ForgeAccount`、`BrowserState`、`FilePanelState`……）搬走，
   原处改为从契约 `import type`。`window.plume` 的全局声明留在桌面端 `services/bridge.ts`——那是
   渲染进程自己的事，不是边界的描述。
2. **契约只许类型依赖，来源只限 core 的两个类型入口。** `@plume/core/contract-types` 是新加的入口，
   只有 `export type`，从 core 的 index 转出跨 IPC 的那些类型；`client-types` 是手机已经在用的那个。
   `.dependency-cruiser.cjs` 拦住其余一切去向（别的包、`node:`、npm 模块），并要求连这两个入口也只能
   `import type`；oxlint 在源头再说一次「只许类型」。两个消费者（主进程注册、preload 生成）与手机
   的构建因此拿不到 core 的任何值。
3. **手机只经 `@plume/contract/mobile` 进来。** 那条路只有 `mobile.ts` 与 `session.ts`，只碰
   `client-types`。根入口顺着 `contract-types` 会把 core 的整个 index 拉进类型检查；手机本来就刻意
   只编译 `client-types`（见那个文件的注释）。
4. **`shared/` 可以从契约拿类型。** `shared/browser.ts` 解析 `BrowserCommand`、`file-panel-state.ts`
   合并 `FilePanelState`——它们判断的对象就是跨边界的载荷。契约在两个进程之下，不偏向任何一端，
   边界第 4 条「不依赖任何一个进程」仍然成立。

## 后果

**得到的**：渲染进程不再点名 `electron/` 里的任何文件。主进程分目录、改文件名，渲染进程不受影响。
循环依赖基线不变（主进程那一侧此前已经清零）。

**代价**：契约的类型检查要带上 core 的环境（`lib` 含 DOM、`types` 含 node）——`contract-types` 指向
core 的 index，而 core 是以源码被消费的，检查契约就是在检查那些文件。从前 `tsconfig.src.json`
用「不给 node 类型」来守可移植性；现在这件事由依赖规则守：能引什么、只能怎么引。

**手机端没有统一的**：`client-runtime` 的 `SessionSnapshot` 比契约的少三个可选字段
（`compactions`、`commandRuns`、`hookRuns`）——手机不读它们，统一过去不改变行为，但形状不同，
留着。`Bootstrap`、`MobileModel`、`PromptImage` 是手机协议自己的东西，不是 IPC 载荷。会话变更
（`SessionChange`）是同一个形状，改为从契约引用。

**没做的**：主进程 `terminal-registry.ts` 里另有一份同形状的 `TerminalTab`；`preload.ts` 的
`pathForDrop` 需要 DOM 的 `File`，契约因此带 DOM 的 `lib`。参数的运行时校验仍然没有，见 ADR-0012。
