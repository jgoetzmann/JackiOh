// Test helper for the audio suite (docs/polish/2-sound.md, "Tests"). It is not a test file.
//
// `FakeAudio` implements exactly the permitted Web Audio subset the design names, and nothing else:
// `currentTime`, `sampleRate`, `destination`, `createGain`, `createOscillator` (sine, square,
// sawtooth, triangle; `frequency`, `detune`), `createBiquadFilter` (lowpass, highpass, bandpass;
// `frequency`, `Q`, `gain`), `createBufferSource` (`buffer`, `playbackRate`, `loop`), `createBuffer`,
// `connect(node | AudioParam)` / `disconnect`, `start` / `stop` / `onended`, and the AudioParam
// `value`, `setValueAtTime`, `linearRampToValueAtTime`, `exponentialRampToValueAtTime`,
// `setTargetAtTime` and `cancelScheduledValues`. The engine's extras are there too:
// `createDynamicsCompressor`, `decodeAudioData`, `resume`, `close` and `state`.
//
// Every object the code under test touches is a Proxy. Reading or writing anything outside that
// subset records a violation and throws, as does anything the real API would reject (a negative
// time, a non-finite value, an exponential ramp to 0, starting a source twice). A caught throw is
// still in `violations`, so a test can assert the list is empty.
//
// The recording side (nodes, connections, start and stop times, AudioParam calls) is read from the
// `FakeAudio` controller, which the code under test never sees. The controller also owns the
// context state, a `resume()` spy, the decode behaviour, and `advance()`, which moves `currentTime`
// and fires `onended` on every source whose end has passed.
//
// Also here: a fake `SpeechPort`, a fake `fetchBytes` that resolves, rejects or hangs, and a
// settable millisecond clock.

import { vi, type Mock } from "vitest";

import type { SpeechPort } from "../engine.ts";

/* --------------------------------------------------------------------------------------------- *
 * Strictness
 * --------------------------------------------------------------------------------------------- */

/**
 * Keys that a test framework, a pretty-printer or `await` may probe on any object. They read
 * through to the underlying object (usually `undefined`) and are never violations.
 */
const PROBES: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "$$typeof",
  "asymmetricMatch",
  "nodeType",
  "tagName",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "_isMockFunction",
  "@@__IMMUTABLE_ITERABLE__@@",
  "@@__IMMUTABLE_RECORD__@@",
  "@@__IMMUTABLE_KEYED__@@",
  "@@__IMMUTABLE_ORDERED__@@",
]);

type ErrorKind = "TypeError" | "RangeError" | "InvalidStateError" | "NotSupportedError" | "IndexSizeError" | "InvalidAccessError";

function refuse(violations: string[], where: string, message: string, kind: ErrorKind = "TypeError"): never {
  const text = `${where}: ${message}`;
  violations.push(text);
  if (kind === "TypeError") throw new TypeError(text);
  if (kind === "RangeError") throw new RangeError(text);
  const error = new Error(text);
  error.name = kind;
  throw error;
}

function finite(violations: string[], where: string, value: unknown, name = "value"): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return refuse(violations, where, `${name} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function time(violations: string[], where: string, value: unknown, name = "time"): number {
  const t = finite(violations, where, value, name);
  if (t < 0) return refuse(violations, where, `${name} must be >= 0, got ${String(t)}`, "RangeError");
  return t;
}

/** Wraps `surface` so only `readable` keys can be read and only `writable` keys written. */
function strict<T extends object>(
  surface: T,
  where: string,
  readable: readonly string[],
  writable: readonly string[],
  violations: string[],
): T {
  const canRead = new Set(readable);
  const canWrite = new Set(writable);
  return new Proxy(surface, {
    get(target, key) {
      if (typeof key === "symbol" || PROBES.has(key)) return Reflect.get(target, key) as unknown;
      if (!canRead.has(key)) return refuse(violations, where, `.${key} is outside the permitted Web Audio subset`);
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
    set(target, key, value) {
      if (typeof key === "symbol" || !canWrite.has(key)) {
        return refuse(violations, where, `writing .${String(key)} is outside the permitted Web Audio subset`);
      }
      return Reflect.set(target, key, value);
    },
    defineProperty(_target, key) {
      return refuse(violations, where, `defining .${String(key)} is outside the permitted Web Audio subset`);
    },
    deleteProperty(_target, key) {
      return refuse(violations, where, `deleting .${String(key)} is outside the permitted Web Audio subset`);
    },
  });
}

/* --------------------------------------------------------------------------------------------- *
 * Records
 * --------------------------------------------------------------------------------------------- */

export type ParamEvent =
  | { method: "value"; value: number }
  | { method: "setValueAtTime"; value: number; time: number }
  | { method: "linearRampToValueAtTime"; value: number; time: number }
  | { method: "exponentialRampToValueAtTime"; value: number; time: number }
  | { method: "setTargetAtTime"; value: number; time: number; timeConstant: number }
  | { method: "cancelScheduledValues"; time: number };

export type TargetEvent = Extract<ParamEvent, { method: "setTargetAtTime" }>;

export class FakeParam {
  readonly node: FakeNode;
  readonly name: string;
  readonly defaultValue: number;
  /** Every `value` write and automation call, in order. */
  readonly events: ParamEvent[] = [];
  value: number;
  proxy: AudioParam;

  constructor(node: FakeNode, name: string, defaultValue: number) {
    this.node = node;
    this.name = name;
    this.defaultValue = defaultValue;
    this.value = defaultValue;
    this.proxy = {} as AudioParam;
  }

  /** Where the param is heading: the last value written or scheduled, else its default. */
  settled(): number {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i];
      if (event !== undefined && event.method !== "cancelScheduledValues") return event.value;
    }
    return this.defaultValue;
  }

  /** Every `setTargetAtTime` call, oldest first. */
  targets(): TargetEvent[] {
    return this.events.filter((e): e is TargetEvent => e.method === "setTargetAtTime");
  }
}

export class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  proxy: AudioBuffer;
  private readonly channels: (Float32Array | undefined)[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.channels = new Array<Float32Array | undefined>(numberOfChannels).fill(undefined);
    this.proxy = {} as AudioBuffer;
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  /** The channel's samples (allocated on first use, silent until written). */
  channel(index: number): Float32Array {
    let data = this.channels[index];
    if (data === undefined) {
      data = new Float32Array(this.length);
      this.channels[index] = data;
    }
    return data;
  }
}

export type FakeNodeKind = "destination" | "gain" | "oscillator" | "biquad" | "bufferSource" | "compressor";

export class FakeNode {
  readonly kind: FakeNodeKind;
  /** Creation order within its context (the destination is 0). */
  readonly index: number;
  /** Every `connect` target, in order. `disconnect` does not erase history. */
  readonly connections: (FakeNode | FakeParam)[] = [];
  disconnects = 0;
  readonly params = new Map<string, FakeParam>();
  /** Oscillator or filter type. */
  type: string | null = null;
  buffer: FakeBuffer | null = null;
  loop = false;
  /** The `when` passed to `start`, raw, or null while not started. */
  startTime: number | null = null;
  /** `currentTime` at the moment `start` was called. */
  startedAt: number | null = null;
  /** The `duration` argument of a buffer source's `start`, if any. */
  playDuration: number | null = null;
  /** The `when` passed to the last `stop`, raw, or null. */
  stopTime: number | null = null;
  ended = false;
  onended: ((event: Event) => void) | null = null;
  proxy: AudioNode;

  constructor(kind: FakeNodeKind, index: number) {
    this.kind = kind;
    this.index = index;
    this.proxy = {} as AudioNode;
  }

  param(name: string): FakeParam {
    const found = this.params.get(name);
    if (found === undefined) throw new Error(`${this.kind}#${String(this.index)} has no AudioParam "${name}"`);
    return found;
  }

  get started(): boolean {
    return this.startTime !== null;
  }

  /** When the source falls silent: its stop time, the end of a non-looping buffer, or never. */
  endTime(): number {
    if (this.startTime === null) return Number.NEGATIVE_INFINITY;
    const begin = Math.max(this.startTime, this.startedAt ?? 0);
    const ends: number[] = [];
    if (this.stopTime !== null) ends.push(Math.max(this.stopTime, begin));
    if (this.kind === "bufferSource" && this.buffer !== null && !this.loop) {
      const rate = this.params.get("playbackRate")?.settled() ?? 1;
      ends.push(begin + (this.playDuration ?? this.buffer.duration / (rate > 0 ? rate : 1)));
    }
    return ends.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...ends);
  }
}

/* --------------------------------------------------------------------------------------------- *
 * The context
 * --------------------------------------------------------------------------------------------- */

/** "interrupted" is Safari's; the engine must read it as "suspended". */
export type FakeContextState = "suspended" | "running" | "closed" | "interrupted";
/** What `resume()` does: "run" flips the state to running, "stay" leaves it, "reject" leaves it and rejects. */
export type ResumeMode = "run" | "stay" | "reject";
export type DecodeMode = "resolve" | "reject" | "hang";

export type FakeAudioOptions = {
  state?: FakeContextState;
  currentTime?: number;
  sampleRate?: number;
  resumeMode?: ResumeMode;
  decodeMode?: DecodeMode;
  /** Length of every successfully decoded buffer, in seconds. */
  decodedSeconds?: number;
  /** Writes each decoded buffer's samples (they are silent otherwise). */
  decodedFill?: (samples: Float32Array, sampleRate: number) => void;
};

const OSCILLATOR_TYPES = ["sine", "square", "sawtooth", "triangle"] as const;
const FILTER_TYPES = ["lowpass", "highpass", "bandpass"] as const;
const PARAM_KEYS = [
  "value",
  "setValueAtTime",
  "linearRampToValueAtTime",
  "exponentialRampToValueAtTime",
  "setTargetAtTime",
  "cancelScheduledValues",
] as const;
const CONTEXT_KEYS = [
  "currentTime",
  "sampleRate",
  "destination",
  "state",
  "createGain",
  "createOscillator",
  "createBiquadFilter",
  "createBufferSource",
  "createBuffer",
  "createDynamicsCompressor",
  "decodeAudioData",
  "resume",
  "close",
] as const;

type Hung = { resolve: (buffer: AudioBuffer) => void; reject: (error: unknown) => void };

export class FakeAudio {
  /** The strict AudioContext handed to the code under test. */
  readonly context: AudioContext;
  readonly destination: FakeNode;
  /** Every node, in creation order (the destination first). */
  readonly nodes: FakeNode[] = [];
  readonly buffers: FakeBuffer[] = [];
  /** Every AudioParam call on every node, in order. */
  readonly paramLog: { param: FakeParam; event: ParamEvent }[] = [];
  /** Every use outside the permitted subset, and every call the real API would reject. */
  readonly violations: string[] = [];
  readonly resume: Mock<() => Promise<void>>;
  readonly close: Mock<() => Promise<void>>;
  /** The bytes handed to `decodeAudioData`, in order. */
  readonly decodeCalls: ArrayBuffer[] = [];
  currentTime: number;
  readonly sampleRate: number;
  state: FakeContextState;
  resumeMode: ResumeMode;
  decodeMode: DecodeMode;
  decodedSeconds: number;
  decodedFill: ((samples: Float32Array, sampleRate: number) => void) | null;
  private readonly hungDecodes: Hung[] = [];
  private readonly records = new Map<object, FakeNode | FakeParam | FakeBuffer>();

  constructor(options: FakeAudioOptions = {}) {
    this.currentTime = options.currentTime ?? 0;
    this.sampleRate = options.sampleRate ?? 44_100;
    this.state = options.state ?? "suspended";
    this.resumeMode = options.resumeMode ?? "run";
    this.decodeMode = options.decodeMode ?? "resolve";
    this.decodedSeconds = options.decodedSeconds ?? 1;
    this.decodedFill = options.decodedFill ?? null;

    this.resume = vi.fn((): Promise<void> => {
      if (this.state === "closed") return Promise.reject(namedError("InvalidStateError", "resume() on a closed context"));
      if (this.resumeMode === "reject") return Promise.reject(namedError("NotAllowedError", "the fake refused to resume"));
      if (this.resumeMode === "run") this.state = "running";
      return Promise.resolve();
    });
    this.close = vi.fn((): Promise<void> => {
      this.state = "closed";
      return Promise.resolve();
    });

    this.destination = this.createNode("destination");
    this.context = this.makeContext();
  }

  /* ----- controller API (tests only) ----- */

  /** The record behind a node, param or buffer proxy this context handed out. */
  recordOf(proxy: unknown): FakeNode | FakeParam | FakeBuffer | undefined {
    return typeof proxy === "object" && proxy !== null ? this.records.get(proxy) : undefined;
  }

  nodeOf(proxy: unknown): FakeNode {
    const found = this.recordOf(proxy);
    if (!(found instanceof FakeNode)) throw new Error("not a node of this FakeAudio");
    return found;
  }

  bufferOf(proxy: unknown): FakeBuffer {
    const found = this.recordOf(proxy);
    if (!(found instanceof FakeBuffer)) throw new Error("not a buffer of this FakeAudio");
    return found;
  }

  nodesOf(kind: FakeNodeKind): FakeNode[] {
    return this.nodes.filter((n) => n.kind === kind);
  }

  /** Nodes with a connection into `node` (audio inputs, not param modulation). */
  inputsOf(node: FakeNode): FakeNode[] {
    return this.nodes.filter((n) => n.connections.includes(node));
  }

  /**
   * True when `from` can be heard through `to`: a path of connections leads there, where a
   * connection into an AudioParam (an LFO into a gain, say) counts as reaching that param's node.
   */
  reaches(from: FakeNode, to: FakeNode): boolean {
    const seen = new Set<FakeNode>();
    const stack: FakeNode[] = [from];
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node)) continue;
      if (node === to) return true;
      seen.add(node);
      for (const next of node.connections) stack.push(next instanceof FakeNode ? next : next.node);
    }
    return false;
  }

  startedSources(): FakeNode[] {
    return this.nodes.filter((n) => n.started);
  }

  /** Moves `currentTime` on and fires `onended` for every source whose end has now passed. */
  advance(seconds: number): void {
    this.currentTime += seconds;
    for (const node of this.nodes) {
      if (!node.started || node.ended) continue;
      if (node.endTime() <= this.currentTime + 1e-9) {
        node.ended = true;
        node.onended?.(new Event("ended"));
      }
    }
  }

  /** Resolves every decode left hanging by `decodeMode = "hang"`. */
  releaseDecodes(): void {
    for (const hung of this.hungDecodes.splice(0)) hung.resolve(this.decodedBuffer().proxy);
  }

  /** Rejects every decode left hanging by `decodeMode = "hang"`. */
  failDecodes(): void {
    for (const hung of this.hungDecodes.splice(0)) hung.reject(namedError("EncodingError", "the fake could not decode"));
  }

  /* ----- construction ----- */

  private makeContext(): AudioContext {
    const v = this.violations;
    const surface: Record<string, unknown> = {
      createGain: (): GainNode => this.createNode("gain").proxy as GainNode,
      createOscillator: (): OscillatorNode => this.createNode("oscillator").proxy as OscillatorNode,
      createBiquadFilter: (): BiquadFilterNode => this.createNode("biquad").proxy as BiquadFilterNode,
      createBufferSource: (): AudioBufferSourceNode => this.createNode("bufferSource").proxy as AudioBufferSourceNode,
      createDynamicsCompressor: (): DynamicsCompressorNode => this.createNode("compressor").proxy as DynamicsCompressorNode,
      createBuffer: (channels: unknown, length: unknown, sampleRate: unknown): AudioBuffer => {
        const where = "context.createBuffer";
        const c = finite(v, where, channels, "numberOfChannels");
        const l = finite(v, where, length, "length");
        const r = finite(v, where, sampleRate, "sampleRate");
        if (!Number.isInteger(c) || c < 1 || c > 32) refuse(v, where, `numberOfChannels ${String(c)}`, "NotSupportedError");
        if (!Number.isInteger(l) || l < 1) refuse(v, where, `length ${String(l)}`, "NotSupportedError");
        if (r < 3_000 || r > 768_000) refuse(v, where, `sampleRate ${String(r)}`, "NotSupportedError");
        return this.createBuffer(c, l, r).proxy;
      },
      decodeAudioData: (bytes: unknown, onSuccess?: unknown, onError?: unknown): Promise<AudioBuffer> => {
        const where = "context.decodeAudioData";
        if (typeof bytes !== "object" || bytes === null || typeof (bytes as { byteLength?: unknown }).byteLength !== "number") {
          return refuse(v, where, "needs an ArrayBuffer");
        }
        this.decodeCalls.push(bytes as ArrayBuffer);
        if (this.decodeMode === "resolve") {
          const buffer = this.decodedBuffer().proxy;
          if (typeof onSuccess === "function") (onSuccess as (b: AudioBuffer) => void)(buffer);
          return Promise.resolve(buffer);
        }
        if (this.decodeMode === "reject") {
          const error = namedError("EncodingError", "the fake could not decode");
          const rejected = Promise.reject(error);
          if (typeof onError === "function") {
            // A caller that chose the callback form has handled it; the promise is marked handled.
            rejected.catch(() => undefined);
            (onError as (e: unknown) => void)(error);
          }
          return rejected;
        }
        return new Promise<AudioBuffer>((resolve, reject) => {
          this.hungDecodes.push({ resolve, reject });
        });
      },
      resume: (): Promise<void> => this.resume(),
      close: (): Promise<void> => this.close(),
    };
    Object.defineProperty(surface, "currentTime", { get: () => this.currentTime, enumerable: true });
    Object.defineProperty(surface, "sampleRate", { get: () => this.sampleRate, enumerable: true });
    Object.defineProperty(surface, "destination", { get: () => this.destination.proxy, enumerable: true });
    Object.defineProperty(surface, "state", { get: () => this.state, enumerable: true });
    return strict(surface, "context", CONTEXT_KEYS, [], v) as unknown as AudioContext;
  }

  private decodedBuffer(): FakeBuffer {
    const buffer = this.createBuffer(1, Math.max(1, Math.round(this.decodedSeconds * this.sampleRate)), this.sampleRate);
    this.decodedFill?.(buffer.channel(0), this.sampleRate);
    return buffer;
  }

  private createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    const v = this.violations;
    const rec = new FakeBuffer(channels, length, sampleRate);
    const where = `buffer#${String(this.buffers.length)}`;
    const channelIndex = (c: unknown): number => {
      const i = finite(v, where, c, "channel");
      if (!Number.isInteger(i) || i < 0 || i >= rec.numberOfChannels) refuse(v, where, `no channel ${String(i)}`, "IndexSizeError");
      return i;
    };
    const surface: Record<string, unknown> = {
      getChannelData: (c: unknown): Float32Array => rec.channel(channelIndex(c)),
      copyToChannel: (source: unknown, c: unknown, start: unknown = 0): void => {
        if (!(source instanceof Float32Array)) refuse(v, where, "copyToChannel needs a Float32Array");
        const offset = time(v, where, start, "bufferOffset");
        rec.channel(channelIndex(c)).set((source as Float32Array).subarray(0, Math.max(0, rec.length - offset)), offset);
      },
    };
    Object.defineProperty(surface, "numberOfChannels", { get: () => rec.numberOfChannels, enumerable: true });
    Object.defineProperty(surface, "length", { get: () => rec.length, enumerable: true });
    Object.defineProperty(surface, "sampleRate", { get: () => rec.sampleRate, enumerable: true });
    Object.defineProperty(surface, "duration", { get: () => rec.duration, enumerable: true });
    rec.proxy = strict(
      surface,
      where,
      ["numberOfChannels", "length", "sampleRate", "duration", "getChannelData", "copyToChannel"],
      [],
      v,
    ) as unknown as AudioBuffer;
    this.records.set(rec.proxy, rec);
    this.buffers.push(rec);
    return rec;
  }

  private createParam(node: FakeNode, name: string, initial: number): FakeParam {
    const v = this.violations;
    const rec = new FakeParam(node, name, initial);
    const where = `${node.kind}#${String(node.index)}.${name}`;
    const log = (event: ParamEvent): AudioParam => {
      rec.events.push(event);
      this.paramLog.push({ param: rec, event });
      return rec.proxy;
    };
    const surface: Record<string, unknown> = {
      setValueAtTime: (value: unknown, t: unknown): AudioParam =>
        log({ method: "setValueAtTime", value: finite(v, where, value), time: time(v, where, t) }),
      linearRampToValueAtTime: (value: unknown, t: unknown): AudioParam =>
        log({ method: "linearRampToValueAtTime", value: finite(v, where, value), time: time(v, where, t) }),
      exponentialRampToValueAtTime: (value: unknown, t: unknown): AudioParam => {
        const target = finite(v, where, value);
        if (target <= 0) refuse(v, where, `exponentialRampToValueAtTime needs a target > 0, got ${String(target)}`, "RangeError");
        return log({ method: "exponentialRampToValueAtTime", value: target, time: time(v, where, t) });
      },
      setTargetAtTime: (value: unknown, t: unknown, timeConstant: unknown): AudioParam =>
        log({
          method: "setTargetAtTime",
          value: finite(v, where, value),
          time: time(v, where, t),
          timeConstant: time(v, where, timeConstant, "timeConstant"),
        }),
      cancelScheduledValues: (t: unknown): AudioParam => log({ method: "cancelScheduledValues", time: time(v, where, t) }),
    };
    Object.defineProperty(surface, "value", {
      get: () => rec.value,
      set: (value: unknown) => {
        rec.value = finite(v, `${where}.value`, value);
        log({ method: "value", value: rec.value });
      },
      enumerable: true,
    });
    rec.proxy = strict(surface, where, PARAM_KEYS, ["value"], v) as unknown as AudioParam;
    this.records.set(rec.proxy, rec);
    node.params.set(name, rec);
    return rec;
  }

  private createNode(kind: FakeNodeKind): FakeNode {
    const v = this.violations;
    const rec = new FakeNode(kind, this.nodes.length);
    const where = `${kind}#${String(rec.index)}`;
    const readable: string[] = ["connect", "disconnect"];
    const writable: string[] = [];
    const surface: Record<string, unknown> = {
      connect: (target: unknown, ...indices: unknown[]): unknown => {
        if (kind === "destination") refuse(v, `${where}.connect`, "the destination has no outputs", "IndexSizeError");
        const to = this.recordOf(target);
        if (to === undefined || to instanceof FakeBuffer) {
          return refuse(v, `${where}.connect`, "the target is not a node or AudioParam of this context", "InvalidAccessError");
        }
        for (const index of indices) {
          if (index !== undefined && index !== 0) refuse(v, `${where}.connect`, `no output or input ${String(index)}`, "IndexSizeError");
        }
        rec.connections.push(to);
        return to instanceof FakeNode ? to.proxy : undefined;
      },
      disconnect: (): void => {
        rec.disconnects += 1;
      },
    };
    const param = (name: string, initial: number): void => {
      const p = this.createParam(rec, name, initial);
      Object.defineProperty(surface, name, { get: () => p.proxy, enumerable: true });
      readable.push(name);
    };
    const typed = (allowed: readonly string[], initial: string): void => {
      rec.type = initial;
      Object.defineProperty(surface, "type", {
        get: () => rec.type,
        set: (value: unknown) => {
          if (typeof value !== "string" || !allowed.includes(value)) {
            refuse(v, `${where}.type`, `"${String(value)}" is outside the permitted types (${allowed.join(", ")})`);
          }
          rec.type = value as string;
        },
        enumerable: true,
      });
      readable.push("type");
      writable.push("type");
    };
    const source = (): void => {
      surface.start = (when: unknown = 0, offset?: unknown, duration?: unknown): void => {
        if (rec.startTime !== null) refuse(v, `${where}.start`, "start() called twice", "InvalidStateError");
        const t = time(v, `${where}.start`, when, "when");
        if (offset !== undefined) {
          if (kind !== "bufferSource") refuse(v, `${where}.start`, "an oscillator's start takes only `when`");
          time(v, `${where}.start`, offset, "offset");
        }
        if (duration !== undefined) {
          if (kind !== "bufferSource") refuse(v, `${where}.start`, "an oscillator's start takes only `when`");
          rec.playDuration = time(v, `${where}.start`, duration, "duration");
        }
        rec.startTime = t;
        rec.startedAt = this.currentTime;
      };
      surface.stop = (when: unknown = 0): void => {
        if (rec.startTime === null) refuse(v, `${where}.stop`, "stop() before start()", "InvalidStateError");
        rec.stopTime = time(v, `${where}.stop`, when, "when");
      };
      Object.defineProperty(surface, "onended", {
        get: () => rec.onended,
        set: (fn: unknown) => {
          rec.onended = typeof fn === "function" ? (fn as (event: Event) => void) : null;
        },
        enumerable: true,
      });
      readable.push("start", "stop", "onended");
      writable.push("onended");
    };

    switch (kind) {
      case "destination":
        break;
      case "gain":
        param("gain", 1);
        break;
      case "oscillator":
        typed(OSCILLATOR_TYPES, "sine");
        param("frequency", 440);
        param("detune", 0);
        source();
        break;
      case "biquad":
        typed(FILTER_TYPES, "lowpass");
        param("frequency", 350);
        param("Q", 1);
        param("gain", 0);
        break;
      case "bufferSource":
        param("playbackRate", 1);
        Object.defineProperty(surface, "buffer", {
          get: () => rec.buffer?.proxy ?? null,
          set: (value: unknown) => {
            if (value === null) {
              rec.buffer = null;
              return;
            }
            const buffer = this.recordOf(value);
            if (!(buffer instanceof FakeBuffer)) refuse(v, `${where}.buffer`, "must be an AudioBuffer of this context");
            if (rec.buffer !== null) refuse(v, `${where}.buffer`, "can only be set once", "InvalidStateError");
            rec.buffer = buffer as FakeBuffer;
          },
          enumerable: true,
        });
        Object.defineProperty(surface, "loop", {
          get: () => rec.loop,
          set: (value: unknown) => {
            rec.loop = value === true;
          },
          enumerable: true,
        });
        readable.push("buffer", "loop");
        writable.push("buffer", "loop");
        source();
        break;
      case "compressor":
        param("threshold", -24);
        param("knee", 30);
        param("ratio", 12);
        param("attack", 0.003);
        param("release", 0.25);
        Object.defineProperty(surface, "reduction", { get: () => 0, enumerable: true });
        readable.push("reduction");
        break;
    }

    rec.proxy = strict(surface, where, readable, writable, v) as unknown as AudioNode;
    this.records.set(rec.proxy, rec);
    this.nodes.push(rec);
    return rec;
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(`${name}: ${message}`);
  error.name = name;
  return error;
}

/** A `createContext` factory for `createAudioEngine`, keeping every context it constructs. */
export type FakeContextFactory = {
  create: Mock<() => AudioContext>;
  made: FakeAudio[];
  /** The newest context, or a thrown error when none has been constructed. */
  last(): FakeAudio;
};

export function fakeContextFactory(options: FakeAudioOptions = {}): FakeContextFactory {
  const made: FakeAudio[] = [];
  const create = vi.fn((): AudioContext => {
    const audio = new FakeAudio(options);
    made.push(audio);
    return audio.context;
  });
  return {
    create,
    made,
    last() {
      const audio = made.at(-1);
      if (audio === undefined) throw new Error("no AudioContext has been constructed");
      return audio;
    },
  };
}

/* --------------------------------------------------------------------------------------------- *
 * Speech, fetch, clock
 * --------------------------------------------------------------------------------------------- */

export type SpokenLine = {
  text: string;
  voice: { pitch: number; rate: number; volume: number };
  onEnd: () => void;
};

export type FakeSpeech = {
  port: SpeechPort;
  spoken: SpokenLine[];
  speak: Mock<SpeechPort["speak"]>;
  cancel: Mock<SpeechPort["cancel"]>;
};

export function fakeSpeech(): FakeSpeech {
  const spoken: SpokenLine[] = [];
  const speak = vi.fn<SpeechPort["speak"]>((text, voice, onEnd) => {
    spoken.push({ text, voice: { ...voice }, onEnd });
  });
  const cancel = vi.fn<SpeechPort["cancel"]>();
  return { port: { speak, cancel }, spoken, speak, cancel };
}

export type FetchMode = "resolve" | "reject" | "hang";

type HungFetch = { url: string; resolve: (bytes: ArrayBuffer) => void; reject: (error: unknown) => void };

/** A `fetchBytes` whose answer is chosen per test: resolve (fresh bytes), reject, or hang until released. */
export class FakeFetch {
  mode: FetchMode = "resolve";
  /** Per-URL overrides of `mode`. */
  readonly modes = new Map<string, FetchMode>();
  readonly fetchBytes: Mock<(url: string) => Promise<ArrayBuffer>>;
  private readonly hung: HungFetch[] = [];

  constructor() {
    this.fetchBytes = vi.fn((url: string): Promise<ArrayBuffer> => {
      const mode = this.modes.get(url) ?? this.mode;
      if (mode === "resolve") return Promise.resolve(new ArrayBuffer(16));
      if (mode === "reject") return Promise.reject(new Error(`fake fetch: 404 ${url}`));
      return new Promise<ArrayBuffer>((resolve, reject) => {
        this.hung.push({ url, resolve, reject });
      });
    });
  }

  /** Every URL requested, in order. */
  urls(): string[] {
    return this.fetchBytes.mock.calls.map((call) => call[0]);
  }

  /** Resolves the hanging requests (all, or those for `url`); returns how many. */
  release(url?: string): number {
    return this.settle(url, (h) => h.resolve(new ArrayBuffer(16)));
  }

  /** Rejects the hanging requests (all, or those for `url`); returns how many. */
  fail(url?: string): number {
    return this.settle(url, (h) => h.reject(new Error(`fake fetch: failed ${h.url}`)));
  }

  private settle(url: string | undefined, how: (h: HungFetch) => void): number {
    const picked = this.hung.filter((h) => url === undefined || h.url === url);
    for (const h of picked) {
      this.hung.splice(this.hung.indexOf(h), 1);
      how(h);
    }
    return picked.length;
  }
}

/** A settable millisecond clock for the engine's and the UI sounds' `now`. */
export class FakeClock {
  ms: number;

  constructor(start = 1_000) {
    this.ms = start;
  }

  readonly now = (): number => this.ms;

  advance(ms: number): void {
    this.ms += ms;
  }

  set(ms: number): void {
    this.ms = ms;
  }
}

/** Lets every already-settled promise chain run (fetch → decode → start), without moving any clock. */
export async function settle(rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
