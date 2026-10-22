/**
 * The tree, flattened into rectangles.
 *
 * Rendered as a flat, keyed list so a pane that moves from one branch to another is the same
 * React element — unmounting a conversation mid-drag would throw away its scroll position and
 * its composer draft. The dock already learned this; the same answer applies here.
 */

import { FULL, slice, type Box } from "../../lib/tiling.ts";
import type { SplitNode } from "./tree.ts";

export interface PaneBox extends Box {
	sessionId: string | null;
	/** Stable slot in the tree. Session switches keep this, so the pane does not remount. */
	path: number[];
}

export function layoutPanes(tree: SplitNode, within: Box = FULL): PaneBox[] {
	const out: PaneBox[] = [];
	const walk = (node: SplitNode, rect: Box, path: number[]) => {
		if (node.type === "leaf") {
			out.push({ sessionId: node.sessionId, path, ...rect });
			return;
		}
		let offset = 0;
		node.children.forEach((child, i) => {
			const share = node.sizes[i] ?? 0;
			walk(child, slice(rect, node.dir, offset, share), [...path, i]);
			offset += share;
		});
	};
	walk(tree, within, []);
	return out;
}

const NEAR = 1e-6;

/** Top-left of the workspace: this screen sits on the traffic lights. */
export const isOriginPane = (pane: Box): boolean => pane.left <= NEAR && pane.top <= NEAR;

/** Top-right of the workspace: this screen holds the window's panel buttons. */
export const isTopEndPane = (pane: Box): boolean => pane.top <= NEAR && Math.abs(pane.left + pane.width - 1) <= NEAR;
