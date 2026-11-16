// Test doubles for renderer tests: a fake xterm, a controllable
// ResizeObserver, and a fake terminal bridge.
import { vi } from 'vitest';
import type { TerminalBridge } from '../src/shared/bridge';

export class FakeXterm {
  static instances: FakeXterm[] = [];
  cols = 80;
  rows = 24;
  written: string[] = [];
  disposed = false;
  private dataCb: ((d: string) => void) | null = null;
  constructor(public opts: unknown) {
    FakeXterm.instances.push(this);
  }
  loadAddon(a: { activate?: (t: FakeXterm) => void }) {
    a.activate?.(this);
  }
  open() {}
  focus() {}
  write(d: string) {
    this.written.push(d);
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose: () => (this.dataCb = null) };
  }
  type(d: string) {
    this.dataCb?.(d);
  }
  dispose() {
    this.disposed = true;
  }
  get text() {
    return this.written.join('');
  }
}

// FakeFit "fits" to whatever size the test sets as the container's next size.
export class FakeFit {
  static next = { cols: 100, rows: 30 };
  private t: FakeXterm | null = null;
  activate(t: FakeXterm) {
    this.t = t;
  }
  fit() {
    if (this.t) {
      this.t.cols = FakeFit.next.cols;
      this.t.rows = FakeFit.next.rows;
    }
  }
  dispose() {}
}

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  disconnected = false;
  constructor(public cb: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  static fire() {
    for (const o of FakeResizeObserver.instances) if (!o.disconnected) o.cb();
  }
}

export function fakeTerminalBridge() {
  const dataCbs = new Set<(id: string, d: string) => void>();
  const exitCbs = new Set<(id: string, c: number) => void>();
  let seq = 0;
  const b = {
    open: vi.fn(async (_s: string, _c: number, _r: number) => 't' + ++seq),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: (cb: (id: string, d: string) => void) => {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },
    onExit: (cb: (id: string, c: number) => void) => {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    emitData: (id: string, d: string) => dataCbs.forEach((cb) => cb(id, d)),
    emitExit: (id: string, c: number) => exitCbs.forEach((cb) => cb(id, c)),
    get listeners() {
      return dataCbs.size + exitCbs.size;
    },
  };
  return b satisfies TerminalBridge & Record<string, unknown>;
}
