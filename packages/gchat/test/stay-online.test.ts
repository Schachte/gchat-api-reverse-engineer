import { describe, expect, it, vi } from 'vitest';

import { startStayOnline } from '../src/utils/stay-online.ts';

type Listener = (...args: any[]) => void;

class MockChannel {
  readonly cookieString: string;
  private listeners: Record<string, Listener[]> = {};
  private resolveDone: (() => void) | undefined;

  subscribeToAll = vi.fn(async () => {});
  sendPing = vi.fn(async () => {});
  disconnect = vi.fn(() => {
    this.emit('disconnect');
    this.resolveDone?.();
  });

  constructor(cookieString: string) {
    this.cookieString = cookieString;
  }

  on(event: string, cb: Listener): void {
    (this.listeners[event] ||= []).push(cb);
  }

  emit(event: string, ...args: any[]): void {
    for (const cb of this.listeners[event] || []) cb(...args);
  }

  connect = vi.fn(() => {
    queueMicrotask(() => this.emit('connect'));
    return new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  });
}

describe('utils/stay-online', () => {
  it('pings on an interval and stops cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const events: any[] = [];
    let channel: MockChannel | undefined;

    const client = {
      authenticate: vi.fn(async () => {}),
      getCookieString: vi.fn(() => 'cookie=abc'),
      listSpaces: vi.fn(async () => []),
      setPresenceShared: vi.fn(async () => {}),
    } as any;

    const session = await startStayOnline(client, {
      subscribe: true,
      fetchConversations: false,
      conversations: [
        { id: 'space-1', type: 'space', name: 'Space 1' },
        { id: 'space-2', type: 'space', name: 'Space 2' },
      ],
      pingIntervalSec: 10,
      presenceTimeoutSec: 120,
      createChannel: (cookie) => {
        channel = new MockChannel(cookie);
        return channel as any;
      },
      onEvent: (evt) => events.push(evt),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.authenticate).toHaveBeenCalledTimes(1);
    expect(client.getCookieString).toHaveBeenCalledTimes(1);

    expect(channel).toBeDefined();
    expect(channel?.cookieString).toBe('cookie=abc');
    expect(channel?.connect).toHaveBeenCalledTimes(1);

    expect(channel?.subscribeToAll).toHaveBeenCalledTimes(1);
    expect(channel?.subscribeToAll).toHaveBeenCalledWith([
      { id: 'space-1', type: 'space', name: 'Space 1' },
      { id: 'space-2', type: 'space', name: 'Space 2' },
    ]);

    expect(channel?.sendPing).toHaveBeenCalledTimes(1);
    expect(client.setPresenceShared).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(channel?.sendPing).toHaveBeenCalledTimes(2);
    expect(client.setPresenceShared).toHaveBeenCalledTimes(2);

    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['connect', 'subscribed', 'ping']));

    session.stop();
    await Promise.resolve();
    await session.done;

    const pingCallsAfterStop = channel?.sendPing.mock.calls.length ?? 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();
    expect(channel?.sendPing.mock.calls.length ?? 0).toBe(pingCallsAfterStop);

    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['disconnect']));

    vi.useRealTimers();
  });

  it('fetches conversations when subscribe=true and none provided', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    let channel: MockChannel | undefined;
    const client = {
      authenticate: vi.fn(async () => {}),
      getCookieString: vi.fn(() => 'cookie=abc'),
      listSpaces: vi.fn(async () => [
        { id: 'space-1', type: 'space', name: 'Space 1' },
        { id: 'dm-1', type: 'dm', name: 'DM 1' },
      ]),
      setPresenceShared: vi.fn(async () => {}),
    } as any;

    const session = await startStayOnline(client, {
      subscribe: true,
      fetchConversations: true,
      pingIntervalSec: 60,
      createChannel: (cookie) => {
        channel = new MockChannel(cookie);
        return channel as any;
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.listSpaces).toHaveBeenCalledTimes(1);
    expect(channel?.subscribeToAll).toHaveBeenCalledWith([
      { id: 'space-1', type: 'space', name: 'Space 1' },
      { id: 'dm-1', type: 'dm', name: 'DM 1' },
    ]);

    session.stop();
    await session.done;
    vi.useRealTimers();
  });

  it('does not subscribe when subscribe=false', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    let channel: MockChannel | undefined;
    const client = {
      authenticate: vi.fn(async () => {}),
      getCookieString: vi.fn(() => 'cookie=abc'),
      listSpaces: vi.fn(async () => [{ id: 'space-1', type: 'space', name: 'Space 1' }]),
      setPresenceShared: vi.fn(async () => {}),
    } as any;

    const session = await startStayOnline(client, {
      subscribe: false,
      pingIntervalSec: 60,
      createChannel: (cookie) => {
        channel = new MockChannel(cookie);
        return channel as any;
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.listSpaces).not.toHaveBeenCalled();
    expect(channel?.subscribeToAll).not.toHaveBeenCalled();

    session.stop();
    await session.done;
    vi.useRealTimers();
  });

  it('emits an error event when ping fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));

    const events: any[] = [];
    let channel: MockChannel | undefined;

    const client = {
      authenticate: vi.fn(async () => {}),
      getCookieString: vi.fn(() => 'cookie=abc'),
      listSpaces: vi.fn(async () => []),
      setPresenceShared: vi.fn(async () => {}),
    } as any;

    const session = await startStayOnline(client, {
      subscribe: false,
      pingIntervalSec: 60,
      createChannel: (cookie) => {
        channel = new MockChannel(cookie);
        channel.sendPing = vi.fn(async () => {
          throw new Error('ping-fail');
        });
        return channel as any;
      },
      onEvent: (evt) => events.push(evt),
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(events.some((e) => e.type === 'error' && e.error?.message === 'ping-fail')).toBe(true);

    session.stop();
    await session.done;
    vi.useRealTimers();
  });
});
