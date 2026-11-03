import {
	ItemView,
	MarkdownRenderer,
	Menu,
	Modal,
	Notice,
	normalizePath,
	setIcon,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { PDFDocument } from "pdf-lib";

import { ApiError, streamMessage, toBase64, type ApiMessage, type Block, type Usage } from "./anthropic";
import { ClaudeCodeError, runClaudeCode } from "./claude-code";
import { CC_MODELS } from "./settings";
import { loadDocument, targetId, type LoadedDocument, type Target } from "./documents";
import type ZoteroAiPlugin from "./main";
import { ItemPicker } from "./picker";
import { documentText, estimateTokens, labelRuns, linkCitations, selectPages, type LinkTarget } from "./text";

export const CHAT_VIEW = "zotero-ai-chat";

interface ContextDoc {
	target: Target;
	doc: LoadedDocument | null;
	loading: string | null;
	error: string | null;
	mode: "text" | "pdf";
	pages: string;
	/** Attached because it was active, not by the user. */
	auto: boolean;
}

interface ChatMessage {
	role: "user" | "assistant";
	text: string;
	usage?: Usage;
	error?: string;
}

const QUICK = [
	{ label: "Summarize", prompt: "Summarize this text: its question, main argument and structure, chapter by chapter where there are chapters, with page references." },
	{ label: "Argument", prompt: "Reconstruct the central argument step by step: claims, evidence, and the positions it argues against. Cite pages." },
	{ label: "Key concepts", prompt: "List and explain the key concepts and terms as the author uses them, with the pages where they are introduced or defined." },
	{ label: "My annotations", prompt: "Go through my annotations: group them by theme, say what they suggest I was interested in, and point out important passages I did not mark." },
];

export class ChatView extends ItemView {
	private docs: ContextDoc[] = [];
	private messages: ChatMessage[] = [];
	/** "api:<model id>" or "cc:<alias or id>" ("cc:" alone: Claude Code's default). */
	private model: string;
	/** The Claude Code session of this chat, and the documents it was given. */
	private ccSession: { id: string; contextKey: string } | null = null;
	private abort: AbortController | null = null;

	private contextEl!: HTMLElement;
	private listEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private modelSelect!: HTMLSelectElement;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: ZoteroAiPlugin,
	) {
		super(leaf);
		const s = plugin.settings;
		this.model = s.backend === "claude-code" ? `cc:${s.ccModel}` : `api:${s.model}`;
	}

	getViewType() {
		return CHAT_VIEW;
	}
	getDisplayText() {
		return "Zotero AI";
	}
	getIcon() {
		return "sparkles";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("zai");

		const head = root.createDiv("zai-head");
		this.modelSelect = head.createEl("select", { cls: "dropdown zai-model" });
		this.fillModels();
		this.modelSelect.onchange = () => (this.model = this.modelSelect.value);
		head.createDiv("zai-spacer");
		this.iconButton(head, "file-down", "Save chat as note", () => void this.saveAsNote());
		this.iconButton(head, "square-pen", "New chat", () => this.newChat());

		this.contextEl = root.createDiv("zai-context");
		this.listEl = root.createDiv("zai-list");
		this.listEl.addEventListener("click", (e) => this.onLinkClick(e));

		const composer = root.createDiv("zai-composer");
		this.statusEl = composer.createDiv("zai-status");
		const row = composer.createDiv("zai-input-row");
		this.inputEl = row.createEl("textarea", {
			cls: "zai-input",
			attr: { rows: "1", placeholder: "Ask about the attached documents…" },
		});
		this.inputEl.addEventListener("input", () => this.autosize());
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				void this.send();
			}
		});
		this.sendBtn = row.createEl("button", { cls: "zai-send clickable-icon", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "arrow-up");
		this.sendBtn.onclick = () => (this.abort ? this.stop() : void this.send());

		this.renderContext();
		this.renderMessages();
		if (this.plugin.settings.followActive) void this.followActive();
	}

	async onClose() {
		this.stop();
	}

	focusInput() {
		window.setTimeout(() => this.inputEl?.focus(), 0);
	}

	fillModels() {
		if (!this.modelSelect) return;
		this.modelSelect.empty();
		const s = this.plugin.settings;
		const api = this.modelSelect.createEl("optgroup", { attr: { label: "API key" } });
		for (const m of new Set([...s.models, s.model])) api.createEl("option", { text: m, value: `api:${m}` });
		const cc = this.modelSelect.createEl("optgroup", { attr: { label: "Claude Code (subscription)" } });
		for (const m of new Set([...CC_MODELS, s.ccModel])) cc.createEl("option", { text: m ? `Claude Code · ${m}` : "Claude Code · default", value: `cc:${m}` });
		if (![...this.modelSelect.options].some((o) => o.value === this.model)) {
			const [kind, id] = splitChoice(this.model);
			(kind === "api" ? api : cc).createEl("option", { text: id, value: this.model });
		}
		this.modelSelect.value = this.model;
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void) {
		const b = parent.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.onclick = onClick;
		return b;
	}

	private autosize() {
		this.inputEl.style.height = "auto";
		this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 220)}px`;
	}

	/* ------------------------------ context ------------------------------ */

	/** Attach a document (no-op if it is attached already). */
	async attach(target: Target, auto = false) {
		const id = targetId(target);
		if (this.docs.some((d) => targetId(d.target) === id || d.doc?.id === id)) return;
		const entry: ContextDoc = {
			target,
			doc: null,
			loading: "Loading…",
			error: null,
			mode: this.plugin.settings.defaultMode,
			pages: "",
			auto,
		};
		this.docs.push(entry);
		this.renderContext();
		try {
			entry.doc = await loadDocument(this.app, target, this.plugin.settings, (msg) => {
				entry.loading = msg;
				this.renderContext();
			});
			// The same file reached through its parent item and through itself.
			if (this.docs.some((d) => d !== entry && d.doc?.id === entry.doc?.id)) {
				this.docs.remove(entry);
			} else if (entry.doc.looksScanned && entry.doc.bytes) {
				entry.mode = "pdf";
			}
		} catch (e) {
			entry.error = (e as Error).message;
		}
		entry.loading = null;
		this.renderContext();
	}

	/** The active reader / source note's item, for an empty chat. */
	async followActive() {
		if (this.messages.length > 0) return;
		const target = this.plugin.activeTarget();
		if (!target) return;
		const id = targetId(target);
		if (this.docs.some((d) => targetId(d.target) === id)) return;
		if (this.docs.some((d) => !d.auto)) return;
		this.docs = this.docs.filter((d) => !d.auto);
		await this.attach(target, true);
	}

	private renderContext() {
		const el = this.contextEl;
		if (!el) return;
		el.empty();
		for (const d of this.docs) {
			const chip = el.createDiv("zai-chip");
			if (d.error) chip.addClass("is-error");
			const top = chip.createDiv("zai-chip-top");
			const icon = top.createSpan("zai-chip-icon");
			setIcon(icon, d.doc?.kind === "pdf" ? "file-text" : "book-open");
			top.createSpan({ cls: "zai-chip-title", text: d.doc?.title ?? (d.target.kind === "vault" ? d.target.path : "Zotero item") });
			const x = top.createSpan({ cls: "zai-chip-x clickable-icon", attr: { "aria-label": "Remove" } });
			setIcon(x, "x");
			x.onclick = () => {
				this.docs.remove(d);
				this.renderContext();
			};
			const meta = chip.createDiv("zai-chip-meta");
			if (d.loading) {
				meta.setText(d.loading);
				continue;
			}
			if (d.error || !d.doc) {
				meta.setText(d.error ?? "Could not load");
				continue;
			}
			const doc = d.doc;
			const chosen = selectPages(doc.pages, d.pages);
			const chars = chosen.reduce((n, p) => n + p.text.length, 0);
			const pageInfo = doc.pages.length > 1 ? `${chosen.length}/${doc.pages.length} pp` : "";
			const tok = d.mode === "text" ? `~${fmtK(estimateTokens(chars))} tokens` : "PDF (text + page images)";
			const annos = doc.annotations.length ? `${doc.annotations.length} annotations` : "";
			meta.setText([pageInfo, tok, annos].filter(Boolean).join(" · "));

			const controls = chip.createDiv("zai-chip-controls");
			if (doc.bytes && doc.kind === "pdf") {
				const seg = controls.createDiv("zai-seg");
				for (const m of ["text", "pdf"] as const) {
					const b = seg.createEl("button", { text: m === "text" ? "Text" : "PDF" });
					if (d.mode === m) b.addClass("is-active");
					b.onclick = () => {
						d.mode = m;
						this.renderContext();
					};
				}
			}
			if (doc.pages.length > 1) {
				const input = controls.createEl("input", {
					cls: "zai-pages",
					attr: { type: "text", placeholder: "Pages, e.g. 12–40", spellcheck: "false" },
				});
				input.value = d.pages;
				input.onchange = () => {
					d.pages = input.value;
					this.renderContext();
				};
			}
			if (doc.warning) chip.createDiv({ cls: "zai-chip-warn", text: doc.warning });
			else if (doc.looksScanned) chip.createDiv({ cls: "zai-chip-warn", text: "Little or no text layer (a scan?): sent as PDF so Claude reads the page images." });
		}

		const actions = el.createDiv("zai-context-actions");
		const add = actions.createEl("button", { cls: "zai-link-btn" });
		setIcon(add.createSpan(), "plus");
		add.createSpan({ text: "Add from Zotero" });
		add.onclick = () =>
			new ItemPicker(this.app, (item) => void this.attach({ kind: "zotero", libraryID: item.libraryID, key: item.key })).open();
		const cur = actions.createEl("button", { cls: "zai-link-btn" });
		setIcon(cur.createSpan(), "crosshair");
		cur.createSpan({ text: "Current" });
		cur.onclick = () => {
			const t = this.plugin.activeTarget();
			if (!t) return void new Notice("No Zotero item or PDF is active.");
			void this.attach(t);
		};
	}

	/* ------------------------------ messages ----------------------------- */

	private renderMessages() {
		const el = this.listEl;
		el.empty();
		if (this.messages.length === 0) {
			const empty = el.createDiv("zai-empty");
			empty.createDiv({ cls: "zai-empty-title", text: "Ask about your reading" });
			const quick = empty.createDiv("zai-quick");
			for (const q of QUICK) {
				const b = quick.createEl("button", { text: q.label });
				b.onclick = () => void this.send(q.prompt);
			}
			return;
		}
		for (const m of this.messages) this.renderMessage(m);
		el.scrollTop = el.scrollHeight;
	}

	private renderMessage(m: ChatMessage): HTMLElement {
		const wrap = this.listEl.createDiv(`zai-msg zai-${m.role}`);
		const body = wrap.createDiv("zai-body markdown-rendered");
		if (m.role === "user") body.setText(m.text);
		else void this.renderMarkdown(body, m.text);
		if (m.error) wrap.createDiv({ cls: "zai-error", text: m.error });
		if (m.role === "assistant" && (m.text || m.usage)) {
			const foot = wrap.createDiv("zai-foot");
			if (m.usage) foot.createSpan({ cls: "zai-usage", text: usageText(m.usage) });
			const copy = foot.createSpan({ cls: "clickable-icon", attr: { "aria-label": "Copy" } });
			setIcon(copy, "copy");
			copy.onclick = () => void navigator.clipboard.writeText(this.linked(m.text)).then(() => new Notice("Copied"));
		}
		return wrap;
	}

	private linkTargets(): LinkTarget[] {
		return this.docs
			.filter((d) => d.doc)
			.map((d) => ({
				libraryID: d.doc!.libraryID,
				attachmentKey: d.doc!.attachmentKey,
				vaultPath: d.doc!.vaultPath,
				labels: new Map(d.doc!.pages.map((p) => [p.label.toLowerCase(), p.index])),
			}));
	}

	private linked(text: string): string {
		return linkCitations(text, this.linkTargets());
	}

	private async renderMarkdown(el: HTMLElement, text: string) {
		el.empty();
		await MarkdownRenderer.render(this.app, this.linked(text), el, "", this);
	}

	private onLinkClick(e: MouseEvent) {
		const a = (e.target as HTMLElement).closest("a");
		if (!a) return;
		const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
		if (a.hasClass("internal-link")) {
			e.preventDefault();
			void this.app.workspace.openLinkText(decodeURI(href), "", e.ctrlKey || e.metaKey);
		} else if (href.startsWith("obsidian://")) {
			e.preventDefault();
			window.open(href);
		}
	}

	/* -------------------------------- send ------------------------------- */

	private stop() {
		this.abort?.abort();
	}

	private newChat() {
		this.stop();
		this.messages = [];
		this.ccSession = null;
		this.renderMessages();
		this.setStatus("");
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
		this.statusEl?.toggleClass("is-visible", !!text);
	}

	private systemPrompt(): string {
		const s = this.plugin.settings;
		return [
			"You are a research assistant inside Obsidian. The user is a scholar in the humanities reading texts from their Zotero library.",
			"The documents are given in <document> tags, numbered from 1. Pages are in <page label=\"…\"> tags, the label being the printed page number. Documents sent as PDF come with a list mapping PDF pages to printed pages.",
			`Cite the pages you rely on as [p. 12] (a range: [pp. 12–14]). With more than one document, put the document number first: [2: p. 12]. Always use the printed page label.`,
			"Base your answers on the documents. When something is not in them, say so instead of filling the gap from general knowledge; mark clearly where you add outside knowledge. Quote exactly and sparingly.",
			"<my_annotations> holds the user's own highlights and comments in Zotero.",
			`Answer in ${s.language}. Use Markdown; keep it concise unless asked for detail.`,
			s.customInstructions.trim(),
		]
			.filter(Boolean)
			.join("\n\n");
	}

	private async contextBlocks(): Promise<{ blocks: Block[]; chars: number }> {
		const blocks: Block[] = [];
		let chars = 0;
		const ready = this.docs.filter((d) => d.doc);
		for (const [i, d] of ready.entries()) {
			const doc = d.doc!;
			const n = i + 1;
			const chosen = selectPages(doc.pages, d.pages);
			const includeAnnotations = this.plugin.settings.includeAnnotations;
			if (d.mode === "pdf" && doc.bytes) {
				let bytes = doc.bytes;
				if (chosen.length < doc.pages.length) {
					const src = await PDFDocument.load(doc.bytes, { ignoreEncryption: true });
					const out = await PDFDocument.create();
					for (const p of await out.copyPages(src, chosen.map((p) => p.index))) out.addPage(p);
					const saved = await out.save();
					bytes = saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer;
				}
				blocks.push({
					type: "text",
					text: `Document ${n}: ${doc.title} (sent as PDF below).\n${labelRuns(chosen.map((p) => p.label))}`,
				});
				blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) }, title: doc.title });
				if (includeAnnotations && doc.annotations.length) {
					blocks.push({ type: "text", text: documentText(n, doc.title, [], doc.annotations, { includeText: false, includeAnnotations: true }) });
				}
			} else {
				const text = documentText(n, doc.title, chosen, doc.annotations, { includeText: true, includeAnnotations });
				chars += text.length;
				blocks.push({ type: "text", text });
			}
		}
		// Documents stay the same over a chat: cache them.
		const last = blocks[blocks.length - 1];
		if (last) last.cache_control = { type: "ephemeral" };
		return { blocks, chars };
	}

	async send(preset?: string) {
		if (this.abort) return;
		const text = (preset ?? this.inputEl.value).trim();
		if (!text) return;
		const [backend, modelId] = splitChoice(this.model);
		const key = this.plugin.apiKey();
		if (backend === "api" && !key) {
			new Notice("Add your Anthropic API key in the Zotero AI settings first, or pick Claude Code in the model menu.");
			return;
		}
		if (this.docs.some((d) => d.loading)) {
			new Notice("Still reading a document, one moment…");
			return;
		}

		let context: { blocks: Block[]; chars: number };
		try {
			this.setStatus("Preparing documents…");
			context = await this.contextBlocks();
		} catch (e) {
			this.setStatus("");
			new Notice(`Could not prepare the documents: ${(e as Error).message}`);
			return;
		}
		if (this.messages.length === 0 && context.chars > this.plugin.settings.confirmAboveChars) {
			const ok = await confirm(
				this.app,
				`This sends about ${fmtK(estimateTokens(context.chars))} tokens of text with every question (cached after the first, as long as you ask again within a few minutes). Continue? You can narrow it with a page range.`,
			);
			if (!ok) {
				this.setStatus("");
				return;
			}
		}

		if (!preset) {
			this.inputEl.value = "";
			this.autosize();
		}
		if (this.messages.length === 0) this.listEl.empty();
		const user: ChatMessage = { role: "user", text };
		this.messages.push(user);
		this.renderMessage(user);
		const answer: ChatMessage = { role: "assistant", text: "" };
		this.messages.push(answer);
		const wrap = this.renderMessage(answer);
		wrap.addClass("is-streaming");
		const body = wrap.querySelector(".zai-body") as HTMLElement;
		this.listEl.scrollTop = this.listEl.scrollHeight;

		const apiMessages: ApiMessage[] = this.messages.slice(0, -1).map((m, i) => {
			if (i === 0 && context.blocks.length) return { role: "user", content: [...context.blocks, { type: "text", text: m.text }] };
			return { role: m.role, content: m.text };
		});

		this.abort = new AbortController();
		setIcon(this.sendBtn, "square");
		this.sendBtn.setAttr("aria-label", "Stop");
		this.setStatus("Thinking…");
		let pending = false;
		const paint = () => {
			if (pending) return;
			pending = true;
			window.setTimeout(() => {
				pending = false;
				void this.renderMarkdown(body, answer.text);
				const nearBottom = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight < 120;
				if (nearBottom) this.listEl.scrollTop = this.listEl.scrollHeight;
			}, 80);
		};
		try {
			const onText = (delta: string) => {
				if (!answer.text) this.setStatus("");
				answer.text += delta;
				paint();
			};
			const res =
				backend === "api"
					? await streamMessage({
							apiKey: key,
							model: modelId,
							maxTokens: this.plugin.settings.maxTokens,
							system: this.systemPrompt(),
							messages: apiMessages,
							signal: this.abort.signal,
							onText,
						})
					: await this.askClaudeCode(modelId, context.blocks, text, onText, this.abort.signal);
			answer.usage = res.usage;
			if (res.stopReason === "max_tokens") answer.error = "The answer hit the length limit (settings → maximum answer length).";
		} catch (e) {
			if (this.abort?.signal.aborted) answer.error = "Stopped.";
			else answer.error = e instanceof ApiError || e instanceof ClaudeCodeError ? e.message : `Request failed: ${(e as Error).message}`;
			// A failed first question leaves nothing worth keeping in the history.
			if (!answer.text) {
				this.messages.pop();
				this.messages.pop();
				if (!preset) this.inputEl.value = text;
				new Notice(answer.error);
			}
		} finally {
			this.abort = null;
			setIcon(this.sendBtn, "arrow-up");
			this.sendBtn.setAttr("aria-label", "Send");
			this.setStatus("");
			this.renderMessages();
		}
	}

	/** The documents a Claude Code session was started with. */
	private contextKey(): string {
		return this.docs
			.filter((d) => d.doc)
			.map((d) => `${d.doc!.id}|${d.mode}|${d.pages}`)
			.join(";");
	}

	/**
	 * One question through Claude Code. The first question of a session
	 * carries the documents; later ones continue it. When the documents
	 * changed (or the chat came from the API), a new session starts with the
	 * documents and the conversation so far as text.
	 */
	private async askClaudeCode(model: string, blocks: Block[], question: string, onText: (d: string) => void, signal: AbortSignal) {
		const key = this.contextKey();
		const resume = this.ccSession && this.ccSession.contextKey === key ? this.ccSession.id : undefined;
		let content: Block[];
		if (resume) {
			content = [{ type: "text", text: question }];
		} else {
			const earlier = this.messages.slice(0, -2);
			const transcript = earlier.length
				? [{ type: "text" as const, text: `<earlier_conversation>\n${earlier.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n\n")}\n</earlier_conversation>` }]
				: [];
			content = [...blocks, ...transcript, { type: "text", text: question }];
		}
		this.setStatus("Starting Claude Code…");
		const res = await runClaudeCode({
			claudePath: this.plugin.settings.claudePath,
			model,
			system: this.systemPrompt(),
			content,
			resume,
			signal,
			onText,
		});
		this.ccSession = res.sessionId ? { id: res.sessionId, contextKey: key } : null;
		return res;
	}

	/* ------------------------------- export ------------------------------ */

	private async saveAsNote() {
		if (this.messages.length === 0) return void new Notice("Nothing to save yet.");
		const s = this.plugin.settings;
		const folder = normalizePath(s.chatFolder || "/");
		if (folder !== "/" && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
		const docs = this.docs.filter((d) => d.doc).map((d) => d.doc!);
		const stamp = window.moment().format("YYYY-MM-DD HHmm");
		const first = docs[0]?.title.split(" — ").pop() ?? "Chat";
		const base = `${stamp} ${first}`.replace(/[\\/:*?"<>|#^[\]]/g, "").slice(0, 120).trim();
		let path = normalizePath(`${folder}/${base}.md`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.md`);

		const sources = docs.map((d) => (d.citationKey ? `"[[@${d.citationKey}]]"` : JSON.stringify(d.title)));
		const lines = [
			"---",
			`created: ${window.moment().format("YYYY-MM-DDTHH:mm")}`,
			`model: ${splitChoice(this.model)[0] === "cc" ? `Claude Code ${splitChoice(this.model)[1] || "default"}` : splitChoice(this.model)[1]}`,
			sources.length ? `sources:\n${sources.map((x) => `  - ${x}`).join("\n")}` : "sources: []",
			"tags: [ai-chat]",
			"---",
			"",
		];
		for (const m of this.messages) {
			if (m.role === "user") lines.push(`> [!question]\n> ${m.text.replace(/\n/g, "\n> ")}`, "");
			else lines.push(this.linked(m.text), "");
		}
		const file = await this.app.vault.create(path, lines.join("\n"));
		new Notice(`Saved to ${file.path}`);
		if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
	}

	/** Header menu: same actions, for narrow panes. */
	onPaneMenu(menu: Menu, source: string) {
		super.onPaneMenu(menu, source);
		menu.addItem((i) => i.setTitle("Save chat as note").setIcon("file-down").onClick(() => void this.saveAsNote()));
		menu.addItem((i) => i.setTitle("New chat").setIcon("square-pen").onClick(() => this.newChat()));
	}
}

function splitChoice(choice: string): ["api" | "cc", string] {
	const i = choice.indexOf(":");
	const kind = choice.slice(0, i) === "cc" ? "cc" : "api";
	return [kind, choice.slice(i + 1)];
}

function fmtK(n: number): string {
	return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function usageText(u: Usage): string {
	const cached = u.cache_read_input_tokens ?? 0;
	const written = u.cache_creation_input_tokens ?? 0;
	const input = u.input_tokens + cached + written;
	const parts = [`in ${fmtK(input)}`];
	if (cached) parts.push(`${fmtK(cached)} cached`);
	parts.push(`out ${fmtK(u.output_tokens)}`);
	return parts.join(" · ");
}

function confirm(app: ZoteroAiPlugin["app"], message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new (class extends Modal {
			result = false;
			onOpen() {
				this.contentEl.createEl("p", { text: message });
				const row = this.contentEl.createDiv("modal-button-container");
				row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
				const go = row.createEl("button", { cls: "mod-cta", text: "Send" });
				go.onclick = () => {
					this.result = true;
					this.close();
				};
				window.setTimeout(() => go.focus(), 0);
			}
			onClose() {
				resolve(this.result);
			}
		})(app);
		modal.open();
	});
}
