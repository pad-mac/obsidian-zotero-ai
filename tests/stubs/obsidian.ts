// Minimal stand-in for the parts of Obsidian's API the tested modules touch.
export async function loadPdfJs() {
	return await import("pdfjs-dist/legacy/build/pdf.mjs");
}
export async function requestUrl(): Promise<never> {
	throw new Error("requestUrl not stubbed");
}
export const normalizePath = (p: string) => p;
export class TFile {}
