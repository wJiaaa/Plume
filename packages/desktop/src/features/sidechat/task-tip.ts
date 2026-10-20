/**
 * 任务行悬停提示里放多少指令。
 *
 * 行内只写得下一行，提示原本给的是整段——而侧聊派出去的常是几十行的计划，气泡长出窗口底部，
 * 拼在最后的状态行被挤到看不见。完整指令在侧聊转录的「派给主会话」卡片和主会话的转录里都有，
 * 提示只要认得出是哪一件、现在到哪了。空行不留：气泡里一行空白也是一行高度。
 */

const TIP_LINES = 6;
/** 提示宽 360px，一行二十几个汉字：这么多字折下来六七行，加上状态行仍在十行以内。 */
const TIP_CHARS = 160;

export function taskTip(text: string, status: string): string {
	const lines = text.split("\n").filter((line) => line.trim());
	const full = lines.join("\n");
	// 按字符而不是 UTF-16 单元截，不把一个 emoji 劈成两半。
	const chars = Array.from(lines.slice(0, TIP_LINES).join("\n")).slice(0, TIP_CHARS);
	const kept = chars.join("");
	return `${kept === full ? kept : `${kept.trimEnd()}…`}\n\n${status}`;
}
