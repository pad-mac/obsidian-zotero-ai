/**
 * Claude Code as a backend: runs the `claude` command-line program on this
 * computer (`claude -p`), signed in with the user's Claude plan, so answers
 * count against the plan's usage limits instead of API credits.
 *
 * One process per question. The first question sends the documents; later
 * ones continue the same Claude Code session (`--resume`), whose history
 * holds them, so Claude Code's own prompt caching applies.
 *
 * Claude Code is run with no tools, no MCP servers, no settings files, no
 * slash commands, and its own system prompt replaced by ours: a reader, not
 * an agent. ANTHROPIC_API_KEY is removed from its environment, because with
 * that variable set Claude Code bills the key instead of the plan.
 */
import type { Block, StreamResult, Usage } from "./anthropic";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const node = () => ({
	cp: require("child_process") as typeof import("child_process"),
	fs: require("fs") as typeof import("fs"),
	path: require("path") as typeof import("path"),
	os: require("os") as typeof import("os"),
});

export interface ClaudeCodeRequest {
	/** Setting; empty: look in the usual install places, then PATH. */
	claudePath: string;
	/** "" for Claude Code's default, an alias (sonnet, opus, …) or a full id. */
	model: string;
	system: string;
	content: Block[];
	/** Session to continue. */
	resume?: string;
	signal: AbortSignal;
	onText: (delta: string) => void;
}

export interface ClaudeCodeResult extends StreamResult {
	sessionId: string | null;
}

export class ClaudeCodeError extends Error {}

/** Where the native installer, Homebrew and npm put `claude`. */
export function findClaude(setting: string): string {
	const { fs, path, os } = node();
	const s = setting.trim();
	if (s) return s.startsWith("~") ? path.join(os.homedir(), s.slice(1)) : s;
	const home = os.homedir();
	const win = process.platform === "win32";
	const candidates = win
		? [path.join(home, ".local", "bin", "claude.exe")]
		: [
				path.join(home, ".local", "bin", "claude"),
				path.join(home, ".claude", "local", "claude"),
				"/opt/homebrew/bin/claude",
				"/usr/local/bin/claude",
				"/usr/bin/claude",
			];
	for (const c of candidates) {
		try {
			fs.accessSync(c, fs.constants.X_OK);
			return c;
		} catch {
			// next
		}
	}
	return win ? "claude.exe" : "claude";
}

function workDir(): string {
	const { fs, path, os } = node();
	const dir = path.join(os.tmpdir(), "obsidian-zotero-ai");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Claude Code adds its own cache breakpoints; ours could push it over the API's limit of four. */
function withoutCacheControl(blocks: Block[]): Block[] {
	return blocks.map((b) => {
		const { cache_control: _drop, ...rest } = b;
		return rest as Block;
	});
}

export function claudeArgs(req: Pick<ClaudeCodeRequest, "model" | "system" | "resume">): string[] {
	const args = [
		"-p",
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--tools", "",
		"--strict-mcp-config",
		"--setting-sources", "",
		"--disable-slash-commands",
		"--permission-prompts", "none",
		// Settings changes (length, language, instructions) apply to a running chat too.
		"--system-prompt-snapshot", "off",
		"--system-prompt", req.system,
	];
	if (req.model.trim()) args.push("--model", req.model.trim());
	if (req.resume) args.push("--resume", req.resume);
	return args;
}

export function runClaudeCode(req: ClaudeCodeRequest): Promise<ClaudeCodeResult> {
	const { cp } = node();
	const exe = findClaude(req.claudePath);
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY;

	return new Promise((resolve, reject) => {
		let child: import("child_process").ChildProcessWithoutNullStreams;
		try {
			child = cp.spawn(exe, claudeArgs(req), { cwd: workDir(), env, windowsHide: true });
		} catch (e) {
			return reject(notFound(exe, e as Error));
		}

		const usage: Usage = { input_tokens: 0, output_tokens: 0 };
		let sessionId: string | null = req.resume ?? null;
		let stopReason: string | null = null;
		let streamed = false;
		let errorText: string | null = null;
		let gotResult = false;
		let stdout = "";
		let stderr = "";

		const onAbort = () => child.kill();
		req.signal.addEventListener("abort", onAbort, { once: true });

		const handle = (line: string) => {
			let j: Record<string, any>;
			try {
				j = JSON.parse(line);
			} catch {
				return;
			}
			if (j.session_id) sessionId = j.session_id;
			switch (j.type) {
				case "stream_event": {
					const ev = j.event;
					if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
						streamed = true;
						req.onText(ev.delta.text);
					}
					break;
				}
				case "assistant": {
					const text = ((j.message?.content ?? []) as { type: string; text?: string }[])
						.filter((b) => b.type === "text")
						.map((b) => b.text ?? "")
						.join("");
					if (j.error || j.is_api_error_message) errorText = text || String(j.error);
					else if (!streamed && text) req.onText(text);
					streamed = false;
					break;
				}
				case "result":
					gotResult = true;
					Object.assign(usage, pickUsage(j.usage));
					stopReason = j.stop_reason ?? null;
					if (j.is_error) errorText = errorText ?? String(j.result ?? "Claude Code reported an error");
					break;
			}
		};

		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			let cut: number;
			while ((cut = stdout.indexOf("\n")) >= 0) {
				const line = stdout.slice(0, cut).trim();
				stdout = stdout.slice(cut + 1);
				if (line) handle(line);
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-4000);
		});
		child.on("error", (e) => {
			req.signal.removeEventListener("abort", onAbort);
			reject(notFound(exe, e));
		});
		child.on("close", (code) => {
			req.signal.removeEventListener("abort", onAbort);
			if (stdout.trim()) handle(stdout.trim());
			if (req.signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
			if (errorText) return reject(new ClaudeCodeError(explain(errorText)));
			if (!gotResult) {
				const tail = stderr.trim().split("\n").slice(-3).join(" ");
				return reject(new ClaudeCodeError(explain(tail || `Claude Code exited with code ${code}`)));
			}
			resolve({ usage, stopReason, sessionId });
		});

		const message = { type: "user", message: { role: "user", content: withoutCacheControl(req.content) } };
		child.stdin.on("error", () => undefined); // a process that died early: reported on close
		child.stdin.end(`${JSON.stringify(message)}\n`);
	});
}

/** `claude --version`, for the settings' test button. */
export function claudeVersion(setting: string): Promise<string> {
	const { cp } = node();
	const exe = findClaude(setting);
	return new Promise((resolve, reject) => {
		cp.execFile(exe, ["--version"], { timeout: 20000, windowsHide: true }, (err, stdout) => {
			if (err) return reject(notFound(exe, err));
			resolve(`${stdout.trim()} (${exe})`);
		});
	});
}

function pickUsage(u: Record<string, unknown> | undefined): Partial<Usage> {
	if (!u) return {};
	const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	return {
		input_tokens: n("input_tokens"),
		output_tokens: n("output_tokens"),
		cache_creation_input_tokens: n("cache_creation_input_tokens"),
		cache_read_input_tokens: n("cache_read_input_tokens"),
	};
}

function notFound(exe: string, e: Error): ClaudeCodeError {
	if ((e as NodeJS.ErrnoException).code === "ENOENT") {
		return new ClaudeCodeError(
			`Claude Code was not found ("${exe}"). Install it (PowerShell: irm https://claude.ai/install.ps1 | iex), or set its path in the Zotero AI settings.`,
		);
	}
	return new ClaudeCodeError(`Could not start Claude Code: ${e.message}`);
}

function explain(text: string): string {
	if (/authentication|not logged in|\/login|invalid api key/i.test(text)) {
		return `Claude Code is not signed in. Run "claude" once in a terminal and sign in with your Claude account. (${text})`;
	}
	if (/unknown option|unknown argument/i.test(text)) {
		return `This Claude Code is too old for the plugin. Update it ("claude update"). (${text})`;
	}
	if (/usage limit|rate limit|limit reached/i.test(text)) {
		return `Your plan's usage limit is reached: ${text}`;
	}
	return text;
}
