/**
 * Turning a Zotero item (or a PDF in the vault) into something Claude can
 * read: the file's bytes, its text page by page with the printed page
 * labels, and the user's own annotations.
 *
 * Where the bytes come from, in order (desktop only, Node `fs`):
 * 1. Zotero's storage folder (`<storage>/<attachment key>/<file name>`),
 * 2. a linked file (absolute, or under ZotFlow's linked-attachment base),
 * 3. a group's shared folder on this computer (ZotFlow Evo, HU-Box),
 * 4. ZotFlow's own cache in IndexedDB (files opened in its reader),
 * 5. a PDF in the vault.
 * Text: extracted here with Obsidian's pdf.js (complete, page labels);
 * without bytes, Zotero's full-text cache (`.zotero-ft-cache`), which Zotero
 * may have cut off (by default after 100 pages / 500,000 characters).
 */
import { App, loadPdfJs, normalizePath, TFile } from "obsidian";

import {
	creatorLine,
	getAnnotations,
	getAttachments,
	getCachedFile,
	getItem,
	isPdf,
	plainTitle,
	primaryAttachment,
	yearOf,
	zotflowPlugin,
	type ZItem,
} from "./zotflow";
import { colorName, cleanPageText } from "./text";

export type Target =
	| { kind: "zotero"; libraryID: number; key: string }
	| { kind: "vault"; path: string };

export interface Page {
	/** 0-based index in the file. */
	index: number;
	/** Printed page label (pdf.js), else index + 1. */
	label: string;
	text: string;
}

export interface Annotation {
	page: string;
	color: string;
	type: string;
	text: string;
	comment: string;
}

export interface LoadedDocument {
	id: string;
	/** "Author Year — Title", for the chip and the prompt. */
	title: string;
	citationKey?: string;
	libraryID?: number;
	/** The attachment whose pages are cited (for links into ZotFlow's reader). */
	attachmentKey?: string;
	vaultPath?: string;
	kind: "pdf" | "epub" | "html" | "other";
	pages: Page[];
	/** Where the text came from. */
	textSource: "pdf" | "zotero-fulltext" | "none";
	/** Text that may be incomplete, and why. */
	warning?: string;
	/** Little or no text layer: probably a scan. */
	looksScanned: boolean;
	bytes?: ArrayBuffer;
	annotations: Annotation[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const node = () => ({ fs: require("fs") as typeof import("fs"), path: require("path") as typeof import("path"), os: require("os") as typeof import("os") });

export interface PathSettings {
	/** Own override; empty: ZotFlow Evo's settings, else ~/Zotero. */
	zoteroDataDir: string;
}

function expandHome(p: string): string {
	const { os, path } = node();
	return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function storageDirs(app: App, own: PathSettings): string[] {
	const { path, os } = node();
	const zf = zotflowPlugin(app)?.settings ?? {};
	const dirs: string[] = [];
	if (own.zoteroDataDir.trim()) dirs.push(path.join(expandHome(own.zoteroDataDir.trim()), "storage"));
	if (zf.zoteroStoragePath?.trim()) dirs.push(expandHome(zf.zoteroStoragePath.trim()));
	if (zf.evoZoteroDataDir?.trim()) dirs.push(path.join(expandHome(zf.evoZoteroDataDir.trim()), "storage"));
	dirs.push(path.join(os.homedir(), "Zotero", "storage"));
	return [...new Set(dirs)];
}

async function readIfExists(p: string): Promise<ArrayBuffer | null> {
	try {
		const buf = await node().fs.promises.readFile(p);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	} catch {
		return null;
	}
}

async function readAttachmentBytes(app: App, att: ZItem, own: PathSettings): Promise<ArrayBuffer | null> {
	const { path } = node();
	const data = att.raw.data;
	const linkMode = String(data.linkMode ?? "");
	const filename = String(data.filename ?? "");
	const safeName = filename && !/[\\/]/.test(filename) && filename !== "." && filename !== "..";
	const zf = zotflowPlugin(app)?.settings ?? {};

	// An edited copy ZotFlow uploaded is newer than Zotero's storage folder.
	const cached = await getCachedFile(att.libraryID, att.key).catch(() => null);
	const md5 = String(data.md5 ?? "");
	if (cached?.evoEdited && (cached.md5 === md5 || cached.evoReplaces === md5)) return cached.buffer;

	if (linkMode === "linked_file") {
		let p = String(data.path ?? "");
		if (p.startsWith("attachments:")) {
			const base = zf.linkedAttachmentBaseDir?.trim();
			if (!base) return null;
			p = path.join(expandHome(base), p.slice("attachments:".length));
		}
		const got = p ? await readIfExists(p) : null;
		if (got) return got;
	} else if (safeName) {
		for (const dir of storageDirs(app, own)) {
			const got = await readIfExists(path.join(dir, att.key, filename));
			if (got) return got;
		}
		const group = zf.evoGroupFolders?.find((g) => Number(g.libraryID) === att.libraryID && g.mode !== "webdav");
		if (group?.folder?.trim()) {
			for (const name of new Set([filename.normalize("NFC"), filename.normalize("NFD")])) {
				const got = await readIfExists(path.join(expandHome(group.folder.trim()), name));
				if (got) return got;
			}
		}
	}
	if (cached && (!md5 || cached.md5 === md5)) return cached.buffer;
	return null;
}

async function readFulltextCache(app: App, att: ZItem, own: PathSettings): Promise<string | null> {
	const { path } = node();
	for (const dir of storageDirs(app, own)) {
		try {
			return await node().fs.promises.readFile(path.join(dir, att.key, ".zotero-ft-cache"), "utf8");
		} catch {
			// next
		}
	}
	return null;
}

/** Page texts and labels of a PDF, with Obsidian's pdf.js. */
export async function extractPdf(bytes: ArrayBuffer, onProgress?: (done: number, total: number) => void): Promise<Page[]> {
	const pdfjs = await loadPdfJs();
	// pdf.js takes the buffer over: hand it a copy.
	const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
	try {
		let labels: string[] | null = null;
		try {
			labels = await doc.getPageLabels();
		} catch {
			labels = null;
		}
		const pages: Page[] = [];
		for (let i = 0; i < doc.numPages; i++) {
			const page = await doc.getPage(i + 1);
			const content = await page.getTextContent();
			const raw = (content.items as { str?: string; hasEOL?: boolean }[])
				.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : ""))
				.join("");
			pages.push({ index: i, label: labels?.[i]?.trim() || String(i + 1), text: cleanPageText(raw) });
			page.cleanup?.();
			if (onProgress && (i % 10 === 9 || i === doc.numPages - 1)) onProgress(i + 1, doc.numPages);
		}
		return pages;
	} finally {
		await doc.destroy?.();
	}
}

function kindOf(att: ZItem | null, path?: string): LoadedDocument["kind"] {
	const ct = att ? String(att.raw.data.contentType ?? "") : "";
	if (ct === "application/pdf" || path?.toLowerCase().endsWith(".pdf")) return "pdf";
	if (ct === "application/epub+zip" || path?.toLowerCase().endsWith(".epub")) return "epub";
	if (ct === "text/html") return "html";
	return "other";
}

function titleOf(item: ZItem): string {
	const who = creatorLine(item);
	const year = yearOf(item);
	const title = plainTitle(String(item.raw.data.title ?? item.title ?? ""));
	return [who, year].filter(Boolean).join(" ") + (who || year ? " — " : "") + (title || "(untitled)");
}

function looksScanned(pages: Page[]): boolean {
	if (pages.length === 0) return true;
	const chars = pages.reduce((n, p) => n + p.text.replace(/\s/g, "").length, 0);
	return chars / pages.length < 80;
}

/** In-memory cache of extracted documents (extracting a book takes seconds). */
const cache = new Map<string, LoadedDocument>();
const CACHE_MAX = 12;

function remember(doc: LoadedDocument): LoadedDocument {
	cache.delete(doc.id);
	cache.set(doc.id, doc);
	while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
	return doc;
}

export function targetId(t: Target): string {
	return t.kind === "zotero" ? `${t.libraryID}:${t.key}` : `vault:${t.path}`;
}

export async function loadDocument(
	app: App,
	target: Target,
	own: PathSettings,
	onProgress?: (msg: string) => void,
): Promise<LoadedDocument> {
	if (target.kind === "vault") return loadVaultDocument(app, target.path, onProgress);

	let item = await getItem(target.libraryID, target.key);
	if (!item) throw new Error("This item is not in ZotFlow's database (yet). Sync ZotFlow and try again.");

	// An attachment: its parent names it. A regular item: its best attachment.
	let att: ZItem | null = null;
	if (item.itemType === "attachment") {
		att = item;
		if (item.parentItem) item = (await getItem(item.libraryID, item.parentItem)) ?? item;
	} else {
		att = primaryAttachment(await getAttachments(item.libraryID, item.key));
	}
	const id = att ? `${att.libraryID}:${att.key}` : `${item.libraryID}:${item.key}`;
	const hit = cache.get(id);
	if (hit) return remember(hit);

	const doc: LoadedDocument = {
		id,
		title: titleOf(item),
		citationKey: item.citationKey,
		libraryID: item.libraryID,
		attachmentKey: att?.key,
		kind: kindOf(att),
		pages: [],
		textSource: "none",
		looksScanned: false,
		annotations: [],
	};

	if (att) {
		doc.annotations = (await getAnnotations(att.libraryID, att.key).catch(() => [])).map(toAnnotation).sort(byPage);
		const bytes = await readAttachmentBytes(app, att, own);
		if (bytes && isPdf(att)) {
			doc.bytes = bytes;
			onProgress?.("Reading the PDF…");
			doc.pages = await extractPdf(bytes, (d, t) => onProgress?.(`Reading the PDF… ${d}/${t} pages`));
			doc.textSource = "pdf";
			doc.looksScanned = looksScanned(doc.pages);
		}
		if (doc.textSource === "none" || doc.looksScanned) {
			const ft = await readFulltextCache(app, att, own);
			if (ft && ft.trim()) {
				doc.pages = ft.split("\f").map((text, index) => ({ index, label: String(index + 1), text: cleanPageText(text) }));
				doc.textSource = "zotero-fulltext";
				doc.looksScanned = false;
				const ftPages = doc.pages.filter((p) => p.text).length;
				if (ft.length >= 495_000 || ftPages === 100) {
					doc.warning = "Taken from Zotero's full-text index, which may be cut off (Zotero indexes 100 pages / 500,000 characters by default).";
				} else if (!bytes) {
					doc.warning = "Taken from Zotero's full-text index; page numbers are counted from the first page, not printed labels.";
				}
			}
		}
		if (doc.textSource === "none") {
			doc.warning = bytes
				? "No text could be read from this file."
				: "The file was not found on this computer (Zotero storage, linked file, shared folder or ZotFlow's cache). Open it once in ZotFlow so it is cached, or check the Zotero data folder in the settings.";
		}
	} else {
		doc.warning = "This item has no PDF, EPUB or snapshot: only its metadata and abstract are available.";
	}

	// Metadata stays useful even without a file.
	const abstract = String(item.raw.data.abstractNote ?? "").trim();
	if (abstract && doc.pages.length === 0) doc.pages = [{ index: 0, label: "abstract", text: abstract }];

	return remember(doc);
}

async function loadVaultDocument(app: App, path: string, onProgress?: (msg: string) => void): Promise<LoadedDocument> {
	const id = `vault:${path}`;
	const hit = cache.get(id);
	if (hit) return remember(hit);
	const file = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(file instanceof TFile)) throw new Error(`File not found in the vault: ${path}`);
	const doc: LoadedDocument = {
		id,
		title: file.basename,
		vaultPath: file.path,
		kind: kindOf(null, file.path),
		pages: [],
		textSource: "none",
		looksScanned: false,
		annotations: [],
	};
	if (doc.kind === "pdf") {
		doc.bytes = await app.vault.readBinary(file);
		onProgress?.("Reading the PDF…");
		doc.pages = await extractPdf(doc.bytes, (d, t) => onProgress?.(`Reading the PDF… ${d}/${t} pages`));
		doc.textSource = "pdf";
		doc.looksScanned = looksScanned(doc.pages);
	} else {
		doc.warning = "Only PDFs from the vault can be read so far.";
	}
	return remember(doc);
}

function toAnnotation(a: ZItem): Annotation {
	const d = a.raw.data;
	return {
		page: String(d.annotationPageLabel ?? ""),
		color: colorName(String(d.annotationColor ?? "")),
		type: String(d.annotationType ?? ""),
		text: String(d.annotationText ?? "").trim(),
		comment: String(d.annotationComment ?? "").trim(),
	};
}

function byPage(a: Annotation, b: Annotation): number {
	const na = parseInt(a.page, 10);
	const nb = parseInt(b.page, 10);
	if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
	return a.page.localeCompare(b.page);
}

export function forgetDocument(id: string): void {
	cache.delete(id);
}
