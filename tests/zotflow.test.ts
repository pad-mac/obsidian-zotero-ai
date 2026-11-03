import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeAll, describe, expect, it } from "vitest";

import { getAnnotations, getAttachments, getCachedFile, getItem, listItems, primaryAttachment } from "../src/zotflow";

// The same tables and indexes ZotFlow's Dexie schema creates.
beforeAll(async () => {
	const db = new Dexie("zotflow-dev");
	db.version(7).stores({
		items: "&[libraryID+key], [libraryID+syncStatus], [libraryID+itemType+trashed], [libraryID+parentItem+itemType+trashed], *collections, *searchCreators, *searchTags, dateModified, lastAccessedAt",
		files: "&[libraryID+key], md5, lastAccessedAt",
	});
	const item = (key: string, itemType: string, parentItem = "", data: Record<string, unknown> = {}) => ({
		libraryID: 1, key, itemType, parentItem, trashed: 0, title: String(data.title ?? ""), collections: [], searchCreators: [], searchTags: [], raw: { data },
	});
	await db.table("items").bulkPut([
		item("BOOK0001", "book", "", { title: "Du mode <i>d'existence</i>", date: "1958", creators: [{ lastName: "Simondon" }] }),
		item("ATT00001", "attachment", "BOOK0001", { contentType: "text/html", linkMode: "imported_url" }),
		item("ATT00002", "attachment", "BOOK0001", { contentType: "application/pdf", linkMode: "imported_file", filename: "s.pdf" }),
		item("ANN00001", "annotation", "ATT00002", { annotationText: "x", annotationPageLabel: "12" }),
		{ ...item("TRASH001", "book"), trashed: 1 },
	]);
	await db.table("files").put({ libraryID: 1, key: "ATT00002", buffer: new ArrayBuffer(3), md5: "m", fileName: "s.pdf", mimeType: "application/pdf", size: 3, lastAccessedAt: "" });
	db.close();
});

describe("ZotFlow database (read-only)", () => {
	it("reads items, children, annotations and cached files", async () => {
		expect((await getItem(1, "BOOK0001"))?.itemType).toBe("book");
		const atts = await getAttachments(1, "BOOK0001");
		expect(atts).toHaveLength(2);
		expect(primaryAttachment(atts)?.key).toBe("ATT00002");
		expect((await getAnnotations(1, "ATT00002"))[0]?.key).toBe("ANN00001");
		expect((await getCachedFile(1, "ATT00002"))?.fileName).toBe("s.pdf");
	});
	it("lists top-level, untrashed items with plain titles", async () => {
		const items = await listItems();
		expect(items.map((i) => i.key)).toEqual(["BOOK0001"]);
		expect(items[0]).toMatchObject({ title: "Du mode d'existence", creators: "Simondon", year: "1958" });
	});
});
