/**
 * A small client for Anthropic's Messages API: streaming over fetch (the API
 * allows browser calls with the `anthropic-dangerous-direct-browser-access`
 * header), with Obsidian's `requestUrl` as a non-streaming fallback when
 * fetch is refused.
 */
import { requestUrl } from "obsidian";

const API = "https://api.anthropic.com/v1";
const VERSION = "2023-06-01";

export type Block =
	| { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
	| {
			type: "document";
			source: { type: "base64"; media_type: "application/pdf"; data: string };
			title?: string;
			cache_control?: { type: "ephemeral" };
	  };

export interface ApiMessage {
	role: "user" | "assistant";
	content: string | Block[];
}

export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

export interface StreamRequest {
	apiKey: string;
	model: string;
	maxTokens: number;
	system: string;
	messages: ApiMessage[];
	signal: AbortSignal;
	onText: (delta: string) => void;
}

export interface StreamResult {
	usage: Usage;
	stopReason: string | null;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly type?: string,
	) {
		super(message);
	}
}

function headers(apiKey: string): Record<string, string> {
	return {
		"x-api-key": apiKey,
		"anthropic-version": VERSION,
		"content-type": "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
	};
}

function errorFrom(status: number, body: string): ApiError {
	try {
		const j = JSON.parse(body) as { error?: { type?: string; message?: string } };
		if (j.error?.message) return new ApiError(friendly(status, j.error.message), status, j.error.type);
	} catch {
		// not JSON
	}
	return new ApiError(friendly(status, body.slice(0, 300) || `HTTP ${status}`), status);
}

function friendly(status: number, message: string): string {
	if (status === 401) return "The API key was refused. Check it in the settings.";
	if (status === 429) return `Rate limit reached: ${message}`;
	if (status === 529 || status === 503) return "Anthropic's API is overloaded right now. Try again in a moment.";
	return message;
}

export async function streamMessage(req: StreamRequest): Promise<StreamResult> {
	const body = JSON.stringify({
		model: req.model,
		max_tokens: req.maxTokens,
		system: req.system,
		messages: req.messages,
		stream: true,
	});
	let res: Response;
	try {
		res = await fetch(`${API}/messages`, { method: "POST", headers: headers(req.apiKey), body, signal: req.signal });
	} catch (e) {
		if (req.signal.aborted) throw e;
		// fetch refused (network policy, CORS): one answer without streaming.
		return await nonStreaming(req);
	}
	if (!res.ok || !res.body) throw errorFrom(res.status, await res.text().catch(() => ""));

	const usage: Usage = { input_tokens: 0, output_tokens: 0 };
	let stopReason: string | null = null;
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let cut: number;
		while ((cut = buffer.indexOf("\n\n")) >= 0) {
			const event = buffer.slice(0, cut);
			buffer = buffer.slice(cut + 2);
			const data = event
				.split("\n")
				.filter((l) => l.startsWith("data:"))
				.map((l) => l.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			let j: Record<string, any>;
			try {
				j = JSON.parse(data);
			} catch {
				continue;
			}
			switch (j.type) {
				case "message_start":
					Object.assign(usage, j.message?.usage ?? {});
					break;
				case "content_block_delta":
					if (j.delta?.type === "text_delta" && j.delta.text) req.onText(j.delta.text);
					break;
				case "message_delta":
					if (j.usage?.output_tokens !== undefined) usage.output_tokens = j.usage.output_tokens;
					stopReason = j.delta?.stop_reason ?? stopReason;
					break;
				case "error":
					throw new ApiError(friendly(0, j.error?.message ?? "Stream error"), undefined, j.error?.type);
			}
		}
	}
	return { usage, stopReason };
}

async function nonStreaming(req: StreamRequest): Promise<StreamResult> {
	const res = await requestUrl({
		url: `${API}/messages`,
		method: "POST",
		headers: headers(req.apiKey),
		body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages }),
		throw: false,
	});
	if (res.status >= 400) throw errorFrom(res.status, res.text);
	const j = res.json as { content?: { type: string; text?: string }[]; usage: Usage; stop_reason: string | null };
	for (const b of j.content ?? []) if (b.type === "text" && b.text) req.onText(b.text);
	return { usage: j.usage, stopReason: j.stop_reason };
}

export interface ModelInfo {
	id: string;
	name: string;
}

export async function listModels(apiKey: string): Promise<ModelInfo[]> {
	const res = await requestUrl({ url: `${API}/models?limit=100`, headers: headers(apiKey), throw: false });
	if (res.status >= 400) throw errorFrom(res.status, res.text);
	const j = res.json as { data?: { id: string; display_name?: string }[] };
	return (j.data ?? []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
}

export function toBase64(bytes: ArrayBuffer): string {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return (require("buffer") as typeof import("buffer")).Buffer.from(bytes).toString("base64");
}
