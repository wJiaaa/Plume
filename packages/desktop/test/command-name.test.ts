/**
 * 新建命令的名字规则：弹窗和主进程读的是同一条。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { commandFileName } from "../shared/command-name.ts";

test("小写字母、数字和单个连字符可以用，大写按小写算", () => {
	assert.equal(commandFileName("review-diff"), "review-diff");
	assert.equal(commandFileName("  Ship2 "), "ship2");
});

test("空格、下划线、连字符打头或连写都不行", () => {
	for (const name of ["", "review diff", "review_diff", "-review", "review-", "review--diff", "评审"]) {
		assert.equal(commandFileName(name), null, name);
	}
});
