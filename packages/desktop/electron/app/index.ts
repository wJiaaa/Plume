/**
 * 应用外壳对别的域的出口：会话结束时发系统通知，浏览器把外链交给系统打开前过一遍安全检查。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { notifyAgentEvent } from "./notify.ts";
export { openExternalSafely } from "./window-security.ts";
