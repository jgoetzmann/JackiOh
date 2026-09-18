/**
 * In-memory `Socket`s (src/match/contracts.ts).
 *
 * `createFakeSocket` is one end the actor talks to and the test reads; `createSocketPair` wires
 * two of them together so a test can drive a "client" that looks exactly like a WebSocket peer
 * without opening a port. The real `ws` adapter satisfies the same interface, so what the actor
 * does here is what it does on the wire.
 */

import type { Socket, SocketHandlers } from "../../src/match/contracts";

export type FakeSocket = Socket & {
  /** Every frame the server sent, in order. */
  readonly sent: string[];
  /** Every frame the server sent, parsed. */
  messages: <T = Record<string, unknown>>() => T[];
  /** The last frame the server sent, parsed. */
  last: <T = Record<string, unknown>>() => T | undefined;
  /** Frames of one `type`, parsed. */
  ofType: <T = Record<string, unknown>>(type: string) => T[];
  /** Simulate the client sending a frame. */
  receive: (text: string) => void;
  /** Simulate the client sending JSON. */
  receiveJson: (value: unknown) => void;
  /** Simulate the transport dropping. */
  drop: () => void;
  clear: () => void;
  readonly closeCode: number | null;
};

export function createFakeSocket(): FakeSocket {
  const sent: string[] = [];
  let handlers: SocketHandlers | null = null;
  let open = true;
  let closeCode: number | null = null;

  const socket: FakeSocket = {
    sent,
    get isOpen() {
      return open;
    },
    get closeCode() {
      return closeCode;
    },
    send: (text) => {
      if (!open) throw new Error("send on a closed socket");
      sent.push(text);
    },
    close: (code) => {
      if (!open) return;
      open = false;
      closeCode = code ?? 1000;
      handlers?.close();
    },
    attach: (next) => {
      handlers = next;
    },
    messages: <T>() => sent.map((text) => JSON.parse(text) as T),
    last: <T>() => {
      const text = sent.at(-1);
      return text === undefined ? undefined : (JSON.parse(text) as T);
    },
    ofType: <T>(type: string) =>
      sent
        .map((text) => JSON.parse(text) as { type?: string })
        .filter((message) => message.type === type) as T[],
    receive: (text) => {
      if (!open) throw new Error("receive on a closed socket");
      handlers?.message(text);
    },
    receiveJson: (value) => {
      socket.receive(JSON.stringify(value));
    },
    drop: () => {
      if (!open) return;
      open = false;
      closeCode = 1006;
      handlers?.close();
    },
    clear: () => {
      sent.length = 0;
    },
  };

  return socket;
}

/** Two fake sockets, one per seat, for a two-client test. */
export function createSocketPair(): { p1: FakeSocket; p2: FakeSocket } {
  return { p1: createFakeSocket(), p2: createFakeSocket() };
}
