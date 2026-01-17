import { describe, expect, it, vi } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';

type FakeMessage = { message_id?: string; text: string };
type FakeTopic = {
  topic_id: string;
  space_id: string;
  message_count: number;
  replies: FakeMessage[];
};

function makeMsg(id: string): FakeMessage {
  return { message_id: id, text: `msg:${id}` };
}

function makeTopic(id: string, replies: FakeMessage[]): FakeTopic {
  return { topic_id: id, space_id: 'space-1', message_count: replies.length, replies };
}

describe('GoogleChatClient.getThreads', () => {
  it('tries server-side filtering by default when since/until is provided', async () => {
    const client = new GoogleChatClient({});

    (client as any).populateSenderNames = vi.fn(async () => {});
    (client as any).fetchTopicsWithClientSideFiltering = vi.fn(async () => {
      throw new Error('client-side filtering should not run');
    });

    const apiRequest = vi.fn(async (endpoint: string) => {
      // getThreads should call catch_up_group (proto payload content isn't important for this test).
      if (endpoint !== 'catch_up_group') throw new Error(`unexpected endpoint: ${endpoint}`);
      return [];
    });

    const serverResult = {
      messages: [],
      topics: [makeTopic('t1', [makeMsg('m1')])],
      pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
      total_topics: 1,
      total_messages: 1,
    };

    (client as any).apiRequest = apiRequest;
    (client as any).parseCatchUpGroupResponse = vi.fn(() => serverResult);

    const result = await client.getThreads('space-1', { since: 1, format: 'threaded' });

    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith('catch_up_group', expect.any(Uint8Array));
    expect((client as any).parseCatchUpGroupResponse).toHaveBeenCalledTimes(1);
    expect((client as any).fetchTopicsWithClientSideFiltering).not.toHaveBeenCalled();

    // format=threaded returns topics, empty flat messages
    expect(result.messages).toEqual([]);
    expect(result.topics.map((t) => t.topic_id)).toEqual(['t1']);
  });

  it('falls back to client-side filtering when server returns 0 topics', async () => {
    const client = new GoogleChatClient({});

    (client as any).populateSenderNames = vi.fn(async () => {});

    const apiRequest = vi.fn(async () => []);
    (client as any).apiRequest = apiRequest;

    (client as any).parseCatchUpGroupResponse = vi.fn(() => ({
      messages: [],
      topics: [],
      pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
      total_topics: 0,
      total_messages: 0,
    }));

    const clientSide = vi.fn(async () => ({
      messages: [],
      topics: [makeTopic('t-client', [makeMsg('m-client')])],
      pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
      total_topics: 1,
      total_messages: 1,
    }));
    (client as any).fetchTopicsWithClientSideFiltering = clientSide;

    const result = await client.getThreads('space-1', { since: 1, format: 'threaded' });

    expect(apiRequest).toHaveBeenCalledWith('catch_up_group', expect.any(Uint8Array));
    expect(clientSide).toHaveBeenCalledTimes(1);
    expect(result.topics.map((t) => t.topic_id)).toEqual(['t-client']);
  });

  it('skips server-side filtering when useServerFiltering=false', async () => {
    const client = new GoogleChatClient({});

    (client as any).populateSenderNames = vi.fn(async () => {});

    const apiRequest = vi.fn(async () => {
      throw new Error('server-side filtering should not run');
    });
    (client as any).apiRequest = apiRequest;

    const clientSide = vi.fn(async () => ({
      messages: [],
      topics: [makeTopic('t1', [makeMsg('m1')])],
      pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
      total_topics: 1,
      total_messages: 1,
    }));
    (client as any).fetchTopicsWithClientSideFiltering = clientSide;

    const result = await client.getThreads('space-1', { since: 1, useServerFiltering: false, format: 'threaded' });

    expect(apiRequest).not.toHaveBeenCalled();
    expect(clientSide).toHaveBeenCalledTimes(1);
    expect(result.topics.map((t) => t.topic_id)).toEqual(['t1']);
  });
});
