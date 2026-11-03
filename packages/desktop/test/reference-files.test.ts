import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { referenceFile, registerReferenceFiles } from "../electron/capabilities/reference-files.ts";

test("listing a skill permits only that file, never adjacent settings or the whole home", async () => {
	const root = await mkdtemp(join(tmpdir(), "ly-ref-"));
	try {
		const skill = join(root, "SKILL.md");
		const settings = join(root, "settings.json");
		await writeFile(skill, "skill");
		await writeFile(settings, "settings");
		assert.equal(await referenceFile(skill), null);
		await registerReferenceFiles([skill]);
		assert.equal(await referenceFile(skill), await realpath(skill));
		assert.equal(await referenceFile(settings), null);
		assert.equal(await referenceFile(root), null);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a path on another machine is refused before anything resolves it", async () => {
	for (const path of ["\\\\evil\\share\\SKILL.md", "//evil/share/SKILL.md", "\\\\?\\C:\\SKILL.md"]) {
		assert.equal(await referenceFile(path), null, path);
	}
});
