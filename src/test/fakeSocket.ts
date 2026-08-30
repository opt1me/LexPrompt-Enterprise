import type { ClientFrame, ServerFrame } from '@lexprompt/core';
import { setSocketFactory } from '../lib/api/socket';

/**
 * A `WebSocket` a test drives, and ONE copy of it.
 *
 * jsdom has no `WebSocket` and a real one would need a server, so
 * `src/lib/api/socket.ts` takes its constructor through a seam. Two suites
 * need to drive that seam — `socket.test.ts`, which is about the state
 * machine, and `runs.test.ts`, which is about `watchRun` keeping its
 * signature over it — and a second hand-rolled fake is the sibling drift
 * this project has six findings about, on the object both suites' meaning
 * depends on.
 *
 * `mount.tsx` is the precedent: one harness, imported, rather than a fake
 * per file.
 */
export interface FakeSocket {
  url: string;
  protocols: string[];
  /** Every frame the module under test sent, parsed. */
  sent: ClientFrame[];
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
  /** Completes the handshake. */
  open(): void;
  /** Hands the module one server frame. */
  deliver(frame: ServerFrame): void;
  /** Closes it the way a network does — from the other end. */
  drop(): void;
}

export interface SocketHarness {
  /** Every socket the module has constructed, in order. */
  sockets: FakeSocket[];
  /** Waits for socket `index` to exist, opens it, and returns it. */
  opened(index?: number): Promise<FakeSocket>;
  /** Restores the real factory. */
  restore(): void;
}

/**
 * MICROTASKS ONLY — no `setTimeout(0)`.
 *
 * These suites run on fake timers, so a `setTimeout` inside a wait helper
 * never fires and every test hangs until vitest's own five-second ceiling.
 * What is being waited for is `ensureSocket`'s `await getAccessToken()`,
 * which is a resolved promise: draining microtasks is exactly the right
 * instrument and a real delay is exactly the wrong one.
 */
export async function flushMicrotasks(
  condition: () => boolean, what = 'the condition', ticks = 200,
): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`${what} never became true`);
}

/** Installs the fake and returns the harness. Call `restore()` in `afterEach`. */
export function installFakeSockets(): SocketHarness {
  const sockets: FakeSocket[] = [];
  const previous = setSocketFactory(((url: string, protocols: string[]) => {
    const ws: FakeSocket = {
      url,
      protocols,
      sent: [],
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data: string) { ws.sent.push(JSON.parse(data) as ClientFrame); },
      close() { ws.drop(); },
      open() {
        ws.readyState = 1;
        ws.onopen?.();
      },
      deliver(frame: ServerFrame) { ws.onmessage?.({ data: JSON.stringify(frame) }); },
      drop() {
        if (ws.readyState === 3) return;
        ws.readyState = 3;
        ws.onclose?.();
      },
    };
    sockets.push(ws);
    return ws;
  }) as unknown as Parameters<typeof setSocketFactory>[0]);

  return {
    sockets,
    async opened(index = 0) {
      await flushMicrotasks(
        () => sockets.length > index, `socket ${index} was never created`);
      const ws = sockets[index];
      ws.open();
      return ws;
    },
    restore() { setSocketFactory(previous); },
  };
}
