/**
 * 把一段 Markdown 画出来，以及点开其中路径和链接的那几样东西。
 *
 * 从对话域里分出来：Git、文件、设置、子智能体都只是想渲染一段文字，却要经过对话的出口，
 * 于是每一条都绕回了它自己——搬出来之前，循环基线里有 17 条是文件查看器经由这里闭合的。
 * 这里不认识「对话」，往里加东西之前先确认它不会把对话域拉进来。
 */

export { Markdown } from "./Markdown.tsx";
export { usePathMenu } from "./PathMenu.tsx";
export { Arrival, useArrival } from "./useSmoothText.ts";
export { copyableReply } from "./interface/interface-text.ts";
