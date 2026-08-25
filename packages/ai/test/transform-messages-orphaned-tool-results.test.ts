import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model } from "../src/types.js";

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.5",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeAbortedAssistantMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "ls" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.5",
		usage: makeUsage(),
		stopReason: "aborted",
		timestamp: Date.now(),
	};
}

describe("transformMessages orphaned tool results (#984)", () => {
	it("drops a toolResult whose parent tool call was aborted", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			makeAbortedAssistantMessage("call_1"),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "partial output" }],
				isError: false,
				timestamp: Date.now(),
			},
			{ role: "user", content: "please continue", timestamp: Date.now() },
		];

		const result = transformMessages(messages, model);

		expect(result.find((m) => m.role === "toolResult" && m.toolCallId === "call_1")).toBeUndefined();
		expect(result.find((m) => m.role === "assistant")).toBeUndefined();
	});

	it("drops a toolResult whose parent tool call errored", () => {
		const model = makeModel();
		const erroredAssistant: AssistantMessage = { ...makeAbortedAssistantMessage("call_2"), stopReason: "error" };
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			erroredAssistant,
			{
				role: "toolResult",
				toolCallId: "call_2",
				toolName: "bash",
				content: [{ type: "text", text: "server error" }],
				isError: true,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model);

		expect(result.find((m) => m.role === "toolResult" && m.toolCallId === "call_2")).toBeUndefined();
	});

	it("still keeps toolResults that pair with a surviving assistant tool call", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_3", name: "bash", arguments: { command: "pwd" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4.5",
				usage: makeUsage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_3",
				toolName: "bash",
				content: [{ type: "text", text: "/home" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model);

		expect(result.find((m) => m.role === "toolResult" && m.toolCallId === "call_3")).toBeDefined();
	});

	it("does not let an aborted turn's orphan set swallow a later reused id", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "first", timestamp: Date.now() },
			makeAbortedAssistantMessage("call_4"),
			{ role: "user", content: "retry", timestamp: Date.now() },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call_4", name: "bash", arguments: { command: "pwd" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4.5",
				usage: makeUsage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "call_4",
				toolName: "bash",
				content: [{ type: "text", text: "/home" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model);
		const survivingResult = result.find((m) => m.role === "toolResult" && m.toolCallId === "call_4");

		expect(survivingResult).toMatchObject({ content: [{ type: "text", text: "/home" }] });
	});
});
