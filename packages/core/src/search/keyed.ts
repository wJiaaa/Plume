/**
 * The providers that want an API key, and give better answers for it.
 *
 * Each is a search service built for programs rather than browsers: it returns structured
 * results with snippets already extracted, it does not rate-limit a normal session, and its
 * markup cannot change under us because there is no markup. The cost is an account.
 *
 * They are written against the same shape because the differences between them are two field
 * names and an auth header. Anything more elaborate would be an abstraction over two things.
 */

import { SearchError, type SearchProvider, type SearchRequest, type SearchResult, type SearchSource } from "./index.ts";

export const TAVILY_PROVIDER_ID = "tavily";
export const EXA_PROVIDER_ID = "exa";
export const BRAVE_PROVIDER_ID = "brave";
export const DEEPSEEK_PROVIDER_ID = "deepseek";

/**
 * How a service takes its request: some want a POST body, Brave wants a GET query string.
 *
 * Modelled rather than special-cased because the difference is one field and pretending it is not
 * there would mean a second code path for one provider.
 */
type Transport = "post" | "get";

interface KeyedSpec {
	/** Defaults to POST; Brave is the one that reads its query out of the URL. */
	transport?: Transport;
	id: string;
	name: string;
	endpoint: string;
	/** How the key rides on the request; the two services disagree. */
	auth: (key: string) => Record<string, string>;
	body: (request: SearchRequest) => unknown;
	/** Pull the portable shape out of whatever the service returns. */
	parse: (payload: unknown) => SearchResult;
}

const SPECS: Record<string, KeyedSpec> = {
	[TAVILY_PROVIDER_ID]: {
		id: TAVILY_PROVIDER_ID,
		name: "Tavily",
		endpoint: "https://api.tavily.com/search",
		auth: (key) => ({ authorization: `Bearer ${key}` }),
		body: (request) => ({
			query: request.query,
			max_results: request.maxResults ?? 8,
			// Tavily can write an answer as well as return results; when it does, it is worth more
			// to the model than the first snippet.
			include_answer: true,
		}),
		parse: (payload) => {
			const data = payload as { answer?: string; results?: { url?: string; title?: string; content?: string }[] };
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					...(item.content ? { snippet: item.content } : {}),
				});
			}
			return { ...(data.answer ? { content: data.answer } : {}), sources, truncated: false };
		},
	},
	[EXA_PROVIDER_ID]: {
		id: EXA_PROVIDER_ID,
		name: "Exa",
		endpoint: "https://api.exa.ai/search",
		auth: (key) => ({ "x-api-key": key }),
		body: (request) => ({
			query: request.query,
			numResults: request.maxResults ?? 8,
			type: "auto",
			contents: { highlights: { numSentences: 1 } },
		}),
		parse: (payload) => {
			const data = payload as {
				results?: { url?: string; title?: string; highlights?: string[]; publishedDate?: string }[];
			};
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				// A result with no highlight has no portable snippet, and there is no other field to
				// derive one from. Dropped rather than returned empty: inventing one would lie.
				const snippet = item.highlights?.find((h) => h.trim().length > 0);
				if (!snippet) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					snippet: snippet.trim(),
					...(item.publishedDate ? { publishedAt: item.publishedDate } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
	[BRAVE_PROVIDER_ID]: {
		id: BRAVE_PROVIDER_ID,
		name: "Brave Search",
		endpoint: "https://api.search.brave.com/res/v1/web/search",
		transport: "get",
		auth: (key) => ({ "x-subscription-token": key, accept: "application/json" }),
		body: (request) => ({ q: request.query, count: String(request.maxResults ?? 8) }),
		parse: (payload) => {
			const data = payload as { web?: { results?: { url?: string; title?: string; description?: string; age?: string }[] } };
			const sources: SearchSource[] = [];
			for (const item of data.web?.results ?? []) {
				if (!item.url) continue;
				sources.push({
					url: item.url,
					...(item.title ? { title: stripHighlightMarkers(item.title) } : {}),
					...(item.description ? { snippet: stripHighlightMarkers(item.description) } : {}),
					...(item.age ? { publishedAt: item.age } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
	[DEEPSEEK_PROVIDER_ID]: {
		id: DEEPSEEK_PROVIDER_ID,
		name: "DeepSeek",
		endpoint: "https://api.deepseek.com/v1/tools/search",
		auth: (key) => ({ authorization: `Bearer ${key}` }),
		body: (request) => ({
			query: request.query,
			count: request.maxResults ?? 8,
			// `need_content` stays at its default: eight full pages per search is a page of context
			// the model did not ask for, and `summary` below is the field meant for it to read.
		}),
		parse: (payload) => {
			const data = payload as {
				results?: { url?: string; title?: string; snippet?: string; summary?: string; date?: string }[];
			};
			const sources: SearchSource[] = [];
			for (const item of data.results ?? []) {
				if (!item.url) continue;
				// `summary` is the 600–800 character version written for a model; `snippet` is the
				// 100–200 character one written for a UI. The model gets the longer one when both
				// exist, because a short snippet is usually where a useful answer stops.
				const snippet = item.summary?.trim() || item.snippet?.trim();
				sources.push({
					url: item.url,
					...(item.title ? { title: item.title } : {}),
					...(snippet ? { snippet } : {}),
					...(item.date ? { publishedAt: item.date } : {}),
				});
			}
			return { sources, truncated: false };
		},
	},
};

/**
 * Brave wraps matched terms in `<strong>` so a browser can bold them.
 *
 * A model reading `the <strong>fs</strong> module` sees markup it has to look past, and might
 * reasonably echo it back. The emphasis carries nothing the surrounding words do not.
 */
function stripHighlightMarkers(text: string): string {
	return text.replace(/<\/?(?:strong|b|em)>/gi, "");
}

/**
 * One keyed provider, reading its key from wherever the caller keeps keys.
 *
 * `readKey` is a function rather than a string so `available()` reflects the key as it is *now* —
 * somebody pasting one into settings should not have to restart the app for search to start
 * working.
 */
export function keyedSearchProvider(id: string, readKey: () => string | undefined, fetchImpl: typeof fetch = fetch): SearchProvider {
	const spec = SPECS[id];
	if (!spec) throw new SearchError(`未知的搜索提供方 ${id}`, "SEARCH_PROVIDER_MISSING");

	return {
		id: spec.id,
		name: spec.name,
		// Local check only: does a key exist. Asking the service would put an HTTP round trip in
		// front of every provider selection.
		available: () => Boolean(readKey()?.trim()),
		async search(request: SearchRequest): Promise<SearchResult> {
			const key = readKey()?.trim();
			if (!key) throw new SearchError(`${spec.name} 没有配置 API key`, "SEARCH_PROVIDER_UNAVAILABLE");

			let response: Response;
			try {
				response =
					spec.transport === "get"
						? await fetchImpl(`${spec.endpoint}?${new URLSearchParams(spec.body(request) as Record<string, string>)}`, {
								method: "GET",
								signal: request.signal,
								headers: spec.auth(key),
							})
						: await fetchImpl(spec.endpoint, {
								method: "POST",
								signal: request.signal,
								headers: { "content-type": "application/json", ...spec.auth(key) },
								body: JSON.stringify(spec.body(request)),
							});
			} catch (error) {
				throw new SearchError(`${spec.name} 请求失败`, "SEARCH_PROVIDER_ERROR", { cause: error });
			}

			if (response.status === 401 || response.status === 403) {
				throw new SearchError(`${spec.name} 拒绝了这个 API key`, "SEARCH_PROVIDER_UNAUTHORIZED");
			}
			if (response.status === 429) throw new SearchError(`${spec.name} 限流了`, "SEARCH_RATE_LIMITED");
			if (!response.ok) throw new SearchError(`${spec.name} 返回 HTTP ${response.status}`, "SEARCH_PROVIDER_ERROR");

			try {
				return spec.parse(await response.json());
			} catch (error) {
				throw new SearchError(`${spec.name} 的返回读不懂`, "SEARCH_PROVIDER_ERROR", { cause: error });
			}
		},
	};
}
