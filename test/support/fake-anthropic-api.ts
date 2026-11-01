import http from "node:http";
import type { AddressInfo } from "node:net";

/** One reply from the fake model: some text, or one tool call. */
export type ScriptedTurn = { text: string } | { tool: string; input: Record<string, unknown> };

export interface FakeAnthropicApi {
  /** Base URL to hand Claude Code as `ANTHROPIC_BASE_URL`. */
  url: string;
  /** The tool results Claude Code sent back, in order. */
  toolResults: Array<{ content: unknown; is_error?: boolean }>;
  close(): Promise<void>;
}

/**
 * A local stand-in for the Anthropic Messages API, so the real Claude Agent
 * SDK (and the Claude Code process it starts) can run without the network.
 * Each request for the main conversation gets the next scripted turn; any
 * other request (e.g. a title or quota check) gets a short text reply.
 */
export async function startFakeAnthropicApi(script: ScriptedTurn[]): Promise<FakeAnthropicApi> {
  const toolResults: FakeAnthropicApi["toolResults"] = [];
  let turn = 0;
  let toolUses = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
        res.writeHead(req.url?.includes("count_tokens") ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(req.url?.includes("count_tokens") ? { input_tokens: 1 } : { type: "error", error: { type: "not_found_error", message: "not found" } }));
        return;
      }
      const request = JSON.parse(body) as { stream?: boolean; model?: string; tools?: unknown[]; messages: Array<{ role: string; content: unknown }> };
      const isMain = Array.isArray(request.tools) && request.tools.length > 0;
      let reply: ScriptedTurn = { text: "ok" };
      if (isMain) {
        const last = request.messages.at(-1);
        if (Array.isArray(last?.content)) {
          for (const block of last.content as Array<{ type?: string; content?: unknown; is_error?: boolean }>) {
            if (block.type === "tool_result") toolResults.push({ content: block.content, is_error: block.is_error });
          }
        }
        reply = script[turn++] ?? { text: "Done." };
      }
      const content =
        "text" in reply
          ? [{ type: "text" as const, text: reply.text }]
          : [{ type: "tool_use" as const, id: `toolu_fake${++toolUses}`, name: reply.tool, input: reply.input }];
      const message = {
        id: `msg_fake${turn}_${Math.random().toString(36).slice(2)}`,
        type: "message",
        role: "assistant",
        model: request.model ?? "claude-sonnet-5-5",
        content,
        stop_reason: "text" in reply ? "end_turn" : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (!request.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(message));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null } });
      content.forEach((block, index) => {
        if (block.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        } else {
          send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    toolResults,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
