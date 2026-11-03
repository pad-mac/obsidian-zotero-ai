/**
 * Pure helpers (no Obsidian imports): text cleanup, page ranges, the
 * document block sent to Claude, and turning Claude's page citations into
 * links that open ZotFlow's reader at that page. Unit-tested.
 */

/** Whitespace folded, hyphenation at line ends undone. */
export function cleanPageText(raw: string): string {
	return raw
		.replace(/\r\n?/g, "\n")
		.replace(/(\p{L})[-­]\n(\p{Ll})/gu, "$1$2")
		.replace(/[ \t ]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const COLORS: Record<string, string> = {
	"#ffd400": "yellow",
	"#ff6666": "red",
	"#5fb236": "green",
	"#2ea8e5": "blue",
	"#a28ae5": "purple",
	"#e56eee": "magenta",
	"#f19837": "orange",
	"#aaaaaa": "gray",
};

export function colorName(hex: string): string {
	return COLORS[hex.toLowerCase()] ?? hex;
}

export interface PageLike {
	index: number;
	label: string;
	text: string;
}

/**
 * Pages chosen by a range like "12-40, 55" (printed labels first, else
 * positions 1..n). Empty or unparsable: all pages.
 */
export function selectPages<P extends PageLike>(pages: P[], spec: string): P[] {
	const s = spec.trim();
	if (!s) return pages;
	const byLabel = new Map(pages.map((p, i) => [p.label.toLowerCase(), i]));
	const pos = (token: string): number | null => {
		const t = token.trim().toLowerCase();
		if (!t) return null;
		const l = byLabel.get(t);
		if (l !== undefined) return l;
		const n = parseInt(t, 10);
		if (!isNaN(n) && String(n) === t && n >= 1 && n <= pages.length) return n - 1;
		return null;
	};
	const chosen = new Set<number>();
	for (const part of s.split(/[,;]/)) {
		const m = /^\s*([^-–]+?)\s*(?:[-–]\s*([^-–]+?))?\s*$/.exec(part);
		if (!m) continue;
		const a = pos(m[1] ?? "");
		const b = m[2] !== undefined ? pos(m[2]) : a;
		if (a === null || b === null) continue;
		for (let i = Math.min(a, b); i <= Math.max(a, b); i++) chosen.add(i);
	}
	if (chosen.size === 0) return pages;
	return pages.filter((_, i) => chosen.has(i));
}

/** Rough token count (Claude's tokenizer is not available offline). */
export function estimateTokens(chars: number): number {
	return Math.ceil(chars / 3.5);
}

export interface AnnotationLike {
	page: string;
	color: string;
	type: string;
	text: string;
	comment: string;
}

/** The text block of one document as Claude gets it. */
export function documentText(
	n: number,
	title: string,
	pages: PageLike[],
	annotations: AnnotationLike[],
	opts: { includeText: boolean; includeAnnotations: boolean },
): string {
	const out: string[] = [`<document n="${n}" title="${escapeAttr(title)}">`];
	if (opts.includeText) {
		for (const p of pages) {
			if (!p.text.trim()) continue;
			out.push(`<page label="${escapeAttr(p.label)}">\n${p.text}\n</page>`);
		}
	}
	if (opts.includeAnnotations && annotations.length) {
		out.push("<my_annotations>");
		for (const a of annotations) {
			const head = `[p. ${a.page || "?"}] (${a.color}${a.type && a.type !== "highlight" ? `, ${a.type}` : ""})`;
			const parts = [head];
			if (a.text) parts.push(`“${a.text}”`);
			if (a.comment) parts.push(`— my comment: ${a.comment}`);
			out.push(parts.join(" "));
		}
		out.push("</my_annotations>");
	}
	out.push("</document>");
	return out.join("\n");
}

/**
 * Which printed page each page of a PDF is, compactly: runs of labels that
 * count up with the PDF page are one line ("PDF pages 13–320 = printed
 * 1–308"); others are listed one by one. For documents sent as PDF, where
 * Claude sees only positions.
 */
export function labelRuns(labels: string[]): string {
	const lines: string[] = [];
	let i = 0;
	const num = (s: string) => (/^\d+$/.test(s) ? parseInt(s, 10) : NaN);
	const roman = (s: string) => /^[ivxlcdm]+$/i.test(s);
	while (i < labels.length) {
		let j = i;
		const start = labels[i] ?? "";
		if (!isNaN(num(start))) {
			while (j + 1 < labels.length && num(labels[j + 1] ?? "") === num(labels[j] ?? "") + 1) j++;
		} else if (roman(start)) {
			while (j + 1 < labels.length && roman(labels[j + 1] ?? "")) j++;
		}
		const a = i + 1;
		const b = j + 1;
		lines.push(a === b ? `PDF page ${a} = printed ${start}` : `PDF pages ${a}–${b} = printed ${start}–${labels[j]}`);
		i = j + 1;
	}
	return lines.join("\n");
}

function escapeAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export interface LinkTarget {
	libraryID?: number;
	attachmentKey?: string;
	vaultPath?: string;
	/** Printed label → 0-based page index. */
	labels: Map<string, number>;
}

/**
 * `[p. 12]`, `[pp. 12–14]`, `[2: p. 12]` (document 2) → markdown links into
 * ZotFlow's reader (or the vault PDF). Code spans and existing links are
 * left alone. Documents are numbered from 1.
 */
export function linkCitations(markdown: string, docs: LinkTarget[]): string {
	if (docs.length === 0) return markdown;
	const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]*`)/);
	return segments
		.map((seg, i) => {
			if (i % 2 === 1) return seg;
			return seg.replace(
				/\[(?:(\d+)\s*[:,]\s*)?(pp?)\.\s*([^\]\n]{1,30}?)\](?!\()/g,
				(whole, docNo: string | undefined, _pp: string, pageSpec: string) => {
					const doc = docs[(docNo ? parseInt(docNo, 10) : 1) - 1];
					if (!doc) return whole;
					const first = pageSpec.split(/[-–,]/)[0]?.trim() ?? "";
					const index = doc.labels.get(first.toLowerCase()) ?? (/^\d+$/.test(first) ? parseInt(first, 10) - 1 : undefined);
					if (index === undefined || index < 0) return whole;
					const url = pageUrl(doc, index);
					if (!url) return whole;
					return `[${whole.slice(1, -1)}](${url})`;
				},
			);
		})
		.join("");
}

export function pageUrl(doc: LinkTarget, index: number): string | null {
	if (doc.libraryID !== undefined && doc.attachmentKey) {
		const nav = encodeURIComponent(JSON.stringify({ pageIndex: index }));
		return `obsidian://zotflow?type=open-attachment&libraryID=${doc.libraryID}&key=${doc.attachmentKey}&navigation=${nav}`;
	}
	if (doc.vaultPath) {
		return `${encodeURI(doc.vaultPath).replace(/\(/g, "%28").replace(/\)/g, "%29")}#page=${index + 1}`;
	}
	return null;
}
