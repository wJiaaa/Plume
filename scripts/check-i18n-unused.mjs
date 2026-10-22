#!/usr/bin/env node
/**
 * Message keys nothing reads any more.
 *
 * `check-i18n.mjs` catches text that should have been a key; nothing caught the opposite. A
 * component is deleted, its keys stay behind in both catalogs, and the next person looking for
 * wording finds three near-identical entries and cannot tell which one is live. By 2026-10 that was
 * about 150 keys — two lines each, since every key exists in both languages.
 *
 * A key counts as used when its full name appears as a string literal anywhere the desktop is
 * written — renderer, main process, shared, tests, e2e. Keys are also built at runtime
 * (`` t(`avatar.color.${name}`) ``, `"notice." + kind`), so a literal prefix in front of an
 * interpolation keeps every key under it, and a literal suffix after one keeps every key ending in
 * it. That errs towards keeping: a key wrongly kept costs two lines, a key wrongly deleted shows a
 * raw key name in the interface.
 *
 *   node scripts/check-i18n-unused.mjs          # 报告，有没人用的词条就非零退出
 *   node scripts/check-i18n-unused.mjs --fix    # 从两个语言文件里一起删掉
 */

import { readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(ROOT, "packages/desktop");
const MESSAGES = join(DESKTOP, "src/i18n/messages");
const CATALOGS = ["zh-CN.ts", "en.ts"].map((name) => join(MESSAGES, name));
const SCANNED = ["src", "electron", "shared", "test", "e2e"].map((dir) => join(DESKTOP, dir));

function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (path === MESSAGES || name === "node_modules") continue;
		if (statSync(path).isDirectory()) walk(path, out);
		else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path);
	}
	return out;
}

/** Skips the string literal opening at `at`; returns the index just past its closing quote. */
function stringEnd(text, at) {
	let i = at + 1;
	while (text[i] !== text[at]) i += text[i] === "\\" ? 2 : 1;
	return i + 1;
}

/**
 * Every top-level entry of a catalog: its key and the span it occupies, trailing comma included.
 *
 * Not one key per line — `en.ts` packs short ones together (`"common.cancel": "Cancel", "common.confirm": …`),
 * and a line-based reading saw only the first key on each such line. A plural entry is an object, so
 * nesting is tracked rather than the next line assumed to start a new key.
 */
function entries(text) {
	const out = [];
	let depth = 1;
	let open = null;
	for (let i = text.indexOf("= {") + 3; i < text.length && depth > 0; i++) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") i = text.indexOf("\n", i);
		else if (c === "/" && text[i + 1] === "*") i = text.indexOf("*/", i) + 1;
		else if (c === "\"" || c === "'" || c === "`") {
			const end = stringEnd(text, i);
			const colon = depth === 1 && !open ? /^\s*:/.exec(text.slice(end, end + 8)) : null;
			if (colon) open = { key: text.slice(i + 1, end - 1), start: i };
			i = end - 1 + (colon ? colon[0].length : 0);
		} else if ("{[(".includes(c)) depth++;
		else if ("}])".includes(c) && --depth === 0 && open) out.push({ ...open, end: i });
		else if (c === "," && depth === 1 && open) {
			let end = i + 1;
			while (text[end] === " ") end++;
			out.push({ ...open, end });
			open = null;
		}
	}
	return out;
}

const keys = entries(await readFile(CATALOGS[0], "utf8")).map((entry) => entry.key);

const literals = new Set();
const prefixes = new Set();
const suffixes = new Set();
for (const file of SCANNED.flatMap((dir) => walk(dir))) {
	const text = await readFile(file, "utf8");
	for (const [, name] of text.matchAll(/["'`]([\w.-]+)["'`]/g)) literals.add(name);
	for (const [, head] of text.matchAll(/`([\w.-]+\.)\$\{/g)) prefixes.add(head);
	for (const [, head] of text.matchAll(/["']([\w.-]+\.)["']\s*\+/g)) prefixes.add(head);
	for (const [, tail] of text.matchAll(/\}(\.[\w.-]+)`/g)) suffixes.add(tail);
}

const used = (key) =>
	literals.has(key) ||
	[...prefixes].some((head) => key.startsWith(head)) ||
	[...suffixes].some((tail) => key.endsWith(tail));
const unused = keys.filter((key) => !used(key));

if (process.argv.includes("--fix")) {
	const dead = new Set(unused);
	for (const path of CATALOGS) {
		let text = await readFile(path, "utf8");
		for (const { key, start, end } of entries(text).reverse()) {
			if (!dead.has(key)) continue;
			const lineStart = text.lastIndexOf("\n", start - 1) + 1;
			const alone = !text.slice(lineStart, start).trim() && text[end] === "\n";
			// Alone on its line: the line goes. Sharing it: only the entry, and the space it leaves at the end.
			if (alone) text = text.slice(0, lineStart) + text.slice(end + 1);
			else text = text.slice(0, start).replace(text[end] === "\n" ? / +$/ : /$/, "") + text.slice(end);
		}
		await writeFile(path, text);
	}
	console.log(`删掉了 ${unused.length} 个没人用的词条（两种语言）。`);
	process.exit(0);
}

if (unused.length) {
	console.error(`${unused.length} 个词条没有任何代码在用：\n${unused.map((key) => `  ${key}`).join("\n")}\n` +
		`确认后：node scripts/check-i18n-unused.mjs --fix`);
	process.exit(1);
}
console.log(`✓ ${keys.length} 个词条都有人用`);
