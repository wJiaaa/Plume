import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UsageRequestBucket } from "../electron/usage-scan.ts";
import { barsFor, filterRequests, isHourly, merge, OTHER, rangeBounds, requestsCsv, requestTotals, SERIES_LIMIT, slotsFor, speedOf } from "../src/features/settings/usage-requests.ts";

const NOW = new Date(2026, 9, 20, 15, 0);

function row(over: Partial<UsageRequestBucket> = {}): UsageRequestBucket {
	return { hour: "2026-10-20 10", provider: "relay", model: "m", requests: 1, input: 100, output: 50, cacheRead: 300, cacheWrite: 0, cost: 0.1, unpriced: 0, timed: 1, timedOutput: 50, streamMs: 1000, firstTokens: 1, firstTokenMs: 500, ...over };
}

const ALL = { from: null, to: null, provider: null, query: "" };

describe("request view arithmetic", () => {
	it("today is one day drawn by the hour; seven days ends today", () => {
		const today = rangeBounds("today", NOW, { from: "", to: "" });
		assert.deepEqual(today, { from: "2026-10-20", to: "2026-10-20" });
		assert.equal(isHourly(today), true);
		assert.deepEqual(rangeBounds("7", NOW, { from: "", to: "" }), { from: "2026-10-14", to: "2026-10-20" });
		assert.equal(slotsFor(today, [], NOW).length, 24);
		assert.equal(slotsFor(today, [], NOW)[9], "2026-10-20 09");
	});

	it("a custom range typed back to front is turned around, not empty", () => {
		assert.deepEqual(rangeBounds("custom", NOW, { from: "2026-10-10", to: "2026-10-01" }), { from: "2026-10-01", to: "2026-10-10" });
	});

	it("all time starts at the first day with a record", () => {
		const slots = slotsFor({ from: null, to: null }, [row({ hour: "2026-10-18 23" })], NOW);
		assert.deepEqual(slots, ["2026-10-18", "2026-10-19", "2026-10-20"]);
	});

	it("filters on every dimension and searches what the page calls things", () => {
		const rows = [row(), row({ model: "gpt-6.1", provider: "relay-b" }), row({ hour: "2026-10-01 10" })];
		assert.equal(filterRequests(rows, { ...ALL, from: "2026-10-20", to: "2026-10-20" }, () => "").length, 2);
		assert.equal(filterRequests(rows, { ...ALL, provider: "relay-b" }, () => "").length, 1);
		assert.equal(filterRequests(rows, { ...ALL, query: "GPT" }, (each) => each.model).length, 1);
	});

	it("speed is total output over total streaming time, not an average of speeds", () => {
		const totals = requestTotals([row({ timedOutput: 3, streamMs: 1000 }), row({ timedOutput: 3000, streamMs: 10_000 })]);
		assert.equal(Math.round(speedOf(totals) ?? 0), 273);
		assert.equal(speedOf(requestTotals([row({ timed: 0, timedOutput: 0, streamMs: 0 })])), null, "nothing timed is no speed, not zero");
	});

	it("keeps the biggest series and folds the rest into one", () => {
		const rows = Array.from({ length: SERIES_LIMIT + 3 }, (_, index) => row({ model: `m${index}`, input: 1000 - index }));
		const bars = barsFor(rows, "model", "tokens", ["2026-10-20 10"], true);
		assert.equal(bars.series.length, SERIES_LIMIT + 1);
		assert.equal(bars.series[0].key, "m0");
		assert.equal(bars.series.at(-1)?.key, OTHER);
		assert.equal(bars.series.at(-1)?.totals.requests, 3);
		assert.equal(bars.overall[0].requests, SERIES_LIMIT + 3);
	});

	it("puts each row in its hour or its day", () => {
		const rows = [row({ hour: "2026-10-20 09" }), row({ hour: "2026-10-20 10" }), row({ hour: "2026-10-19 10" })];
		const daily = barsFor(rows, "provider", "requests", ["2026-10-19", "2026-10-20"], false);
		assert.deepEqual(daily.overall.map((each) => each.requests), [1, 2]);
		const hourly = barsFor(rows, "provider", "requests", slotsFor({ from: "2026-10-20", to: "2026-10-20" }, rows, NOW), true);
		assert.equal(hourly.overall[9].requests, 1);
		assert.equal(hourly.overall[10].requests, 1);
		assert.equal(hourly.series[0].totals.requests, 3, "a series' total is the whole range, the slots only what fits on the axis");
	});

	it("cache misses add up cause by cause, including when series are merged", () => {
		const miss = (tokens: number) => ({ tokens, cost: 0.01, unpriced: 0, byCause: { tools: tokens } });
		const totals = requestTotals([row({ cacheMiss: miss(100) }), row(), row({ cacheMiss: miss(50) })]);
		assert.deepEqual(totals.cacheMiss.byCause, { tools: 150 });
		const into = requestTotals([row({ cacheMiss: miss(10) })]);
		merge(into, totals);
		assert.equal(into.cacheMiss.tokens, 160);
		assert.equal(into.requests, 4);
	});

	it("quotes CSV cells that would otherwise split a row", () => {
		const csv = requestsCsv([row({ provider: "p1" })], () => 'Relay, "fast"');
		assert.match(csv.split("\n")[1], /^2026-10-20 10,"Relay, ""fast""",p1,m,1,/);
	});

	for (const [value, cell] of [
		["=1+1", "'=1+1"],
		["+1+1", "'+1+1"],
		["-1+1", "'-1+1"],
		["@SUM(1)", "'@SUM(1)"],
		[" \t=1+1", "' \t=1+1"],
		["\tplain", "'\tplain"],
		["=HYPERLINK(\"https://example.com\",\"open\")", "\"'=HYPERLINK(\"\"https://example.com\"\",\"\"open\"\")\""],
		["\r=1+1", "\"'\r=1+1\""],
		["\n=1+1", "\"'\n=1+1\""],
	]) {
		it(`exports formula-like text as text: ${JSON.stringify(value)}`, () => {
			const csv = requestsCsv([row({ provider: value, model: value })], () => value);
			assert.ok(csv.slice(csv.indexOf("\n") + 1).startsWith(`2026-10-20 10,${cell},${cell},${cell},1,100,50,300,0,0.100000,`), csv);
		});
	}

	it("exports unpriced counts without confusing unknown cost with free usage", () => {
		const csv = requestsCsv([
			row({ model: "free", cost: 0, unpriced: 0 }),
			row({ model: "unknown", cost: 0, unpriced: 1 }),
			row({ model: "mixed", requests: 3, cost: 0.1, unpriced: 2 }),
		], (id) => id);
		const [header, ...lines] = csv.split("\n");
		assert.equal(header, "hour,provider,providerId,model,requests,input,output,cacheRead,cacheWrite,cost,timed,timedOutput,streamMs,firstTokens,firstTokenMs,unpriced");
		assert.deepEqual(lines.map((line) => {
			const cells = line.split(",");
			assert.equal(cells.length, header.split(",").length);
			return [cells[3], cells[4], cells[9], cells.at(-1)];
		}), [
			["free", "1", "0.000000", "0"],
			["mixed", "3", "0.100000", "2"],
			["unknown", "1", "0.000000", "1"],
		]);
	});
});
