/**
 * 检查点上运行时递给子代理的那句「接着跑」。
 *
 * 单放一个文件，是因为两头都要它：跑的时候（`sub-agent-run.ts`）递进去，重建续跑上下文时
 * （`sub-agent-restore-legacy.ts`）在没记下它的旧日志里一字不差地补回来。restore 不该为一句话把整条
 * 运行链 import 进来。
 */

import type { Message } from "../../types.ts";

/**
 * 没写清单就撞上检查点时，接着跑的那一段以这句话开头。
 *
 * 两条路都给：列清单接着做，或者现在收尾。只给第一条的话，一个其实已经查够了的子代理会为了
 * 「有清单」而硬凑三项、再跑六十轮；只给第二条，就退回了从前那一刀。
 *
 * `synthetic`：这是运行时在说话，不是派它来的人。
 */
export function planDemand(rounds: number, timestamp = Date.now()): Message {
	return {
		role: "user",
		content: [{ type: "text", text: planDemandText(rounds) }],
		timestamp,
		synthetic: true,
	};
}

/** 这条是不是那句话——新日志里它记进了转录，旧日志里要补。 */
export function isPlanDemand(message: Message, rounds: number): boolean {
	if (message.role !== "user" || !message.synthetic) return false;
	const [only, ...rest] = message.content;
	return rest.length === 0 && only?.type === "text" && only.text === planDemandText(rounds);
}

function planDemandText(rounds: number): string {
	return (
		`（自动追加）这一段的 ${rounds} 轮用完了。还没做完的话，先用 \`todo_write\` 把剩下的步骤列出来再接着做——` +
		"之后每到检查点，清单在往前推就会让你继续；手上的信息已经够了，就现在收尾交付。" +
		"接下来把互不依赖的读取和搜索放在同一条回复里一起发。"
	);
}
