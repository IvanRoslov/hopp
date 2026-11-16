import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFit, FakeResizeObserver, FakeXterm, fakeTerminalBridge } from '../../../test/renderer';

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXterm }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: FakeFit }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const { Terminal } = await import('./Terminal');

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

let b: ReturnType<typeof fakeTerminalBridge>;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeXterm.instances = [];
  FakeResizeObserver.instances = [];
  FakeFit.next = { cols: 100, rows: 30 };
  (globalThis as any).ResizeObserver = FakeResizeObserver;
  b = fakeTerminalBridge();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('<Terminal>', () => {
  it('opens the session at the fitted size, shows output, sends input', async () => {
    render(<Terminal sessionId="s1" bridge={b} />);
    await flush();
    expect(b.open).toHaveBeenCalledWith('s1', 100, 30);
    const x = FakeXterm.instances[0]!;
    act(() => b.emitData('t1', 'hello'));
    act(() => b.emitData('t9', 'not mine'));
    expect(x.text).toBe('hello');
    x.type('ls\r');
    expect(b.write).toHaveBeenCalledWith('t1', 'ls\r');
  });

  it('on exit prints one ended line, stops input and does not reopen', async () => {
    const onEnded = vi.fn();
    render(<Terminal sessionId="s1" bridge={b} onEnded={onEnded} />);
    await flush();
    const x = FakeXterm.instances[0]!;
    act(() => b.emitExit('t1', 0));
    expect(x.text).toMatch(/terminal closed/);
    expect(x.text.match(/terminal closed/g)).toHaveLength(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
    x.type('x');
    expect(b.write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.open).toHaveBeenCalledTimes(1);
  });

  it('unmount closes the terminal and drops listeners', async () => {
    const { unmount } = render(<Terminal sessionId="s1" bridge={b} />);
    await flush();
    unmount();
    expect(b.close).toHaveBeenCalledWith('t1');
    expect(b.listeners).toBe(0);
    expect(FakeXterm.instances[0]!.disposed).toBe(true);
  });

  it('unmount before open resolves still closes the terminal', async () => {
    let resolve!: (id: string) => void;
    b.open.mockImplementationOnce(() => new Promise<string>((r) => (resolve = r)));
    const { unmount } = render(<Terminal sessionId="s1" bridge={b} />);
    unmount();
    resolve('t7');
    await flush();
    expect(b.close).toHaveBeenCalledWith('t7');
  });

  it('a new session id closes the old terminal and opens the new one', async () => {
    const { rerender } = render(<Terminal sessionId="s1" bridge={b} />);
    await flush();
    rerender(<Terminal sessionId="s2" bridge={b} />);
    await flush();
    expect(b.close).toHaveBeenCalledWith('t1');
    expect(b.open).toHaveBeenLastCalledWith('s2', 100, 30);
  });

  it('resizes only when its container changed size, debounced', async () => {
    render(<Terminal sessionId="s1" bridge={b} />);
    await flush();
    // Same size: no resize.
    FakeResizeObserver.fire();
    await vi.advanceTimersByTimeAsync(200);
    expect(b.resize).not.toHaveBeenCalled();
    FakeFit.next = { cols: 120, rows: 40 };
    FakeResizeObserver.fire();
    FakeResizeObserver.fire();
    FakeResizeObserver.fire();
    await vi.advanceTimersByTimeAsync(200);
    expect(b.resize).toHaveBeenCalledTimes(1);
    expect(b.resize).toHaveBeenCalledWith('t1', 120, 40);
  });

  it('shows why it could not open', async () => {
    b.open.mockRejectedValueOnce(new Error("Error invoking remote method 'terminal:open': Error: session not found: s1"));
    render(<Terminal sessionId="s1" bridge={b} />);
    await flush();
    expect(FakeXterm.instances[0]!.text).toMatch(/cannot open the terminal: session not found: s1/);
  });
});
