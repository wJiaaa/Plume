/**
 * Turning a fetched page into something worth spending tokens on.
 *
 * The previous version was a stack of `replace` calls that deleted every tag and collapsed the
 * whitespace. It never crashed, and it quietly destroyed the three things a model most often needs
 * from a page: a table became a run of words with no rows, a nested list lost its nesting, and a
 * code block lost its line breaks — so a documentation page arrived as prose where the API
 * signature used to be.
 *
 * This walks the markup instead, keeping the structure that carries meaning and dropping the
 * structure that carries styling. No DOM library: a fetched page is untrusted input and a parser
 * is the wrong place to add ten megabytes of dependency, so this is a small tokenizer with a
 * bounded stack. Anything it cannot make sense of degrades to text rather than throwing — a page
 * that renders badly is worth more than an error.
 */

import { decodeEntities } from "../utils/entities.ts";

/**
 * How deep nesting is tracked before it stops mattering.
 *
 * A page nested past this is either generated or hostile, and the depth is no longer information —
 * the guard is what keeps a pathological input from turning into a pathological amount of work.
 */
const MAX_DEPTH = 64;

/** Elements whose entire contents are noise: markup for the browser, not content for a reader. */
const DROP = new Set(["script", "style", "noscript", "svg", "canvas", "template", "iframe", "object", "embed"]);

/** Elements that start a new line without a blank one. */
const LINE_BREAK = new Set(["br", "tr", "li", "dt", "dd"]);

/** Elements that deserve a blank line around them. */
const BLOCK = new Set([
	"p", "div", "section", "article", "header", "footer", "main", "aside", "nav",
	"h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol", "dl", "form", "figure", "hr",
]);

interface Token {
	kind: "open" | "close" | "text";
	name?: string;
	text?: string;
	attrs?: string;
}

/**
 * Split markup into tags and text.
 *
 * Deliberately not a validating parser. Unclosed tags, stray `<`, and attributes containing `>`
 * inside quotes all appear in real pages, and the reasonable response to each is to keep going.
 */
function* tokenize(html: string): Generator<Token> {
	let index = 0;
	while (index < html.length) {
		const next = html.indexOf("<", index);
		if (next === -1) {
			yield { kind: "text", text: html.slice(index) };
			return;
		}
		if (next > index) yield { kind: "text", text: html.slice(index, next) };

		/*
		 * A `<` only opens a tag when the next character could start one.
		 *
		 * Prose contains comparisons — `a < b`, `if (x<y)` — and treating those as tags swallows
		 * everything up to the next `>`, taking the sentence with it. This is the same rule a
		 * browser applies, and it is the difference between reading a page and reading half of one.
		 */
		if (!/[a-zA-Z/!]/.test(html[next + 1] ?? "")) {
			yield { kind: "text", text: "<" };
			index = next + 1;
			continue;
		}

		// Comments and doctypes carry nothing.
		if (html.startsWith("<!--", next)) {
			const end = html.indexOf("-->", next);
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith("<!", next)) {
			const end = html.indexOf(">", next);
			index = end === -1 ? html.length : end + 1;
			continue;
		}

		// Find the tag's end, skipping any `>` that sits inside a quoted attribute.
		let cursor = next + 1;
		let quote: string | null = null;
		while (cursor < html.length) {
			const char = html[cursor];
			if (quote) {
				if (char === quote) quote = null;
			} else if (char === '"' || char === "'") {
				quote = char;
			} else if (char === ">") {
				break;
			}
			cursor++;
		}
		if (cursor >= html.length) {
			yield { kind: "text", text: html.slice(next) };
			return;
		}

		const raw = html.slice(next + 1, cursor).trim();
		index = cursor + 1;
		if (!raw) continue;

		const closing = raw.startsWith("/");
		const body = closing ? raw.slice(1) : raw;
		const space = body.search(/[\s/]/);
		const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
		if (!/^[a-z][a-z0-9-]*$/.test(name)) continue;

		yield closing
			? { kind: "close", name }
			: { kind: "open", name, attrs: space === -1 ? "" : body.slice(space) };
	}
}

/** One entry on the list stack: what kind, and how many items have been emitted. */
interface ListFrame {
	ordered: boolean;
	count: number;
}

/**
 * Render a page as readable text, keeping tables, lists and code.
 *
 * The output is markdown-ish rather than strict markdown. A model reads it either way, and
 * chasing strictness would mean escaping content that a reader is better off seeing verbatim.
 */
export function htmlToText(html: string): string {
	let out = "";
	/** Inside `<pre>`, whitespace is content: it is the only thing holding the code together. */
	let preDepth = 0;
	let inTable = false;
	/** Cells of the row being built, so a table comes out as rows rather than as a word soup. */
	let row: string[] = [];
	let cell: string | null = null;
	let headerPending = false;
	const lists: ListFrame[] = [];
	/** Set while inside an element whose contents are dropped wholesale. */
	let dropping: string | null = null;

	const write = (text: string) => {
		if (cell !== null) cell += text;
		else out += text;
	};
	const newline = () => {
		if (cell !== null) return;
		if (!out.endsWith("\n")) out += "\n";
	};
	const blankLine = () => {
		if (cell !== null) return;
		out = out.replace(/[ \t]+$/, "");
		if (out && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
	};

	for (const token of tokenize(html)) {
		if (dropping) {
			if (token.kind === "close" && token.name === dropping) dropping = null;
			continue;
		}

		if (token.kind === "text") {
			const decoded = decodeEntities(token.text ?? "");
			if (preDepth > 0) write(decoded);
			else if (decoded.trim()) write(decoded.replace(/\s+/g, " "));
			else if (decoded && !out.endsWith(" ") && cell === null) write(" ");
			continue;
		}

		const name = token.name!;
		if (token.kind === "open") {
			if (DROP.has(name)) {
				dropping = name;
				continue;
			}
			switch (name) {
				case "pre":
					blankLine();
					write("```\n");
					preDepth++;
					break;
				case "code":
					if (preDepth === 0) write("`");
					break;
				case "ul":
				case "ol":
					if (lists.length < MAX_DEPTH) lists.push({ ordered: name === "ol", count: 0 });
					blankLine();
					break;
				case "li": {
					newline();
					const frame = lists.at(-1);
					const indent = "  ".repeat(Math.max(0, lists.length - 1));
					if (frame) {
						frame.count++;
						write(`${indent}${frame.ordered ? `${frame.count}. ` : "- "}`);
					} else {
						write("- ");
					}
					break;
				}
				case "table":
					blankLine();
					inTable = true;
					headerPending = true;
					break;
				case "tr":
					row = [];
					break;
				case "th":
				case "td":
					cell = "";
					break;
				case "blockquote":
					blankLine();
					write("> ");
					break;
				case "hr":
					blankLine();
					write("---");
					blankLine();
					break;
				case "br":
					newline();
					break;
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					blankLine();
					write(`${"#".repeat(Number(name[1]))} `);
					break;
				default:
					if (BLOCK.has(name)) blankLine();
					else if (LINE_BREAK.has(name)) newline();
			}
			continue;
		}

		// Closing.
		switch (name) {
			case "pre":
				preDepth = Math.max(0, preDepth - 1);
				if (!out.endsWith("\n")) out += "\n";
				write("```");
				blankLine();
				break;
			case "code":
				if (preDepth === 0) write("`");
				break;
			case "ul":
			case "ol":
				lists.pop();
				blankLine();
				break;
			case "th":
			case "td":
				row.push((cell ?? "").trim());
				cell = null;
				break;
			case "tr":
				if (inTable && row.length > 0) {
					newline();
					out += `| ${row.join(" | ")} |`;
					newline();
					if (headerPending) {
						// The separator is what makes the first row a header rather than the first line
						// of the body — without it every table reads as headerless.
						out += `|${row.map(() => " --- ").join("|")}|`;
						newline();
						headerPending = false;
					}
				}
				row = [];
				break;
			case "table":
				inTable = false;
				headerPending = false;
				blankLine();
				break;
			default:
				if (BLOCK.has(name)) blankLine();
				else if (LINE_BREAK.has(name)) newline();
		}
	}

	return out
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		// Anchored on a non-space so leading indentation survives: it is what carries list nesting,
		// and collapsing it flattens every nested list back to one level.
		.replace(/(\S)[ \t]{2,}/g, "$1 ")
		.trim();
}
