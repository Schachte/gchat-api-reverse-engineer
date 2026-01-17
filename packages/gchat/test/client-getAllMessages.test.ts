import { describe, expect, it } from 'vitest';

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

describe('GoogleChatClient.getAllMessages', () => {
  it('flattens messages from threaded topics', async () => {
    class StubClient extends GoogleChatClient {
      override async getThreads(_spaceId: string, options: any): Promise<any> {
        if (options.cursor === undefined) {
          return {
            messages: [],
            topics: [makeTopic('t1', [makeMsg('m1'), makeMsg('m2')])],
            pagination: { has_more: true, next_cursor: 1, contains_first_topic: false, contains_last_topic: false },
            total_topics: 1,
            total_messages: 2,
          };
        }

        return {
          messages: [],
          topics: [makeTopic('t2', [makeMsg('m2'), makeMsg('m3')])],
          pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
          total_topics: 1,
          total_messages: 2,
        };
      }
    }

    const client = new StubClient({});
    const result = await client.getAllMessages('space-1', { maxPages: 10, pageSize: 25 });

    expect(result.pages_loaded).toBe(2);
    expect(result.has_more).toBe(false);
    expect(result.topics.map((t) => t.topic_id)).toEqual(['t1', 't2']);
    expect(result.messages.map((m) => m.message_id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('respects maxMessages and marks has_more', async () => {
    class StubClient extends GoogleChatClient {
      override async getThreads(): Promise<any> {
        return {
          messages: [],
          topics: [makeTopic('t1', [makeMsg('m1'), makeMsg('m2'), makeMsg('m3')])],
          pagination: { has_more: false, contains_first_topic: true, contains_last_topic: true },
          total_topics: 1,
          total_messages: 3,
        };
      }
    }

    const client = new StubClient({});
    const result = await client.getAllMessages('space-1', { maxMessages: 2 });

    expect(result.messages.map((m) => m.message_id)).toEqual(['m1', 'm2']);
    expect(result.has_more).toBe(true);
  });
});
