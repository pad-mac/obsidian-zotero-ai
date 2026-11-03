/**
 * Read-only access to ZotFlow Evo's data: its IndexedDB database
 * (`zotflow-dev`, written by ZotFlow's worker with Dexie) and its settings
 * (the plugin instance). Nothing here writes to ZotFlow's database.
 *
 * The database is opened without a version, so it is never upgraded from
 * here, and closed as soon as ZotFlow asks for a version change.
 */
import type { App } from "obsidian";

export const ZOTFLOW_ID = "zotflow-evo";
const DB_NAME = "zotflow-dev";

export const READER_VIEW = "zotflow-zotero-reader-view";
export const LOCAL_READER_VIEW = "zotflow-local-zotero-reader-view";

/** The part of a Zotero item row this plugin reads. */
export interface ZItem {
	libraryID: number;
	key: string;
	itemType: string;
	parentItem: string;
	trashed: 0 | 1;
	title: string;
	citationKey?: string;
	searchCreators?: string[];
	raw: { data: Record<string, unknown> & { [k: string]: unknown } };
}

export interface ZFileRow {
	libraryID: number;
	key: string;
	buffer: ArrayBuffer;
	fileName: string;
	md5: string;
	evoEdited?: boolean;
	evoReplaces?: string;
}

/** The ZotFlow Evo settings this plugin uses (all optional: older builds). */
export interface ZotFlowSettingsView {
	useZoteroStorage?: boolean;
	zoteroStoragePath?: string;
	linkedAttachmentBaseDir?: string;
	evoZoteroDataDir?: string;
	evoGroupFolders?: { libraryID?: number; mode?: string; folder?: string }[];
}

export function zotflowPlugin(app: App): { settings?: ZotFlowSettingsView } | null {
	const plugins = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
	return (plugins?.plugins?.[ZOTFLOW_ID] as { settings?: ZotFlowSettingsView }) ?? null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

async function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = (async () => {
		// Opening a database that does not exist would create an empty one,
		// which ZotFlow would then have to upgrade: look first.
		const list = await indexedDB.databases?.();
		if (list && !list.some((d) => d.name === DB_NAME)) {
			throw new Error("ZotFlow Evo's database was not found. Is ZotFlow Evo installed and synced?");
		}
		return await new Promise<IDBDatabase>((resolve, reject) => {
			const req = indexedDB.open(DB_NAME);
			req.onupgradeneeded = () => {
				// Only reached when the database did not exist after all.
				req.transaction?.abort();
			};
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					db.close();
					dbPromise = null;
				};
				db.onclose = () => {
					dbPromise = null;
				};
				resolve(db);
			};
			req.onerror = () => reject(req.error ?? new Error("Could not open ZotFlow's database"));
			req.onblocked = () => reject(new Error("ZotFlow's database is busy; try again in a moment"));
		});
	})();
	dbPromise.catch(() => {
		dbPromise = null;
	});
	return dbPromise;
}

export function closeDb(): void {
	void dbPromise?.then((db) => db.close()).catch(() => undefined);
	dbPromise = null;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function store(name: string): Promise<IDBObjectStore> {
	const db = await openDb();
	if (!db.objectStoreNames.contains(name)) throw new Error(`ZotFlow's database has no "${name}" table`);
	return db.transaction(name, "readonly").objectStore(name);
}

export async function getItem(libraryID: number, key: string): Promise<ZItem | null> {
	const s = await store("items");
	return ((await request(s.get([libraryID, key]))) as ZItem | undefined) ?? null;
}

async function children(libraryID: number, parentKey: string, itemType: string): Promise<ZItem[]> {
	const s = await store("items");
	const index = "[libraryID+parentItem+itemType+trashed]";
	if (s.indexNames.contains(index)) {
		return (await request(s.index(index).getAll([libraryID, parentKey, itemType, 0]))) as ZItem[];
	}
	const all = (await request(s.getAll())) as ZItem[];
	return all.filter(
		(i) => i.libraryID === libraryID && i.parentItem === parentKey && i.itemType === itemType && !i.trashed,
	);
}

export const getAttachments = (libraryID: number, parentKey: string) =>
	children(libraryID, parentKey, "attachment");
export const getAnnotations = (libraryID: number, attachmentKey: string) =>
	children(libraryID, attachmentKey, "annotation");

export async function getCachedFile(libraryID: number, key: string): Promise<ZFileRow | null> {
	const s = await store("files");
	return ((await request(s.get([libraryID, key]))) as ZFileRow | undefined) ?? null;
}

/** Top-level items worth chatting about (no notes, attachments, annotations). */
export interface ItemSummary {
	libraryID: number;
	key: string;
	title: string;
	creators: string;
	year: string;
	itemType: string;
	citationKey?: string;
}

const NOT_TOP = new Set(["attachment", "note", "annotation"]);

export async function listItems(): Promise<ItemSummary[]> {
	const s = await store("items");
	const out: ItemSummary[] = [];
	await new Promise<void>((resolve, reject) => {
		const cursor = s.openCursor();
		cursor.onerror = () => reject(cursor.error);
		cursor.onsuccess = () => {
			const c = cursor.result;
			if (!c) return resolve();
			const i = c.value as ZItem;
			if (!i.trashed && !i.parentItem && !NOT_TOP.has(i.itemType)) out.push(summarize(i));
			c.continue();
		};
	});
	return out;
}

export function summarize(i: ZItem): ItemSummary {
	return {
		libraryID: i.libraryID,
		key: i.key,
		title: plainTitle(String(i.raw?.data?.title ?? i.title ?? "")) || "(untitled)",
		creators: creatorLine(i),
		year: yearOf(i),
		itemType: i.itemType,
		citationKey: i.citationKey,
	};
}

export function plainTitle(t: string): string {
	return t.replace(/<[^>]+>/g, "").trim();
}

export function creatorLine(i: ZItem): string {
	const creators = (i.raw?.data?.creators as { lastName?: string; name?: string; firstName?: string }[]) ?? [];
	const names = creators.map((c) => c.lastName || c.name || "").filter(Boolean);
	if (names.length === 0) return "";
	if (names.length <= 2) return names.join(" & ");
	return `${names[0]} et al.`;
}

export function yearOf(i: ZItem): string {
	const date = String(i.raw?.data?.date ?? "");
	return /\b(\d{4})\b/.exec(date)?.[1] ?? "";
}

/** A PDF before an EPUB before a snapshot (ZotFlow Evo's own order). */
export function primaryAttachment(atts: ZItem[]): ZItem | null {
	const rank = (a: ZItem) => {
		const ct = String(a.raw?.data?.contentType ?? "");
		const mode = String(a.raw?.data?.linkMode ?? "");
		if (mode === "linked_url") return 99;
		if (ct === "application/pdf") return 0;
		if (ct === "application/epub+zip") return 1;
		if (ct === "text/html") return 2;
		return 50;
	};
	const ok = atts.filter((a) => rank(a) < 99).sort((a, b) => rank(a) - rank(b));
	return ok[0] ?? null;
}

export function isPdf(att: ZItem): boolean {
	return String(att.raw?.data?.contentType ?? "") === "application/pdf";
}
