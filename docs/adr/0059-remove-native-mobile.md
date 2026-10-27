# ADR-0059：再次移除手机端

- 状态：已采纳
- 日期：2026-10-27
- 相关：取代 [ADR-0041](0041-native-mobile-shared-runtime.md)、[ADR-0042](0042-mobile-relay-speaks-lyra.md)；理由与 [ADR-0026](0026-remove-mobile-and-relay.md) 同源

## 背景

ADR-0041 加回了独立的原生手机界面，ADR-0042 让它经 Lyra 中转连进来。实际情况是手机端没人在用，
而它要一直付的成本没有少：

- 手机自己维护一套连接：主进程里的 HTTP / WebSocket 服务、配对令牌、局域网地址枚举、中转房间、
  手机可调方法的白名单（`MOBILE_METHODS`），以及 `client-runtime` 里的重连、快照与事件合并
- 会话事件要多推一路（`remoteEvent`），而那一路还是每个 token 一份整条消息的 JSON
- 依赖树里多出整个 Expo / React Native，连带为它存在的 `virtualStoreDirMaxLength`、`markdown-it@10`
  的补丁与 override、两条只能忽略的 advisory
- 经中转时没有端到端加密，配对令牌就是这台电脑上 agent 的操作权限

## 决定

删掉 `packages/mobile`；主进程的 `electron/mobile/`、`mobile:*` IPC 与设置页「手机连接」；契约的
`@plume/contract/mobile` 入口与 `MOBILE_METHODS`；整个 `packages/client-runtime`。

`client-runtime` 是 ADR-0041 为了让手机和桌面共用规则拆出来的。手机删掉之后只剩桌面一个使用方，
命令行要的是终端自己的显示方式，也不打算用它，于是并回桌面：消息合并回到 `store/message-event.ts`，
流式 markdown 补收口回到 `lib/markdown/stream-tail.ts`，运行行的词回到 `lib/thinking-words.ts`
（`Mood` 直接就是小球的 `OrbState`），`formatTokens` 回到 `lib/format-tokens.ts`，运行行的读数与
让位判据放进 `features/conversation/running-line.ts`。

## 后果

**得到的**：少两个包、一个对外监听的网络服务和一条攻击面；lockfile 少了约三分之一；加 IPC 不必再
判断手机能不能调；会话事件只推给窗口。

**失去的**：不能在手机上看进行中的回合、批准操作、继续追问。

**旧数据**：`~/.plume/mobile-access.json` 不再被读取，留着无害；里面的令牌不再授予任何能力。

## 什么时候该重新考虑

又需要在电脑之外操作 agent 时。先读 ADR-0041、ADR-0042 与这条的 git 历史：独立手机界面、共享
无 UI 规则、中转不改协议这几条判断本身仍然成立，删掉的是实现；但在用第三方中转之前，先解决
ADR-0042 里写明的端到端加密。
