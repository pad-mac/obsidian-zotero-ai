import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { listModels } from "./anthropic";
import type ZoteroAiPlugin from "./main";

export interface ZoteroAiSettings {
	model: string;
	/** Models offered in the chat's picker (from the API, or typed). */
	models: string[];
	maxTokens: number;
	/** Default for new documents: send extracted text, or the PDF itself. */
	defaultMode: "text" | "pdf";
	includeAnnotations: boolean;
	/** Above this many characters of context, ask before sending. */
	confirmAboveChars: number;
	language: string;
	customInstructions: string;
	chatFolder: string;
	zoteroDataDir: string;
	/** Attach the item of the active reader or source note on its own. */
	followActive: boolean;
}

export const DEFAULT_SETTINGS: ZoteroAiSettings = {
	model: "claude-sonnet-5-5",
	models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
	maxTokens: 8000,
	defaultMode: "text",
	includeAnnotations: true,
	confirmAboveChars: 600_000,
	language: "the language of my question",
	customInstructions: "",
	chatFolder: "AI chats",
	zoteroDataDir: "",
	followActive: true,
};

export const SECRET_ID = "zotero-ai-anthropic-key";

export class ZoteroAiSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: ZoteroAiPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Kept in Obsidian's secret storage, not in data.json. Billed per use on console.anthropic.com, separately from a Claude subscription.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder("sk-ant-…")
					.setValue(this.plugin.apiKey())
					.onChange((v) => this.plugin.setApiKey(v.trim()));
			});

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Default model for new chats; the chat pane can switch.")
			.addDropdown((d) => {
				for (const m of new Set([...s.models, s.model])) d.addOption(m, m);
				d.setValue(s.model).onChange(async (v) => {
					s.model = v;
					await save();
				});
			})
			.addButton((b) =>
				b.setButtonText("Load from API").onClick(async () => {
					const key = this.plugin.apiKey();
					if (!key) return void new Notice("Enter the API key first.");
					try {
						const models = await listModels(key);
						s.models = models.map((m) => m.id);
						if (!s.models.includes(s.model) && s.models[0]) s.model = s.models[0];
						await save();
						new Notice(`${models.length} models loaded.`);
						this.display();
					} catch (e) {
						new Notice(`Could not load models: ${(e as Error).message}`);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Maximum answer length")
			.setDesc("Output tokens per answer.")
			.addText((t) =>
				t.setValue(String(s.maxTokens)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (n > 0) {
						s.maxTokens = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Send documents as")
			.setDesc("Text: the extracted text, cheap and fast. PDF: the file itself, so Claude also sees figures, tables and scans (each page also costs image tokens). Can be changed per document in the chat.")
			.addDropdown((d) =>
				d
					.addOption("text", "Text")
					.addOption("pdf", "PDF")
					.setValue(s.defaultMode)
					.onChange(async (v) => {
						s.defaultMode = v as "text" | "pdf";
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Include my annotations")
			.setDesc("Your highlights and comments from Zotero go along with each document.")
			.addToggle((t) =>
				t.setValue(s.includeAnnotations).onChange(async (v) => {
					s.includeAnnotations = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Follow the active item")
			.setDesc("Opening a PDF in ZotFlow or a source note attaches its item to an empty chat.")
			.addToggle((t) =>
				t.setValue(s.followActive).onChange(async (v) => {
					s.followActive = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Ask before sending more than")
			.setDesc("Characters of document text (about 3.5 characters per token). A 300-page book is roughly 600,000–900,000.")
			.addText((t) =>
				t.setValue(String(s.confirmAboveChars)).onChange(async (v) => {
					const n = parseInt(v.replace(/[^\d]/g, ""), 10);
					if (n > 0) {
						s.confirmAboveChars = n;
						await save();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Answer language")
			.addText((t) =>
				t.setValue(s.language).onChange(async (v) => {
					s.language = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Custom instructions")
			.setDesc("Added to the system prompt (your field, how you want summaries, citation style …).")
			.addTextArea((t) => {
				t.inputEl.rows = 5;
				t.setValue(s.customInstructions).onChange(async (v) => {
					s.customInstructions = v;
					await save();
				});
			});

		new Setting(containerEl)
			.setName("Folder for saved chats")
			.addText((t) =>
				t.setValue(s.chatFolder).onChange(async (v) => {
					s.chatFolder = v.trim();
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Zotero data folder")
			.setDesc("Where Zotero keeps its storage folder. Empty: ZotFlow Evo's setting, else ~/Zotero.")
			.addText((t) =>
				t
					.setPlaceholder("~/Zotero")
					.setValue(s.zoteroDataDir)
					.onChange(async (v) => {
						s.zoteroDataDir = v.trim();
						await save();
					}),
			);
	}
}
