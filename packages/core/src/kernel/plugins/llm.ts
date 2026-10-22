import { anthropicMessagesProvider } from "../../ai/anthropic-messages.ts";
import { openaiResponsesProvider } from "../../ai/openai-responses.ts";
import { openaiChatCompletionsProvider } from "../../ai/openai-chat-completions.ts";
import type { Provider } from "../../types.ts";
import type { Context, Plugin } from "../context.ts";
import { LLM, type LlmRegistry } from "../services.ts";

/**
 * The model adapters, as a registry rather than a switch statement.
 *
 * Adding an API used to mean editing the function that picks one. Here an adapter is contributed
 * by whoever has it, which is what makes a private or experimental API possible without a fork:
 * register under a new key and select it in configuration.
 */
class Registry implements LlmRegistry {
	private readonly adapters = new Map<string, Provider>();

	register(api: string, provider: Provider): () => void {
		this.adapters.set(api, provider);
		return () => {
			if (this.adapters.get(api) === provider) this.adapters.delete(api);
		};
	}

	get(api: string): Provider | undefined {
		return this.adapters.get(api);
	}
}

/** The APIs the app speaks out of the box. */
export const llmPlugin: Plugin = {
	name: "llm",
	apply(ctx: Context) {
		const registry = new Registry();
		const withdraw = ctx.provide<LlmRegistry>(LLM, registry);

		const adapters = [
			registry.register(openaiResponsesProvider.api, openaiResponsesProvider),
			registry.register(openaiChatCompletionsProvider.api, openaiChatCompletionsProvider),
			registry.register(anthropicMessagesProvider.api, anthropicMessagesProvider),
		];

		return () => {
			for (const remove of adapters) remove();
			withdraw();
		};
	},
};
