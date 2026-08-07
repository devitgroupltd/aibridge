import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { attachPtyWriteGuard } from "../src/pty-write-guard.ts";

/** A minimal stand-in for node-pty's real `IPty`/`WindowsTerminal`, close enough to reproduce the
 * live 2026-08-06 crash: an internal socket error re-emitted as `'error'` on the pty object itself,
 * which - per Node's own `EventEmitter` contract - throws if nothing is listening for it.
 *
 * `_agent.inSocket` mirrors the real (private, underscore-prefixed) shape reached into for the
 * 2026-08-07 write-side fix: a separate `EventEmitter` node-pty never itself attaches an `'error'`
 * listener to, unlike the pty object's own read-side socket. */
class FakePty extends EventEmitter {
  writeImpl: (data: string) => void = () => {};
  _agent = { inSocket: new EventEmitter() };
  write(data: string): void {
    this.writeImpl(data);
  }
}

describe("attachPtyWriteGuard", () => {
  test("a synchronous write() throw is caught and logged, not rethrown", () => {
    const pty = new FakePty();
    pty.writeImpl = () => {
      throw new Error("Socket is closed");
    };
    const warnings: string[] = [];
    const write = attachPtyWriteGuard(pty, "some-slug", {
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });

    expect(() => write("hello")).not.toThrow();
    expect(warnings[0]).toMatch(/some-slug/);
    expect(warnings[0]).toMatch(/Socket is closed/);
  });

  test("a healthy write() passes the text through untouched", () => {
    const pty = new FakePty();
    const received: string[] = [];
    pty.writeImpl = (data) => received.push(data);
    const write = attachPtyWriteGuard(pty, "some-slug");

    write("hello\r");
    expect(received).toEqual(["hello\r"]);
  });

  test("an 'error' event on the pty itself is suppressed, not left to crash the process - the actual live regression: node-pty's WindowsTerminal rethrows a socket error from inside its own IO callback (bypassing any try/catch around write()) unless the pty has a second 'error' listener besides its own", () => {
    const pty = new FakePty();
    const warnings: string[] = [];
    attachPtyWriteGuard(pty, "some-slug", {
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });

    // Node's EventEmitter throws synchronously on an unhandled 'error' emit - this only passes if
    // attachPtyWriteGuard actually registered a listener.
    expect(() => pty.emit("error", new Error("Socket is closed"))).not.toThrow();
    expect(warnings[0]).toMatch(/some-slug/);
    expect(warnings[0]).toMatch(/Socket is closed/);
  });

  test("an 'error' event on the private inSocket (the write side) is suppressed too - the live 2026-08-07 regression: writeModeKeystrokes wrote into a session whose underlying process had already died, and node-pty attaches no 'error' listener of its own to this socket at all (unlike the read-side _socket), so an unhandled emit here throws straight into uncaughtException regardless of listeners on the pty object itself", () => {
    const pty = new FakePty();
    const warnings: string[] = [];
    attachPtyWriteGuard(pty, "some-slug", {
      log: (level, message) => {
        if (level === "WARN") warnings.push(message);
      },
    });

    expect(() => pty._agent.inSocket.emit("error", new Error("Socket is closed"))).not.toThrow();
    expect(warnings[0]).toMatch(/some-slug/);
    expect(warnings[0]).toMatch(/Socket is closed/);
  });

  test("a pty with no _agent (e.g. the Unix backend) is left alone - only the read-side 'error' listener is required there", () => {
    const pty = new EventEmitter() as EventEmitter & { write(data: string): void };
    pty.write = () => {};
    expect(() => attachPtyWriteGuard(pty, "some-slug")).not.toThrow();
    expect(() => pty.emit("error", new Error("boom"))).not.toThrow();
  });

  test("with no log callback given, neither a write throw nor an error event blows up", () => {
    const pty = new FakePty();
    pty.writeImpl = () => {
      throw new Error("Socket is closed");
    };
    const write = attachPtyWriteGuard(pty, "some-slug");

    expect(() => write("hello")).not.toThrow();
    expect(() => pty.emit("error", new Error("boom"))).not.toThrow();
  });
});
