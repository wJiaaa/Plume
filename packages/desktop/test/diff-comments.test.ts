import assert from "node:assert/strict";
import { test } from "node:test";

import { commentPlace, diffCommentPrompt, rowKey, useDiffComments } from "../src/features/git/diff-comments.ts";

const add = (newLine: number, text: string) => ({ type: "add" as const, newLine, text });
const removed = (oldLine: number, text: string) => ({ type: "remove" as const, oldLine, text });
const context = (oldLine: number, newLine: number, text: string) => ({ type: "context" as const, oldLine, newLine, text });

test("同一个行号上换了内容就不再是那一行，删掉的行和新加的行也分得开", () => {
	assert.equal(rowKey("a.ts", add(3, "x")), rowKey("a.ts", add(3, "x")));
	assert.notEqual(rowKey("a.ts", add(3, "x")), rowKey("a.ts", add(3, "y")));
	assert.notEqual(rowKey("a.ts", add(3, "x")), rowKey("a.ts", removed(3, "x")));
	assert.notEqual(rowKey("a.ts", add(3, "x")), rowKey("b.ts", add(3, "x")));
});

test("评论按文件、再按行排；带 id 是改那一条，按仓库分开存，清空只清这一个仓库", () => {
	const store = useDiffComments.getState();
	store.save("/repo", { path: "b.ts", lines: [add(1, "b")], text: "三" });
	store.save("/repo", { path: "a.ts", lines: [add(20, "y")], text: "二" });
	store.save("/repo", { path: "a.ts", lines: [removed(4, "x")], text: "一" });
	store.save("/other", { path: "a.ts", lines: [add(1, "z")], text: "别的仓库" });
	const saved = () => useDiffComments.getState().byRepo["/repo"] ?? [];
	assert.deepEqual(saved().map((comment) => comment.text), ["一", "二", "三"]);

	const second = saved()[1]!;
	useDiffComments.getState().save("/repo", { id: second.id, path: second.path, lines: [add(19, "w"), add(20, "y")], text: "改过" });
	assert.equal(saved().length, 3);
	assert.deepEqual(saved()[1]?.lines.map((line) => line.newLine), [19, 20]);
	assert.equal(saved()[1]?.text, "改过");

	useDiffComments.getState().remove("/repo", saved()[0]!.id);
	assert.deepEqual(saved().map((comment) => comment.text), ["改过", "三"]);

	useDiffComments.getState().clear("/repo");
	assert.equal(useDiffComments.getState().byRepo["/repo"], undefined);
	assert.equal(useDiffComments.getState().byRepo["/other"]?.length, 1);
});

test("位置用新行号；只评了删掉的行时说是改动前的第几行", () => {
	assert.equal(commentPlace({ path: "a.ts", lines: [add(12, "x")] }), "a.ts:12");
	assert.equal(commentPlace({ path: "a.ts", lines: [removed(11, "o"), add(12, "x"), context(13, 14, "c")] }), "a.ts:12-14");
	assert.equal(commentPlace({ path: "a.ts", lines: [removed(8, "o"), removed(9, "p")] }), "a.ts 改动前的第 8-9 行");
});

test("发出去的每条是位置、带前缀的 diff、评论；代码里有 ``` 时围栏加长", () => {
	const prompt = diffCommentPrompt("/repo", [
		{ id: "1", path: "a.ts", lines: [removed(3, "old()"), add(3, "next()")], text: " 这里要判空 " },
		{ id: "2", path: "b.md", lines: [context(1, 1, "```js")], text: "围栏" },
	]);
	const [lead, root, first, second] = prompt.split("\n\n");
	assert.ok(lead?.startsWith("按下面这几条评论改代码"));
	assert.equal(root, '工作区: "/repo"');
	assert.equal(first, "(1) `a.ts:3`\n```diff\n-old()\n+next()\n```\n这里要判空");
	assert.equal(second, "(2) `b.md:1`\n````diff\n ```js\n````\n围栏");
});

test("同名文件的评论带所选仓库目录，主仓库、另一工作树和 Windows 目录不混用", () => {
	const comments = [{ id: "1", path: "src/a.ts", lines: [add(3, "next()")], text: "这里要判空" }];
	for (const cwd of ["/workspace/main", "/worktrees/feature space", "C:\\worktrees\\feature"]) {
		const prompt = diffCommentPrompt(cwd, comments);
		assert.equal(prompt.split("\n\n")[1], `工作区: ${JSON.stringify(cwd)}`);
		assert.ok(prompt.includes("`src/a.ts:3`"));
	}
	assert.notEqual(diffCommentPrompt("/workspace/main", comments), diffCommentPrompt("/worktrees/feature space", comments));
});
