/**
 * 还在写的调用，参数写到哪儿了：写文件那一行的路径和「已写 N 行」从这里来。
 *
 * 读的是参数原文，不整段解析，所以转义要数对：`\\n` 是反斜杠加 n，不是换行；字符串里的 `"path"` 是内容，
 * 不是键。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { streamedLines, streamedString } from "../src/lib/streamed-arguments.ts";

test("写到一半的内容：数已经写完的行", () => {
	assert.equal(streamedLines('{"path":"a.gd","content":"extends Node3D\\nfunc a():\\n\\tpa', "content"), 2);
	assert.equal(streamedLines('{"path":"a.gd","content":"', "content"), 0);
	assert.equal(streamedLines('{"path":"a.gd"', "content"), undefined);
});

test("转义过的反斜杠后面跟 n 不是换行，写完的值到闭合的引号为止", () => {
	assert.equal(streamedLines('{"content":"a\\\\nb\\nc\\"d\\n"}', "content"), 2);
	assert.equal(streamedLines('{"content":"one\\ntwo","other":"\\n\\n"}', "content"), 1);
});

test("路径要写完才算，内容里的「\"path\"」不是键", () => {
	assert.equal(streamedString('{"path":"scripts/sample.gd","content":"x', "path"), "scripts/sample.gd");
	assert.equal(streamedString('{"path":"scripts/sam', "path"), undefined);
	assert.equal(streamedString('{"content":"{\\"path\\": \\"fake\\"}', "path"), undefined);
});
