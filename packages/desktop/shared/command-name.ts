/**
 * 新建命令时，名字要满足什么，以及落成哪个文件名。
 *
 * 两边都问它：新建弹窗边打边提示，主进程写文件前再守一次。从前规则只在主进程里，弹窗只能等
 * 按下「创建」之后才知道名字不行。
 */

/** 能用就给出文件名（不带 `.md`），不能用就是 null。大写会被当成小写，前后空白不算。 */
export function commandFileName(name: string): string | null {
	const clean = name.trim().toLowerCase();
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) ? clean : null;
}
