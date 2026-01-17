import { describe, expect, it, vi } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';

describe('core/client message creator fields', () => {
  it('extracts sender avatar/email in getThread()', async () => {
    const client = new GoogleChatClient({});

    const msgArr: any[] = [];
    msgArr[0] = [null, 'msg-1'];
    msgArr[1] = [['user-1'], 'Alice', '//example.com/avatar.png', 'alice@example.com'];
    msgArr[2] = '1700000000000000';
    msgArr[9] = 'Hello world';
    msgArr[10] = [];
    msgArr[14] = null;

    (client as any).apiRequest = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'list_messages') throw new Error(`unexpected endpoint: ${endpoint}`);
      return [[null, [msgArr]]];
    });

    const result = await client.getThread('space-1', 'topic-1', 100, false);
    expect(result.messages[0].sender).toBe('Alice');
    expect(result.messages[0].sender_email).toBe('alice@example.com');
    expect(result.messages[0].sender_avatar_url).toBe('https://example.com/avatar.png');
  });

  it('extracts sender avatar/email in getThreads(format=threaded)', async () => {
    const client = new GoogleChatClient({});

    const msgArr: any[] = [];
    msgArr[0] = [null, 'msg-1'];
    msgArr[1] = [['user-1'], 'Alice', 'https://example.com/avatar.png', 'alice@example.com'];
    msgArr[2] = '1700000000000000';
    msgArr[9] = 'Hello https://example.com.';
    msgArr[10] = [];
    msgArr[14] = null;

    const topicArr: any[] = [];
    topicArr[0] = [null, 'topic-1'];
    topicArr[1] = '1700000000000000';
    topicArr[6] = [msgArr];

    (client as any).apiRequest = vi.fn(async (endpoint: string) => {
      if (endpoint !== 'list_topics') throw new Error(`unexpected endpoint: ${endpoint}`);
      return [[null, [topicArr], null, null, false, false]];
    });

    const result = await client.getThreads('space-1', { pageSize: 25, format: 'threaded', isDm: false });
    expect(result.messages).toEqual([]);
    expect(result.topics.length).toBe(1);
    expect(result.topics[0].replies[0].sender).toBe('Alice');
    expect(result.topics[0].replies[0].sender_email).toBe('alice@example.com');
    expect(result.topics[0].replies[0].sender_avatar_url).toBe('https://example.com/avatar.png');
  });
});

