/**
 * 会话之间互相发消息，对别的域的出口：会话装上这组工具与路由，交接计划时写对方的地址。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { peerAddress } from "./peer-address.ts";
export { createPeerTools } from "./peer-tools.ts";
export { createPeerRouter, lastReply } from "./session-peers.ts";
