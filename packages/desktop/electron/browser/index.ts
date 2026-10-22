/**
 * 内置浏览器对别的域的出口：会话要给模型装上浏览器工具，结束时把它的页面收走。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { createBrowserTools } from "./browser-tools.ts";
export { browserState, closeSessionBrowser } from "./browser-workspace.ts";
