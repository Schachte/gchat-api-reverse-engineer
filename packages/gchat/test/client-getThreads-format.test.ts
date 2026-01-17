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
  return { topic_id: id, space_id: 'AAAA0123456', message_count: replies.length, replies };
}

describe('GoogleChatClient.getThreads (format)', () => {
  it('format=messages returns only topic starters', async () => {
    const client = new GoogleChatClient({} as any);
    (client as any).populateSenderNames = vi.fn(async () => {});

    const fetchTopics = vi.fn(async () => ({
      messages: [],
      topics: [
        makeTopic('t1', [makeMsg('m1'), makeMsg('m1b')]),
        makeTopic('t2', [makeMsg('m2')]),
      ],
      pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
      total_topics: 2,
      total_messages: 3,
    }));
    (client as any).fetchTopicsWithClientSideFiltering = fetchTopics;

    const res = await client.getThreads('AAAA0123456', { format: 'messages', useServerFiltering: false });

    expect(fetchTopics).toHaveBeenCalledTimes(1);
    expect(res.topics).toEqual([]);
    expect(res.messages.map((m: FakeMessage) => m.message_id)).toEqual(['m1', 'm2']);
    expect(res.total_topics).toBe(2);
    expect(res.total_messages).toBe(2);
  });
});
