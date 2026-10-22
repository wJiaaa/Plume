/**
 * Git 域对别的域的出口：跑一条 git 命令，以及会话自己的工作树什么时候建、收、还。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { git } from "./git-exec.ts";
export { autoCreateSessionWorktree, cleanOldWorktrees } from "./git-worktrees.ts";
export { bringBackWorktree, reclaimWorktree } from "./worktree-lifecycle.ts";
