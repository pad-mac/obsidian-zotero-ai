import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { ClaudeCodeError, claudeArgs, runClaudeCode } from "../src/claude-code";

/** A stand-in `claude` that answers in Claude Code's stream-json format. */
function fakeClaude(behaviour: "ok" | "auth" | "crash"): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
	const file = join(dir, "claude");
	writeFileSync(
		file,
		`#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
	const msg = JSON.parse(input.trim());
	const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
	const sid = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "sess-1";
	if (${JSON.stringify(behaviour)} === "crash") { process.stderr.write("error: unknown option '--permission-prompts'\\n"); process.exit(1); }
	out({ type: "system", subtype: "init", session_id: sid });
	if (${JSON.stringify(behaviour)} === "auth") {
		out({ type: "assistant", message: { content: [{ type: "text", text: "Authentication error · please run /login" }] }, error: "authentication_failed", is_api_error_message: true, session_id: sid });
		out({ type: "result", is_error: true, result: "Authentication error · please run /login", session_id: sid, usage: {} });
		return;
	}
	const echo = JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY ?? null, blocks: msg.message.content.length, cache: msg.message.content.some((b) => b.cache_control), args: process.argv.slice(2) });
	for (const t of ["Hal", "lo "]) out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } }, session_id: sid });
	out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: echo } }, session_id: sid });
	out({ type: "assistant", message: { content: [{ type: "text", text: "Hallo " + echo }] }, session_id: sid });
	process.stdout.write(JSON.stringify({ type: "result", is_error: false, session_id: sid, stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 900 } }));
});
`,
	);
	chmodSync(file, 0o755);
	return file;
}

const base = { model: "sonnet", system: "Be a reader.", signal: new AbortController().signal };

describe("Claude Code backend", () => {
	it("passes no tools, our system prompt, and the model", () => {
		const args = claudeArgs({ ...base, resume: "abc" });
		expect(args.slice(0, 5)).toEqual(["-p", "--input-format", "stream-json", "--output-format", "stream-json"]);
		expect(args[args.indexOf("--tools") + 1]).toBe("");
		expect(args[args.indexOf("--system-prompt") + 1]).toBe("Be a reader.");
		expect(args.slice(-4)).toEqual(["--model", "sonnet", "--resume", "abc"]);
	});

	it("streams text once (no duplicate from the full message), drops the API key and cache marks", async () => {
		process.env.ANTHROPIC_API_KEY = "should-not-pass";
		let text = "";
		const res = await runClaudeCode({
			...base,
			claudePath: fakeClaude("ok"),
			content: [{ type: "text", text: "doc", cache_control: { type: "ephemeral" } }, { type: "text", text: "q" }],
			onText: (d) => (text += d),
		});
		delete process.env.ANTHROPIC_API_KEY;
		expect(text.startsWith("Hallo ")).toBe(true);
		const echo = JSON.parse(text.slice(6));
		expect(echo).toMatchObject({ apiKey: null, blocks: 2, cache: false });
		expect(res.sessionId).toBe("sess-1");
		expect(res.usage).toMatchObject({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 900 });
	});

	it("continues a session", async () => {
		const res = await runClaudeCode({ ...base, resume: "sess-9", claudePath: fakeClaude("ok"), content: [{ type: "text", text: "q" }], onText: () => {} });
		expect(res.sessionId).toBe("sess-9");
	});

	it("explains sign-in, old versions and a missing program", async () => {
		const run = (claudePath: string) => runClaudeCode({ ...base, claudePath, content: [{ type: "text", text: "q" }], onText: () => {} });
		await expect(run(fakeClaude("auth"))).rejects.toThrow(/not signed in/);
		await expect(run(fakeClaude("crash"))).rejects.toThrow(/too old/);
		await expect(run("/nonexistent/claude")).rejects.toBeInstanceOf(ClaudeCodeError);
	});
});
