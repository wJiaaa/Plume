/**
 * `#rrggbb` 的拆、混、拼。主题和窗口那条标题栏的变暗都要用，放在两边都不依赖的地方：`theme.ts`
 * 引着 `window-tint.ts`，反过来再引一次就是一个环。
 */

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

export function parseHex(hex: string | undefined | null): Rgb | null {
	// Null rather than a throw for anything that is not a colour, including nothing at all: every
	// caller already has a fallback for an unparseable one, and none of them expect an exception.
	if (typeof hex !== "string") return null;
	const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
	if (!match) return null;
	let value = match[1];
	if (value.length === 3) value = value.split("").map((c) => c + c).join("");
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
	};
}

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	const t = Math.max(0, Math.min(1, amount));
	return {
		r: Math.round(from.r + (to.r - from.r) * t),
		g: Math.round(from.g + (to.g - from.g) * t),
		b: Math.round(from.b + (to.b - from.b) * t),
	};
}

export function toHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`;
}
