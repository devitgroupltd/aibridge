import net from "node:net";
import { encodeMessage, NdjsonDecoder, PROTOCOL_VERSION } from "@aibridge/protocol";
import type { HelloFromChannel, Message } from "@aibridge/protocol";

export const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\aibridge";
const MAX_BACKOFF_MS = 5000;
const INITIAL_BACKOFF_MS = 100;
const MAX_QUEUE = 100;

type LogFn = (level: "INFO" | "WARN" | "ERROR", message: string) => void;

function isPriority(msg: Message): boolean {
  // §2.5: reply and permission_request are queued ahead of everything else.
  return msg.type === "reply" || msg.type === "permission_request";
}

export interface PipeClientOptions {
  slug: string;
  pipePath?: string;
  onMessage: (msg: Message) => void;
  log?: LogFn;
}

/**
 * Client side of the §2.5 socket protocol, used by the channel server to talk to the Bridge.
 * Reconnects with backoff capped at 5s and re-sends `hello` as idempotent re-registration on
 * every reconnect. While disconnected, outbound messages queue (bounded at 100, oldest
 * non-priority dropped first) rather than being lost.
 */
export class PipeClient {
  private socket?: net.Socket;
  private connected = false;
  private readonly decoder = new NdjsonDecoder();
  private queue: Message[] = [];
  private backoffMs = INITIAL_BACKOFF_MS;
  private closed = false;
  private readonly slug: string;
  private readonly pipePath: string;
  private readonly onMessage: (msg: Message) => void;
  private readonly log: LogFn;

  constructor(opts: PipeClientOptions) {
    this.slug = opts.slug;
    this.pipePath = opts.pipePath ?? DEFAULT_PIPE_PATH;
    this.onMessage = opts.onMessage;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const socket = net.connect(this.pipePath);
    this.socket = socket;

    socket.on("connect", () => {
      this.connected = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.log("INFO", `connected to Bridge pipe at ${this.pipePath}`);
      const hello: HelloFromChannel = {
        v: PROTOCOL_VERSION,
        type: "hello",
        role: "channel",
        slug: this.slug,
        pid: process.pid,
      };
      this.sendRaw(hello);
      this.flushQueue();
    });

    socket.on("data", (chunk) => {
      for (const msg of this.decoder.push(chunk)) {
        this.onMessage(msg);
      }
    });

    socket.on("error", (err) => {
      this.log("WARN", `pipe socket error: ${(err as Error).message}`);
    });

    socket.on("close", () => {
      this.socket = undefined;
      this.connected = false;
      if (this.closed) return;
      const delay = this.backoffMs;
      this.log("WARN", `disconnected from Bridge pipe, reconnecting in ${delay}ms`);
      setTimeout(() => this.connect(), delay);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    });
  }

  /** Send now if connected, otherwise queue (bounded, §2.5 priority rules apply). */
  send(msg: Message): void {
    if (this.connected && this.socket) {
      this.sendRaw(msg);
    } else {
      this.enqueue(msg);
    }
  }

  private enqueue(msg: Message): void {
    this.queue.push(msg);
    if (this.queue.length > MAX_QUEUE) {
      const dropIndex = this.queue.findIndex((m) => !isPriority(m));
      this.queue.splice(dropIndex === -1 ? 0 : dropIndex, 1);
    }
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) {
      this.sendRaw(msg);
    }
  }

  private sendRaw(msg: Message): void {
    this.socket?.write(encodeMessage(msg));
  }

  close(): void {
    this.closed = true;
    this.socket?.end();
  }
}
