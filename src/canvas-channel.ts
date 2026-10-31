import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * What the platform tells every Canvas viewer. `hello` is sent first on each
 * connection: the live commit and the Runs already in progress.
 */
export type PlatformEvent =
  | { type: "hello"; commit: string; running: Array<{ runId: string; nickname: string }> }
  | { type: "run-started"; runId: string; nickname: string }
  | { type: "landed"; runId: string; nickname: string; prompt: string; commit: string }
  | { type: "rejected"; runId: string };

/**
 * The Canvas real-time channel: a Server-Sent Events stream every viewer keeps
 * open. Each message is tagged with an SSE event name, so platform events
 * (`platform`) stay apart from feature messages (`feature`), which Canvas
 * code sends through the client library and can never pass off as platform
 * events.
 */
export class CanvasChannel {
  private readonly viewers = new Set<ServerResponse>();
  private readonly greeting: () => Promise<PlatformEvent>;

  constructor(options: { greeting: () => Promise<PlatformEvent> }) {
    this.greeting = options.greeting;
  }

  /** Subscribes a viewer's request to the stream until it disconnects. */
  async connect(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hello = await this.greeting();
    // Greet and subscribe in one step, so no event slips in between.
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    write(res, "platform", hello);
    this.viewers.add(res);
    req.once("close", () => this.viewers.delete(res));
  }

  publish(event: PlatformEvent): void {
    for (const viewer of this.viewers) write(viewer, "platform", event);
  }

  /** Broadcasts a feature's message to every viewer, the sender included. */
  publishFeatureMessage(feature: string, message: unknown): void {
    for (const viewer of this.viewers) write(viewer, "feature", { feature, message });
  }
}

function write(res: ServerResponse, eventName: string, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
}
