import type {
	ApiFormat,
	AssistantMessage,
	LlmContext,
	ModelConfig,
	Provider,
	ProviderConfig,
	RequestOptions,
	StreamEvent,
} from "../types.ts";
import { anthropicMessagesProvider } from "./anthropic-messages.ts";
import { openaiResponsesProvider } from "./openai-responses.ts";
import { openaiChatCompletionsProvider } from "./openai-chat-completions.ts";

/** The adapters the app speaks. A bound registry is asked first; see `useLlmRegistry`. */
const BUILT_IN: Record<ApiFormat, Provider> = {
	"anthropic-messages": anthropicMessagesProvider,
	"openai-responses": openaiResponsesProvider,
	"openai-chat-completions": openaiChatCompletionsProvider,
};

/** What provider lookup asks before falling back to the built-in adapters. */
export interface LlmRegistry {
	get(api: string): Provider | undefined;
}

let registry: LlmRegistry | null = null;

/**
 * Put a registry in front of the built-in adapters.
 *
 * Deliberately a binding rather than a parameter threaded through every call site: the adapter
 * in use is a property of the running process, and passing it down through the agent loop,
 * compaction and every tool that streams would say otherwise. Neither host binds one; the seam is
 * for tests and scripts, and for whatever per-session injection replaces it (ADR-0054).
 */
export function useLlmRegistry(next: LlmRegistry | null): void {
	registry = next;
}

function getProvider(api: ApiFormat): Provider {
	const provider = registry?.get(api) ?? BUILT_IN[api];
	if (!provider) throw new Error(`Unsupported API format: ${api}`);
	return provider;
}

/** Stream one assistant turn. Yields incremental events and returns the final message. */
export function streamAssistant(
	providerConfig: ProviderConfig,
	model: ModelConfig,
	context: LlmContext,
	options: RequestOptions = {},
): AsyncGenerator<StreamEvent, AssistantMessage> {
	return getProvider(providerConfig.api).stream(providerConfig, model, context, options);
}
