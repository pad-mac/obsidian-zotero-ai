import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { listModels } from "./anthropic";
import { claudeVersion, findClaude } from "./claude-code";
import type ZoteroAiPlugin from "./main";

export interface ZoteroAiSettings {
	/** API key (billed credits) or Claude Code signed in with the Claude plan. */
	backend: "api" | "claude-code";
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
	/** How long answers should be: told to Claude in the system prompt (both backends). */
	answerLength: "short" | "medium" | "detailed";
	customInstructions: string;
	chatFolder: string;
	zoteroDataDir: string;
	/** Attach the item of the active reader or source note on its own. */
	followActive: boolean;
	/** Claude Code: path to `claude` (empty: the usual install places, then PATH). */
	claudePath: string;
	/** Claude Code: "" (its default), an alias or a full model id. */
	ccModel: string;
	/** The chat the pane shows on opening. */
	lastChatId: string;
	/** Hide the tab bar above the chat when it is the only tab in its group. */
	hideTabBar: boolean;
}

export const CC_MODELS = ["", "opus", "sonnet", "haiku", "fable"];

export const DEFAULT_SETTINGS: ZoteroAiSettings = {
	backend: "api",
	model: "claude-sonnet-5-5",
	models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
	maxTokens: 8000,
	defaultMode: "text",
	includeAnnotations: true,
	confirmAboveChars: 600_000,
	language: "the language of my question",
	answerLength: "short",
	customInstructions: "",
	chatFolder: "AI chats",
	zoteroDataDir: "",
	followActive: true,
	claudePath: "",
	ccModel: "",
	lastChatId: "",
	hideTabBar: true,
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
		const cc = s.backend === "claude-code";

		/* ---------------------------- Backend ---------------------------- */
		new Setting(containerEl).setName("Backend").setHeading();

		new Setting(containerEl)
			.setName("Answer with")
			.setDesc("API key: billed per use in the Claude Console. Claude Code: the claude command on this computer, signed in with your Claude plan; counts against the plan's usage limits.")
			.addDropdown((d) =>
				d
					.addOption("api", "API key")
					.addOption("claude-code", "Claude Code (subscription)")
					.setValue(s.backend)
					.onChange(async (v) => {
						s.backend = v as ZoteroAiSettings["backend"];
						await save();
						this.display();
					}),
			);

		if (cc) {
			new Setting(containerEl).setName("Model").addDropdown((d) => {
				for (const m of new Set([...CC_MODELS, s.ccModel])) d.addOption(m, m || "Claude Code's default");
				d.setValue(s.ccModel).onChange(async (v) => {
					s.ccModel = v;
					await save();
				});
			});
			new Setting(containerEl)
				.setName("Path to claude")
				.setDesc(`Empty: ${findClaude("")}. Install in PowerShell with: irm https://claude.ai/install.ps1 | iex — then run claude once and sign in with your Claude account.`)
				.addText((t) =>
					t
						.setPlaceholder(findClaude(""))
						.setValue(s.claudePath)
						.onChange(async (v) => {
							s.claudePath = v.trim();
							await save();
						}),
				)
				.addButton((b) =>
					b.setButtonText("Test").onClick(async () => {
						try {
							new Notice(`Found: ${await claudeVersion(s.claudePath)}`);
						} catch (e) {
							new Notice((e as Error).message, 10000);
						}
					}),
				);
		} else {
			new Setting(containerEl)
				.setName("Anthropic API key")
				.setDesc("Kept in Obsidian's secret storage, not in data.json.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.setPlaceholder("sk-ant-…")
						.setValue(this.plugin.apiKey())
						.onChange((v) => this.plugin.setApiKey(v.trim()));
				});
			new Setting(containerEl)
				.setName("Model")
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
				.setName("Hard limit per answer")
				.setDesc("Output tokens; an answer that reaches it is cut off mid-sentence. For shorter answers use Answer length below.")
				.addText((t) =>
					t.setValue(String(s.maxTokens)).onChange(async (v) => {
						const n = parseInt(v, 10);
						if (n > 0) {
							s.maxTokens = n;
							await save();
						}
					}),
				);
		}

		/* ---------------------------- Answers ---------------------------- */
		new Setting(containerEl)
			.setName("Answers")
			.setDesc("Apply to both backends, from the next question on.")
			.setHeading();

		new Setting(containerEl)
			.setName("Answer length")
			.setDesc("Short: a few sentences or a handful of bullets. Asking for more in a question still works.")
			.addDropdown((d) =>
				d
					.addOption("short", "Short")
					.addOption("medium", "Medium")
					.addOption("detailed", "Detailed")
					.setValue(s.answerLength)
					.onChange(async (v) => {
						s.answerLength = v as ZoteroAiSettings["answerLength"];
						await save();
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
			.setDesc("Added to the instructions Claude gets (your field, how you want summaries, citation style …).")
			.addTextArea((t) => {
				t.inputEl.rows = 5;
				t.setValue(s.customInstructions).onChange(async (v) => {
					s.customInstructions = v;
					await save();
				});
			});

		/* --------------------------- Documents --------------------------- */
		new Setting(containerEl).setName("Documents").setHeading();

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

		/* ------------------------------ Pane ----------------------------- */
		new Setting(containerEl).setName("Pane").setHeading();

		new Setting(containerEl)
			.setName("Hide the tab bar above the chat")
			.setDesc("When the chat is the only tab in its pane or window. In a separate window that also hides its title bar: move it with Win+arrow keys, close it with Ctrl+W.")
			.addToggle((t) =>
				t.setValue(s.hideTabBar).onChange(async (v) => {
					s.hideTabBar = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Folder for saved chats")
			.setDesc("Where \"Save chat as note\" writes.")
			.addText((t) =>
				t.setValue(s.chatFolder).onChange(async (v) => {
					s.chatFolder = v.trim();
					await save();
				}),
			);
	}
}
