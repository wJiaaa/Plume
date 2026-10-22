/**
 * HTML and XML character references, decoded in one pass.
 *
 * One pass matters: decoding `&amp;` first and `&lt;` after turns the literal text `&amp;lt;` into
 * `<`, which is what the search results' own copy of this used to do. Named entities are the ones
 * that actually turn up; numeric ones are all decoded.
 */
export function decodeEntities(text: string): string {
	const named: Record<string, string> = {
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
		hellip: "…", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", middot: "·",
	};
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === "#") {
			const value = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
		}
		return named[code.toLowerCase()] ?? whole;
	});
}
