/**
 * 会话域对别的域的出口：手机端与插件更新要读写的那些活着的会话。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { resolveSessionApproval } from "./approval-response.ts";
export { slimSnapshot } from "./display-transcript.ts";
export { generalScratchDir } from "./scratch.ts";
export {
	abortSession,
	broadcast,
	createSession,
	disposeSession,
	ensureLiveSession,
	mcpPool,
	promptSession,
	sessions,
	snapshot,
	touchSession,
	worktreeFollowsArchive,
} from "./session-hub.ts";
