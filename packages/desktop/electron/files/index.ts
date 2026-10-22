/**
 * 文件域对别的域的出口：「这个路径在不在项目里」只有一份判断；消息里带着的附件，会话记下、预览协议放行，
 * 认的是同一张表。
 *
 * 别的域只经这里引它（`.dependency-cruiser.cjs` 的 `main-domains-through-the-front-door`），所以只列
 * 真有别的域在用的；没列出来的文件可以随意改名、挪动。`main.ts`、`window.ts` 与 `ipc/` 是装配层，照旧直接引。
 */
export { attachmentFile, noteAttachmentPath, noteTranscriptFiles } from "./attachment-reads.ts";
export { resolveInside } from "./file-ops.ts";
