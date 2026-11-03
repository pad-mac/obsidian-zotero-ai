/**
 * Chat history: every chat is saved as it goes, one JSON file per chat in
 * the plugin's folder (`.obsidian/plugins/zotero-ai/chats/`), so "New chat"
 * and restarts lose nothing. Also reads back chats that ran through Claude
 * Code before history existed (Claude Code keeps its own session files).
 */
import type { App } from "obsidian";

import type { Usage } from "./anthropic";
import type { Target } from "./documents";

export interface StoredMessage {
	role: "user" | "assistant";
	text: string;
	usage?: Usage;
	error?: string;
}

export interface ChatRecord {
	id: string;
	created: number;
	updated: number;
	title: string;
	model: string;
	docs: { target: Target; mode: "text" | "pdf"; pages: string }[];
	messages: StoredMessage[];
	ccSession: { id: string; contextKey: string } | null;
}

export interface ChatSummary {
	id: string;
	title: string;
	updated: number;
	count: number;
}

export class ChatStore {
	constructor(
		private app: App,
		private dir: string,
	) {}

	private path(id: string) {
		return `${this.dir}/${id}.json`;
	}

	private async ensureDir() {
		if (!(await this.app.vault.adapter.exists(this.dir))) await this.app.vault.adapter.mkdir(this.dir);
	}

	async save(rec: ChatRecord): Promise<void> {
		await this.ensureDir();
		await this.app.vault.adapter.write(this.path(rec.id), JSON.stringify(rec));
	}

	async load(id: string): Promise<ChatRecord | null> {
		try {
			return JSON.parse(await this.app.vault.adapter.read(this.path(id))) as ChatRecord;
		} catch {
			return null;
		}
	}

	async remove(id: string): Promise<void> {
		if (await this.app.vault.adapter.exists(this.path(id))) await this.app.vault.adapter.remove(this.path(id));
	}

	async list(): Promise<ChatSummary[]> {
		if (!(await this.app.vault.adapter.exists(this.dir))) return [];
		const { files } = await this.app.vault.adapter.list(this.dir);
		const out: ChatSummary[] = [];
		for (const f of files.filter((f) => f.endsWith(".json"))) {
			try {
				const rec = JSON.parse(await this.app.vault.adapter.read(f)) as ChatRecord;
				out.push({ id: rec.id, title: rec.title, updated: rec.updated, count: rec.messages.length });
			} catch {
				// a broken file: skip it
			}
		}
		return out.sort((a, b) => b.updated - a.updated);
	}
}

export function newChatId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function chatTitle(messages: StoredMessage[], fallback: string): string {
	const first = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim() ?? "";
	const t = first || fallback || "Chat";
	return t.length > 70 ? `${t.slice(0, 67)}…` : t;
}

/* ---------------------- Claude Code's own session files --------------------- */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const node = () => ({ fs: require("fs") as typeof import("fs"), path: require("path") as typeof import("path"), os: require("os") as typeof import("os") });

export interface CcSessionFile {
	id: string;
	file: string;
	updated: number;
}

/** Sessions this plugin ran through Claude Code (its working folder is named obsidian-zotero-ai). */
export function listClaudeCodeSessions(): CcSessionFile[] {
	const { fs, path, os } = node();
	const root = path.join(os.homedir(), ".claude", "projects");
	const out: CcSessionFile[] = [];
	let dirs: string[] = [];
	try {
		dirs = fs.readdirSync(root).filter((d) => d.includes("obsidian-zotero-ai"));
	} catch {
		return [];
	}
	for (const d of dirs) {
		for (const f of fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".jsonl"))) {
			const file = path.join(root, d, f);
			out.push({ id: f.slice(0, -6), file, updated: fs.statSync(file).mtimeMs });
		}
	}
	return out.sort((a, b) => b.updated - a.updated);
}

/**
 * A Claude Code session file as chat messages. A user turn's question is
 * its last text block (the first turn also carries the documents).
 */
export function parseClaudeCodeSession(jsonl: string): StoredMessage[] {
	const messages: StoredMessage[] = [];
	for (const line of jsonl.split("\n")) {
		let j: { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { role?: string; model?: string; content?: unknown } };
		try {
			j = JSON.parse(line);
		} catch {
			continue;
		}
		if ((j.type !== "user" && j.type !== "assistant") || j.isMeta || j.isSidechain || !j.message) continue;
		// Error notices Claude Code writes itself ("Authentication error …").
		if (j.message.model === "<synthetic>") continue;
		const content = j.message.content;
		const texts =
			typeof content === "string"
				? [content]
				: Array.isArray(content)
					? (content as { type?: string; text?: string }[]).filter((b) => b.type === "text" && b.text).map((b) => b.text!)
					: [];
		if (texts.length === 0) continue;
		if (j.type === "user") {
			messages.push({ role: "user", text: texts[texts.length - 1]! });
		} else {
			const last = messages[messages.length - 1];
			const text = texts.join("");
			if (last?.role === "assistant") last.text += text;
			else messages.push({ role: "assistant", text });
		}
	}
	return messages;
}

export function readClaudeCodeSession(file: string): StoredMessage[] {
	return parseClaudeCodeSession(node().fs.readFileSync(file, "utf8"));
}
