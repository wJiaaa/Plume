/** 回复里一条相对路径对应的文件，找的规矩见 `services/locate.ts`。 */

import { useEffect, useState } from "react";
import { locatedFiles, locateFiles } from "../../services/index.ts";

const NONE: readonly string[] = [];

/** 第一个找得到的目录里的候选。前面的先问：项目里有同名的，就不该被 scratch 里的那份搅成「选一个」。 */
async function locateFirst(roots: readonly string[], relative: string): Promise<readonly string[]> {
	for (const root of roots) {
		const paths = await locateFiles(root, relative);
		if (paths.length) return paths;
	}
	return NONE;
}

function locatedFirst(roots: readonly string[], relative: string): readonly string[] | null {
	for (const root of roots) {
		const paths = locatedFiles(root, relative);
		if (paths) return paths;
	}
	return null;
}

/**
 * 依次在 `roots` 里找，返回第一处对得上的全部文件。
 *
 * null 是还没找完（或没有地方可找），调用方照旧按工作目录拼；空数组是找完了、哪里都没有。
 * `roots` 要是稳定的引用：它变了就重找一遍。
 */
export function useLocatedPaths(roots: readonly string[], relative: string): readonly string[] | null {
	const [located, setLocated] = useState<{ roots: readonly string[]; relative: string; paths: readonly string[] } | null>(null);
	useEffect(() => {
		if (!roots.length || locatedFirst(roots, relative)) return;
		let alive = true;
		void locateFirst(roots, relative).then((paths) => {
			if (alive) setLocated({ roots, relative, paths });
		});
		return () => {
			alive = false;
		};
	}, [roots, relative]);
	if (!roots.length) return null;
	return locatedFirst(roots, relative) ?? (located?.roots === roots && located.relative === relative ? located.paths : null);
}
