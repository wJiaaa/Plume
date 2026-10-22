/**
 * What survives the trip from a web page into a model's context.
 *
 * The three cases that motivated rewriting this are the first three below. Each one is a page a
 * developer actually fetches — an API reference with a parameter table, a guide with nested steps,
 * a snippet — and each one came out of the old regex version as an unusable run of words.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { htmlToText } from "../src/tools/html-text.ts";
import { decodeEntities } from "../src/utils/entities.ts";

test("a table keeps its rows and columns", () => {
	const text = htmlToText(`
		<table>
			<tr><th>参数</th><th>类型</th></tr>
			<tr><td>path</td><td>string</td></tr>
			<tr><td>mode</td><td>number</td></tr>
		</table>`);
	assert.match(text, /\| 参数 \| 类型 \|/);
	assert.match(text, /\| --- \| --- \|/, "without a separator the header reads as the first data row");
	assert.match(text, /\| path \| string \|/);
	assert.match(text, /\| mode \| number \|/);
});

test("nested lists keep their nesting", () => {
	const text = htmlToText(`
		<ul>
			<li>安装
				<ul><li>npm</li><li>pnpm</li></ul>
			</li>
			<li>配置</li>
		</ul>`);
	assert.match(text, /^- 安装/m);
	assert.match(text, /^ {2}- npm/m, "a nested item is indented, not flattened to the same level");
	assert.match(text, /^ {2}- pnpm/m);
	assert.match(text, /^- 配置/m);
});

test("an ordered list is numbered, and numbering restarts per list", () => {
	const text = htmlToText("<ol><li>one</li><li>two</li></ol><ol><li>again</li></ol>");
	assert.match(text, /1\. one/);
	assert.match(text, /2\. two/);
	assert.match(text, /1\. again/);
});

test("a code block keeps its line breaks", () => {
	const text = htmlToText("<pre><code>const a = 1;\nconst b = 2;\n</code></pre>");
	assert.match(text, /```/);
	assert.match(text, /const a = 1;\nconst b = 2;/, "collapsing this whitespace destroys the snippet");
});

test("inline code is marked without swallowing the text", () => {
	assert.match(htmlToText("<p>call <code>readFile</code> first</p>"), /call `readFile` first/);
});

test("headings keep their level", () => {
	const text = htmlToText("<h1>Title</h1><h3>Sub</h3>");
	assert.match(text, /^# Title$/m);
	assert.match(text, /^### Sub$/m);
});

// ---------------------------------------------------------------------------
// What must not survive
// ---------------------------------------------------------------------------

test("scripts and styles are gone, contents and all", () => {
	const text = htmlToText("<style>.a{color:red}</style><p>hi</p><script>alert(1)</script>");
	assert.equal(text, "hi");
});

test("an unclosed script does not swallow the rest of the page", () => {
	// Real pages do this. Dropping to the end of input would lose everything after it.
	const text = htmlToText("<p>before</p><script>var x = 1;");
	assert.match(text, /before/);
	assert.ok(!text.includes("var x"), text);
});

test("svg and iframes are dropped whole", () => {
	const text = htmlToText("<p>a</p><svg><path d='M0 0'/></svg><iframe src='x'></iframe><p>b</p>");
	assert.ok(!text.includes("M0 0"), text);
	assert.match(text, /a/);
	assert.match(text, /b/);
});

// ---------------------------------------------------------------------------
// Markup that is wrong, which is most markup
// ---------------------------------------------------------------------------

test("a `>` inside an attribute does not end the tag early", () => {
	const text = htmlToText(`<a title="a > b" href="#">link</a>`);
	assert.equal(text, "link");
});

test("unclosed tags do not break the rest", () => {
	const text = htmlToText("<div><p>one<p>two<div>three");
	assert.match(text, /one/);
	assert.match(text, /two/);
	assert.match(text, /three/);
});

test("nesting past the guard still produces text rather than hanging", () => {
	const deep = "<ul><li>".repeat(400) + "x" + "</li></ul>".repeat(400);
	const text = htmlToText(deep);
	assert.match(text, /x/);
});

test("a stray angle bracket is treated as text", () => {
	assert.match(htmlToText("<p>a < b and c > d</p>"), /a < b/);
});

test("empty input is empty output, not a crash", () => {
	assert.equal(htmlToText(""), "");
	assert.equal(htmlToText("   "), "");
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

test("the entities that actually appear are decoded", () => {
	assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e"), 'a & b <c> "d"  e');
	assert.equal(decodeEntities("&mdash; &hellip; &rsquo;"), "— … ’");
});

test("numeric entities are decoded in both bases", () => {
	assert.equal(decodeEntities("&#72;&#105;"), "Hi");
	assert.equal(decodeEntities("&#x4F60;&#x597D;"), "你好");
});

test("an entity that is not one is left alone rather than mangled", () => {
	assert.equal(decodeEntities("&notareal; &#xZZZZ;"), "&notareal; &#xZZZZ;");
});

test("an escaped entity is decoded once, not twice", () => {
	assert.equal(decodeEntities("&amp;lt;b&amp;gt;"), "&lt;b&gt;");
});

test("a full page comes out as something worth reading", () => {
	const text = htmlToText(`
		<!doctype html>
		<html><head><title>x</title><style>b{}</style></head>
		<body>
			<nav><a href="/">Home</a></nav>
			<h1>fs.readFile</h1>
			<p>Reads the entire contents of a file.</p>
			<table><tr><th>Param</th><th>Type</th></tr><tr><td>path</td><td>string</td></tr></table>
			<pre><code>fs.readFile('/etc/hosts', cb);</code></pre>
		</body></html>`);
	assert.match(text, /^# fs\.readFile$/m);
	assert.match(text, /Reads the entire contents/);
	assert.match(text, /\| Param \| Type \|/);
	assert.match(text, /fs\.readFile\('\/etc\/hosts', cb\);/);
	assert.ok(!text.includes("b{}"));
});
