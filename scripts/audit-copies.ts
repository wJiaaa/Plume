// 审计脚本读会话日志时，分叉抄来的那段怎么认。单拿出来是为了能测：`session-audit.ts` 一 import 就去读本机数据库。

export function isFork(meta: string): boolean {
	try {
		return (JSON.parse(meta) as { forkedFrom?: unknown }).forkedFrom !== undefined;
	} catch {
		return false;
	}
}

/**
 * 去掉分叉时抄过来的那一段：那些回复在原会话里已经付过钱、发生过，在分叉里再数一遍就是重复。
 *
 * 不去掉的时候，本机 11 个分叉把 433 次回复、$22.67 又算了一遍，第 8 节的总额因此虚高一成。
 * 新日志在抄来的记录上写 `copy: true`（`SessionStore.append`）；那之前的分叉没有这个标记，只能认
 * 消息自带的 `timestamp` 早于这个会话的创建时刻——抄过来的消息保留原来的时间。抄的那段在最前面，
 * 夹在里面没有标记的压缩边界跟着一起去掉。
 */
export function withoutCopies(lines: string[], createdAt: number, fork: boolean): string[] {
	if (!fork) return lines;
	const copied = lines.map((line) => {
		try {
			const entry = JSON.parse(line) as { copy?: boolean; message?: { timestamp?: unknown } };
			return entry.copy === true || (typeof entry.message?.timestamp === "number" && entry.message.timestamp < createdAt);
		} catch {
			return false;
		}
	});
	const end = copied.lastIndexOf(true);
	return lines.filter((_, i) => i > end && !copied[i]);
}
