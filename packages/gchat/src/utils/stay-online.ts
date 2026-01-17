import { GoogleChatChannel, type ChannelEvent, type Conversation } from '../core/channel.js';
import type { GoogleChatClient } from '../core/client.js';

export type StayOnlineEvent =
  | { type: 'connect'; timestamp: string }
  | { type: 'disconnect'; timestamp: string }
  | { type: 'subscribed'; timestamp: string; conversations: number }
  | { type: 'ping'; timestamp: string; count: number }
  | { type: 'error'; timestamp: string; error: Error }
  | { type: 'message'; timestamp: string; event: ChannelEvent }
  | { type: 'typing'; timestamp: string; event: ChannelEvent };

export interface StayOnlineOptions {
  pingIntervalSec?: number;
  presenceTimeoutSec?: number;
  /**
   * Subscribe to conversations for real-time events.
   * This can also be used to ensure presence visibility (Chat often requires active subs).
   */
  subscribe?: boolean;
  conversations?: Conversation[];
  /**
   * If subscribe=true and conversations are not provided, list spaces via the client.
   */
  fetchConversations?: boolean;
  /**
   * Override how the WebChannel is created (useful for testing or custom transports).
   */
  createChannel?: (cookieString: string) => GoogleChatChannel;
  /**
   * Emit structured lifecycle events (connect/ping/message/etc).
   */
  onEvent?: (evt: StayOnlineEvent) => void;
}

export interface StayOnlineSession {
  channel: GoogleChatChannel;
  stop: () => void;
  done: Promise<void>;
}

/**
 * Keep your Google Chat presence "online" by maintaining a WebChannel connection
 * and periodically refreshing presence sharing.
 *
 * Requires an authenticated client (or it will authenticate on demand).
 */
export async function startStayOnline(
  client: GoogleChatClient,
  options: StayOnlineOptions = {}
): Promise<StayOnlineSession> {
  const {
    pingIntervalSec = 60,
    presenceTimeoutSec = 120,
    subscribe = false,
    fetchConversations = true,
    createChannel = (cookieString: string) => new GoogleChatChannel(cookieString),
    onEvent,
  } = options;

  // Ensure auth/cookie string is available.
  await client.authenticate();
  const cookieString = client.getCookieString();

  let conversations: Conversation[] = options.conversations || [];
  if (subscribe && conversations.length === 0 && fetchConversations) {
    const spaces = await client.listSpaces();
    conversations = spaces.map((s) => ({
      id: s.id,
      type: (s.type || 'space') as 'space' | 'dm',
      name: s.name,
    }));
  }

  const channel = createChannel(cookieString);
  let pingCount = 0;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let isStopping = false;

  const emit = (evt: StayOnlineEvent) => onEvent?.(evt);

  const stop = () => {
    if (isStopping) return;
    isStopping = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    channel.disconnect();
  };

  channel.on('connect', async () => {
    const timestamp = new Date().toISOString();
    emit({ type: 'connect', timestamp });

    if (subscribe && conversations.length > 0) {
      try {
        await channel.subscribeToAll(conversations);
        emit({ type: 'subscribed', timestamp, conversations: conversations.length });
      } catch (err) {
        emit({ type: 'error', timestamp, error: err as Error });
      }
    }

    // Prime presence state immediately on connect.
    try {
      await channel.sendPing();
      await client.setPresenceShared(true, presenceTimeoutSec);
    } catch (err) {
      emit({ type: 'error', timestamp, error: err as Error });
    }

    // Periodic refresh.
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(async () => {
      const ts = new Date().toISOString();
      try {
        pingCount++;
        await channel.sendPing();
        await client.setPresenceShared(true, presenceTimeoutSec);
        emit({ type: 'ping', timestamp: ts, count: pingCount });
      } catch (err) {
        emit({ type: 'error', timestamp: ts, error: err as Error });
      }
    }, pingIntervalSec * 1000);
  });

  channel.on('disconnect', () => {
    const timestamp = new Date().toISOString();
    emit({ type: 'disconnect', timestamp });
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  });

  channel.on('error', (err) => {
    const timestamp = new Date().toISOString();
    emit({ type: 'error', timestamp, error: err as Error });
  });

  channel.on('message', (evt) => {
    const timestamp = new Date().toISOString();
    emit({ type: 'message', timestamp, event: evt as ChannelEvent });
  });

  channel.on('typing', (evt) => {
    const timestamp = new Date().toISOString();
    emit({ type: 'typing', timestamp, event: evt as ChannelEvent });
  });

  const done = channel.connect();
  return { channel, stop, done };
}
