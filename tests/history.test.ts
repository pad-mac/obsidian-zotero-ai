import { describe, expect, it } from "vitest";

import { chatTitle, parseClaudeCodeSession } from "../src/history";

const line = (o: unknown) => JSON.stringify(o);

describe("parseClaudeCodeSession", () => {
	it("keeps questions and answers, drops documents, attachments and Claude Code's own notices", () => {
		const jsonl = [
			line({ type: "queue-operation", operation: "enqueue" }),
			line({ type: "user", message: { role: "user", content: [{ type: "document", source: { type: "base64", data: "x" } }, { type: "text", text: "<document n=\"1\">…</document>" }, { type: "text", text: "What is the argument?" }] } }),
			line({ type: "attachment", attachment: { type: "date" } }),
			line({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "Authentication error" }] } }),
			line({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "It argues " }] } }),
			line({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "text", text: "that [p. 3]." }] } }),
			line({ type: "user", message: { role: "user", content: "And chapter 2?" } }),
			line({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Chapter 2 …" }] } }),
			"not json",
		].join("\n");
		expect(parseClaudeCodeSession(jsonl)).toEqual([
			{ role: "user", text: "What is the argument?" },
			{ role: "assistant", text: "It argues that [p. 3]." },
			{ role: "user", text: "And chapter 2?" },
			{ role: "assistant", text: "Chapter 2 …" },
		]);
	});
});

describe("chatTitle", () => {
	it("uses the first question, shortened", () => {
		expect(chatTitle([{ role: "user", text: "a".repeat(100) }], "x")).toHaveLength(68);
		expect(chatTitle([], "Simondon 1958")).toBe("Simondon 1958");
	});
});
