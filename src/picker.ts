import { App, FuzzySuggestModal, Notice, type FuzzyMatch } from "obsidian";

import type { ChatStore, ChatSummary } from "./history";
import { listItems, type ItemSummary } from "./zotflow";

/** Pick a top-level item from ZotFlow's library. */
export class ItemPicker extends FuzzySuggestModal<ItemSummary> {
	private items: ItemSummary[] = [];

	constructor(
		app: App,
		private onPick: (item: ItemSummary) => void,
	) {
		super(app);
		this.setPlaceholder("Search your Zotero library: author, year, title, citekey…");
		this.limit = 60;
	}

	async onOpen() {
		super.onOpen();
		try {
			this.items = await listItems();
			this.items.sort((a, b) => a.title.localeCompare(b.title));
			// Refresh the list now that items are there.
			this.inputEl.dispatchEvent(new Event("input"));
		} catch (e) {
			new Notice((e as Error).message);
			this.close();
		}
	}

	getItems(): ItemSummary[] {
		return this.items;
	}

	getItemText(i: ItemSummary): string {
		return [i.creators, i.year, i.title, i.citationKey ? `@${i.citationKey}` : ""].filter(Boolean).join(" ");
	}

	renderSuggestion(match: FuzzyMatch<ItemSummary>, el: HTMLElement) {
		const i = match.item;
		el.addClass("zai-suggest");
		el.createDiv({ cls: "zai-suggest-title", text: i.title });
		el.createDiv({ cls: "zai-suggest-meta", text: [i.creators, i.year].filter(Boolean).join(" · ") });
	}

	onChooseItem(item: ItemSummary) {
		this.onPick(item);
	}
}

/** The saved chats, newest first. */
export class HistoryPicker extends FuzzySuggestModal<ChatSummary> {
	private chats: ChatSummary[] = [];

	constructor(
		app: App,
		private store: ChatStore,
		private current: string,
		private onPick: (id: string) => void,
	) {
		super(app);
		this.setPlaceholder("Open a saved chat…");
	}

	async onOpen() {
		super.onOpen();
		this.chats = await this.store.list();
		this.inputEl.dispatchEvent(new Event("input"));
	}

	getItems(): ChatSummary[] {
		return this.chats;
	}

	getItemText(c: ChatSummary): string {
		return c.title;
	}

	renderSuggestion(match: FuzzyMatch<ChatSummary>, el: HTMLElement) {
		const c = match.item;
		el.addClass("zai-suggest");
		el.createDiv({ cls: "zai-suggest-title", text: c.title + (c.id === this.current ? "  (open)" : "") });
		el.createDiv({ cls: "zai-suggest-meta", text: `${window.moment(c.updated).format("D MMM YYYY, HH:mm")} · ${Math.ceil(c.count / 2)} questions` });
	}

	onChooseItem(c: ChatSummary) {
		this.onPick(c.id);
	}
}
