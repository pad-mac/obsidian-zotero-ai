import { Plugin, TFile, type WorkspaceLeaf } from "obsidian";

import type { Target } from "./documents";
import { ChatStore } from "./history";
import { DEFAULT_SETTINGS, SECRET_ID, ZoteroAiSettingTab, type ZoteroAiSettings } from "./settings";
import { CHAT_VIEW, ChatView } from "./view";
import { closeDb, LOCAL_READER_VIEW, READER_VIEW } from "./zotflow";

export default class ZoteroAiPlugin extends Plugin {
	settings!: ZoteroAiSettings;
	chats!: ChatStore;
	/** The last Zotero item or PDF that was active (the chat pane itself is not). */
	private lastTarget: Target | null = null;

	async onload() {
		await this.loadSettings();
		this.chats = new ChatStore(this.app, `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/chats`);
		this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
		this.addSettingTab(new ZoteroAiSettingTab(this.app, this));

		this.addRibbonIcon("sparkles", "Zotero AI chat", () => void this.openChat());
		this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.openChat() });
		this.addCommand({
			id: "ask-current",
			name: "Ask about the current item",
			callback: async () => {
				const target = this.activeTarget();
				const view = await this.openChat();
				if (target) await view?.attach(target);
				view?.focusInput();
			},
		});

		const withChat = (fn: (v: ChatView) => unknown) => async () => {
			const v = await this.openChat();
			if (v) fn(v);
		};
		this.addCommand({ id: "new-chat", name: "New chat", callback: withChat((v) => v.newChat()) });
		this.addCommand({ id: "chat-history", name: "Chat history", callback: withChat((v) => v.showHistory()) });
		this.addCommand({ id: "save-chat", name: "Save chat as note", callback: withChat((v) => void v.saveAsNote()) });
		this.addCommand({ id: "recover-claude-code", name: "Recover Claude Code chats", callback: withChat((v) => void v.recoverClaudeCode()) });
		this.applyChrome();

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				const t = leaf ? targetOfLeaf(this, leaf) : null;
				if (t) this.lastTarget = t;
				if (t && this.settings.followActive) for (const v of this.chatViews()) void v.followActive();
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			const leaf = this.app.workspace.getMostRecentLeaf();
			if (leaf) this.lastTarget = targetOfLeaf(this, leaf);
		});
	}

	onunload() {
		closeDb();
		document.body.removeClass("zai-hide-tabbar");
	}

	/** Without a tab bar above a chat that is alone in its tab group (setting). */
	applyChrome() {
		document.body.toggleClass("zai-hide-tabbar", this.settings.hideTabBar);
		this.registerEvent(
			this.app.workspace.on("window-open", (win) => win.doc.body.toggleClass("zai-hide-tabbar", this.settings.hideTabBar)),
		);
	}

	/** What the user is reading: the active leaf, else the last one that was. */
	activeTarget(): Target | null {
		const leaf = this.app.workspace.getMostRecentLeaf();
		return (leaf && targetOfLeaf(this, leaf)) ?? this.lastTarget;
	}

	private chatViews(): ChatView[] {
		return this.app.workspace.getLeavesOfType(CHAT_VIEW).map((l) => l.view).filter((v): v is ChatView => v instanceof ChatView);
	}

	async openChat(): Promise<ChatView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(CHAT_VIEW)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf("split");
			await leaf.setViewState({ type: CHAT_VIEW, active: true });
		}
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof ChatView ? leaf.view : null;
	}

	apiKey(): string {
		try {
			return this.app.secretStorage.getSecret(SECRET_ID) ?? "";
		} catch {
			return "";
		}
	}

	setApiKey(key: string) {
		try {
			this.app.secretStorage.setSecret(SECRET_ID, key);
		} catch (e) {
			console.warn("[Zotero AI] Could not store the API key", e);
		}
	}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<ZoteroAiSettings> | null) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		document.body.toggleClass("zai-hide-tabbar", this.settings.hideTabBar);
		for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW)) leaf.view.containerEl.doc.body.toggleClass("zai-hide-tabbar", this.settings.hideTabBar);
		for (const v of this.chatViews()) v.fillModels();
	}
}

/** The Zotero item or PDF a leaf shows, if any. */
function targetOfLeaf(plugin: ZoteroAiPlugin, leaf: WorkspaceLeaf): Target | null {
	const type = leaf.view.getViewType();
	if (type === CHAT_VIEW) return null;
	const state = leaf.view.getState() as Record<string, unknown>;
	if (type === READER_VIEW) {
		const libraryID = Number(state.libraryID);
		const key = String(state.itemKey ?? "");
		return libraryID && key ? { kind: "zotero", libraryID, key } : null;
	}
	if (type === LOCAL_READER_VIEW || type === "pdf") {
		const path = String(state.file ?? "");
		return path.toLowerCase().endsWith(".pdf") ? { kind: "vault", path } : null;
	}
	if (type === "markdown") {
		const file = (leaf.view as unknown as { file?: TFile | null }).file;
		if (!file) return null;
		const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		const key = fm?.["zotero-key"];
		const libraryID = Number(fm?.["library-id"]);
		if (typeof key === "string" && key && libraryID) return { kind: "zotero", libraryID, key };
	}
	return null;
}
