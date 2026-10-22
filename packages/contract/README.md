# @plume/contract

渲染进程与主进程之间那条线，写下来一次。

## 为什么是一个包

同一件事本来有两处描述，互相之间没有共同来源：

| 文件 | 说的是 |
| --- | --- |
| `desktop/electron/ipc-types.ts` | 方法的类型签名 |
| `desktop/electron/preload.ts` | 方法名到 channel 名的映射 |

漏 preload 是 `undefined is not a function`，漏主进程的 handler 是 `No handler registered`，
都要点到那个按钮才会暴露。

## 里面有什么

`src/methods.ts` 是那份清单。每个方法一行，写明 **channel**：IPC 通道名。它只在这里出现一次，
所以拼错是不可能的。`test/methods.test.ts` 把它和 preload、主进程的 `ipcMain.handle` 逐一比对。

方法的签名与它们传的值也在这里（原先在 `desktop/electron/ipc-types.ts`、`ipc-shapes.ts`，见
ADR-0055）。`src/api.ts` 把各组拼成 `PlumeApi`，每组连同它的载荷类型住在自己主题的文件里：
`sessions.ts`、`agent.ts`、`files.ts`、`git.ts`、`forge.ts`、`release.ts`、`worktree.ts`、
`extensions.ts`、`settings.ts`、`usage.ts`、`windows.ts`、`screenshot.ts`、`system.ts`、`mobile.ts`。
`session.ts` 是会话快照与变更，手机端也收这两样。

## 入口

| 入口 | 给谁 |
| --- | --- |
| `@plume/contract` | 桌面端：主进程、preload、渲染进程。方法表、`PlumeApi` 与全部载荷类型 |
| `@plume/contract/mobile` | 手机端与 `client-runtime`：手机能调的方法与会话变更。只碰 core 的 `client-types` |

## 边界

这个包**只有类型依赖**：从 `@plume/core/contract-types` 与 `@plume/core/client-types` 引类型
（`import type`），不引任何值，也不引别的包。主进程与 preload 都从它读方法表，引了谁的值就把谁
拖进另一方的构建里。`pnpm arch`（`contract-is-a-leaf`、`contract-takes-only-types-from-core`）
与 oxlint 守着这一条。
