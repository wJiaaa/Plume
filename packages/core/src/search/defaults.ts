import type { Settings } from "../config/settings.ts";
import { duckDuckGoProvider } from "./duckduckgo.ts";
import { registerSearchProvider } from "./index.ts";
import { instantAnswerProvider } from "./instant.ts";
import {
	BRAVE_PROVIDER_ID,
	DEEPSEEK_PROVIDER_ID,
	EXA_PROVIDER_ID,
	keyedSearchProvider,
	TAVILY_PROVIDER_ID,
} from "./keyed.ts";

/**
 * Search, working out of the box.
 *
 * The keyless provider is registered unconditionally so a fresh install can search at all; the
 * keyed ones read their key at call time, so they become available the moment one is pasted in
 * and stay out of the way until then. Which of them runs is `selectSearchProvider`'s call: the
 * user's pick, or — with none made — a pasted key over the keyless default.
 */
export function registerDefaultSearchProviders(keys: () => Settings["searchApiKeys"]): void {
	registerSearchProvider(duckDuckGoProvider());
	registerSearchProvider(instantAnswerProvider());
	registerSearchProvider(keyedSearchProvider(TAVILY_PROVIDER_ID, () => keys()?.tavily));
	registerSearchProvider(keyedSearchProvider(EXA_PROVIDER_ID, () => keys()?.exa));
	registerSearchProvider(keyedSearchProvider(BRAVE_PROVIDER_ID, () => keys()?.brave));
	registerSearchProvider(keyedSearchProvider(DEEPSEEK_PROVIDER_ID, () => keys()?.deepseek));
}
