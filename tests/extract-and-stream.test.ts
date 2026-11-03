import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

import { streamMessage } from "../src/anthropic";
import { extractPdf } from "../src/documents";

describe("extractPdf", () => {
	it("reads each page's text with pdf.js", async () => {
		const pdf = await PDFDocument.create();
		const font = await pdf.embedFont(StandardFonts.Helvetica);
		for (const t of ["First page text", "Second page text"]) {
			pdf.addPage([300, 200]).drawText(t, { x: 20, y: 100, size: 12, font });
		}
		const bytes = (await pdf.save()).buffer as ArrayBuffer;
		const pages = await extractPdf(bytes);
		expect(pages.map((p) => p.label)).toEqual(["1", "2"]);
		expect(pages[1]?.text).toBe("Second page text");
		expect(bytes.byteLength).toBeGreaterThan(0); // the caller's buffer is not taken over
	});
});

describe("streamMessage", () => {
	it("parses the event stream: text, usage, stop reason", async () => {
		const events = [
			{ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 5 } } },
			{ type: "content_block_delta", delta: { type: "text_delta", text: "Hal" } },
			{ type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
		];
		const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
		// Split in awkward places, as a network does.
		const chunks = [sse.slice(0, 17), sse.slice(17, 140), sse.slice(140)];
		const body = new ReadableStream({
			start(c) {
				for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
				c.close();
			},
		});
		const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		let text = "";
		const res = await streamMessage({
			apiKey: "k", model: "m", maxTokens: 10, system: "s", messages: [{ role: "user", content: "hi" }],
			signal: new AbortController().signal, onText: (d) => (text += d),
		});
		expect(text).toBe("Hallo");
		expect(res.usage).toMatchObject({ input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 5 });
		expect(res.stopReason).toBe("end_turn");
		const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
		expect((init.headers as Record<string, string>)["anthropic-dangerous-direct-browser-access"]).toBe("true");
		vi.unstubAllGlobals();
	});

	it("turns API errors into readable messages", async () => {
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }));
		await expect(
			streamMessage({ apiKey: "k", model: "m", maxTokens: 1, system: "", messages: [], signal: new AbortController().signal, onText: () => {} }),
		).rejects.toThrow("The API key was refused");
		vi.unstubAllGlobals();
	});
});
