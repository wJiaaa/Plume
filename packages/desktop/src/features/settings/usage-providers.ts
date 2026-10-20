/** 用量记录里的 `providerId` 是谁：页面上每一处写供应商名字的地方都从这里拿。 */

/** 认出一个 `providerId` 是谁，能用的两个来源。 */
export interface ProviderNaming {
	/** 现在还配着的供应商。 */
	providers?: { id: string; name: string }[];
	/** 每个见过的供应商最后一次叫什么名字，**包括已经删掉的**。见 `Settings.providerNames`。 */
	names?: Record<string, string>;
}

export interface ProviderIdentity {
	/** 印在页面上的那个字符串。永远有值。 */
	label: string;
	/** 这个供应商现在还配着。 */
	configured: boolean;
	/** 这个名字是查出来的，不是从 id 上拆下来的。 */
	named: boolean;
}

/**
 * `provider-mttnetnn` 里有用的那一半。
 *
 * 前缀是每一个自动生成的 id 都一样的六个字母，在一栏只有几十像素宽的表格里，它挤掉的正好是能
 * 区分两个供应商的那八位。别的形状的 id（`relay` 这种用户自己起的）原样留着。
 */
function shortProviderId(id: string): string {
	const short = id.replace(/^provider-/, "");
	return short || id;
}

/**
 * 这笔账是谁花的。
 *
 * 三级，一级比一级弱：还配着的供应商用它现在的名字；删掉的用档案里记下的最后一个名字；两处都
 * 没有的，只剩 id——那是 2026-09 之前删掉的供应商，名字在删除的那一刻就没了，只有用户自己还
 * 知道它是谁（所以用量页上可以给它命名，写进同一份档案）。
 *
 * 永远给得出一个字符串。空着比 id 更糟：这一行确实花了这些钱，总得有个东西指着它。
 */
export function providerIdentity(naming: ProviderNaming | undefined, id: string): ProviderIdentity {
	const configured = naming?.providers?.find((each) => each.id === id);
	if (configured?.name.trim()) return { label: configured.name, configured: true, named: true };
	const remembered = naming?.names?.[id]?.trim();
	if (remembered) return { label: remembered, configured: false, named: true };
	return { label: shortProviderId(id), configured: Boolean(configured), named: false };
}

export function providerLabel(naming: ProviderNaming | undefined, id: string): string {
	return providerIdentity(naming, id).label;
}
