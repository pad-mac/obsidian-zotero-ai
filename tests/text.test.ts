import { describe, expect, it } from "vitest";

import { cleanPageText, documentText, labelRuns, linkCitations, selectPages } from "../src/text";

const pages = ["i", "ii", "1", "2", "3", "4"].map((label, index) => ({ index, label, text: `t${index}` }));

describe("cleanPageText", () => {
	it("undoes hyphenation and folds spaces", () => {
		expect(cleanPageText("Kultur-\nwissenschaft  ist\n\n\n\nschön")).toBe("Kulturwissenschaft ist\n\nschön");
	});
	it("keeps hyphens before capitals (Ost-\\nBerlin)", () => {
		expect(cleanPageText("Ost-\nBerlin")).toBe("Ost-\nBerlin");
	});
});

describe("selectPages", () => {
	it("all pages when empty or unparsable", () => {
		expect(selectPages(pages, "")).toHaveLength(6);
		expect(selectPages(pages, "abc")).toHaveLength(6);
	});
	it("by printed label first", () => {
		expect(selectPages(pages, "1-3").map((p) => p.label)).toEqual(["1", "2", "3"]);
		expect(selectPages(pages, "ii–2, 4").map((p) => p.label)).toEqual(["ii", "1", "2", "4"]);
	});
});

describe("labelRuns", () => {
	it("compresses runs", () => {
		expect(labelRuns(["i", "ii", "iii", "1", "2", "3", "A1"])).toBe(
			"PDF pages 1–3 = printed i–iii\nPDF pages 4–6 = printed 1–3\nPDF page 7 = printed A1",
		);
	});
});

describe("documentText", () => {
	it("wraps pages and annotations", () => {
		const t = documentText(1, 'A "B"', pages.slice(2, 3), [{ page: "1", color: "yellow", type: "highlight", text: "x", comment: "y" }], {
			includeText: true,
			includeAnnotations: true,
		});
		expect(t).toContain('<document n="1" title="A &quot;B&quot;">');
		expect(t).toContain('<page label="1">\nt2\n</page>');
		expect(t).toContain("[p. 1] (yellow) “x” — my comment: y");
	});
});

describe("linkCitations", () => {
	const docs = [
		{ libraryID: 1, attachmentKey: "ABCD1234", labels: new Map(pages.map((p) => [p.label, p.index])) },
		{ vaultPath: "Papers/a b.pdf", labels: new Map<string, number>() },
	];
	it("links page labels to ZotFlow's reader", () => {
		const out = linkCitations("See [p. 3].", docs);
		expect(out).toBe(
			`See [p. 3](obsidian://zotflow?type=open-attachment&libraryID=1&key=ABCD1234&navigation=${encodeURIComponent('{"pageIndex":4}')}).`,
		);
	});
	it("ranges use the first page; document numbers pick the document", () => {
		expect(linkCitations("[pp. 2–3]", docs)).toContain("pageIndex%22%3A3");
		expect(linkCitations("[2: p. 5]", docs)).toBe("[2: p. 5](Papers/a%20b.pdf#page=5)");
	});
	it("leaves code, links and unknown pages alone", () => {
		expect(linkCitations("`[p. 3]` [p. 3](x) [p. zz]", docs)).toBe("`[p. 3]` [p. 3](x) [p. zz]");
	});
});
