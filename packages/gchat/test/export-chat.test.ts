import { describe, expect, it, vi } from 'vitest';

import { exportChatBatches } from '../src/utils/export-chat.ts';

type FakeMessage = { message_id?: string; text: string };
type FakeTopic = {
  topic_id: string;
  space_id: string;
  message_count: number;
  has_more_replies?: boolean;
  replies: FakeMessage[];
};

function makeMsg(id: string): FakeMessage {
  return { message_id: id, text: `msg:${id}` };
}

function makeTopic(id: string, replies: FakeMessage[]): FakeTopic {
  return {
    topic_id: id,
    space_id: 'space-1',
    message_count: replies.length,
    replies,
  };
}

describe('utils/export-chat', () => {
  it('paginates using next cursors and preserves initial anchor', async () => {
    const fetchTopicsWithServerPagination = vi
      .fn()
      .mockResolvedValueOnce({
        topics: [makeTopic('t1', [makeMsg('m1')])],
        messages: [],
        pagination: {
          has_more: true,
          next_sort_time_cursor: 'c1',
          next_timestamp_cursor: 'ts1',
          anchor_timestamp: 'a1',
          contains_first_topic: false,
          contains_last_topic: false,
        },
        total_topics: 1,
        total_messages: 1,
      })
      .mockResolvedValueOnce({
        topics: [makeTopic('t2', [makeMsg('m2')])],
        messages: [],
        pagination: {
          has_more: false,
          next_sort_time_cursor: 'c2',
          next_timestamp_cursor: 'ts2',
          anchor_timestamp: 'a2',
          contains_first_topic: false,
          contains_last_topic: true,
        },
        total_topics: 1,
        total_messages: 1,
      });

    const client = {
      fetchTopicsWithServerPagination,
      getThread: vi.fn(),
    } as any;

    const batches: any[] = [];
    for await (const batch of exportChatBatches(client, 'space-1', {
      pageSize: 10,
      maxPages: 10,
      cursors: { sortTimeCursor: 's0', timestampCursor: 'ts0' },
    })) {
      batches.push(batch);
    }

    expect(batches).toHaveLength(2);

    expect(fetchTopicsWithServerPagination).toHaveBeenNthCalledWith(
      1,
      'space-1',
      expect.objectContaining({
        pageSize: 10,
        sortTimeCursor: 's0',
        timestampCursor: 'ts0',
        anchorTimestamp: undefined,
      })
    );
    expect(fetchTopicsWithServerPagination).toHaveBeenNthCalledWith(
      2,
      'space-1',
      expect.objectContaining({
        pageSize: 10,
        sortTimeCursor: 'c1',
        timestampCursor: 'ts1',
        anchorTimestamp: 'a1',
      })
    );

    expect(batches[0].cursors).toEqual({ sortTimeCursor: 's0', timestampCursor: 'ts0', anchorTimestamp: 'a1' });
    expect(batches[1].cursors).toEqual({ sortTimeCursor: 'c1', timestampCursor: 'ts1', anchorTimestamp: 'a1' });

    expect(batches[0].messages.map((m: FakeMessage) => m.message_id)).toEqual(['m1']);
    expect(batches[1].messages.map((m: FakeMessage) => m.message_id)).toEqual(['m2']);
  });

  it('expands threads when fullThreads=true', async () => {
    const topicTruncated = makeTopic('t1', [makeMsg('m1')]);
    topicTruncated.message_count = 10;
    topicTruncated.has_more_replies = true;

    const topicFails = makeTopic('t2', [makeMsg('m2')]);
    topicFails.message_count = 5;
    topicFails.has_more_replies = true;

    const fetchTopicsWithServerPagination = vi.fn().mockResolvedValueOnce({
      topics: [topicTruncated, topicFails],
      messages: [],
      pagination: {
        has_more: false,
        next_sort_time_cursor: undefined,
        next_timestamp_cursor: undefined,
        anchor_timestamp: 'a1',
        contains_first_topic: true,
        contains_last_topic: true,
      },
      total_topics: 2,
      total_messages: 2,
    });

    const getThread = vi
      .fn()
      .mockResolvedValueOnce({
        topic_id: 't1',
        space_id: 'space-1',
        total_messages: 3,
        messages: [makeMsg('m1'), makeMsg('m1b'), makeMsg('m1c')],
      })
      .mockRejectedValueOnce(new Error('boom'));

    const client = {
      fetchTopicsWithServerPagination,
      getThread,
    } as any;

    const iter = exportChatBatches(client, 'space-1', {
      fullThreads: true,
      threadPageSize: 999,
      maxPages: 1,
    });

    const { value: batch, done } = await iter.next();
    expect(done).toBe(false);
    expect(batch.topics).toHaveLength(2);

    expect(getThread).toHaveBeenCalledWith('space-1', 't1', 999, undefined);
    expect(batch.topics[0].replies.map((m: FakeMessage) => m.message_id)).toEqual(['m1', 'm1b', 'm1c']);
    expect(batch.topics[0].message_count).toBe(3);
    expect(batch.topics[0].has_more_replies).toBe(false);

    expect(getThread).toHaveBeenCalledWith('space-1', 't2', 999, undefined);
    expect(batch.topics[1].replies.map((m: FakeMessage) => m.message_id)).toEqual(['m2']);

    expect(batch.messages.map((m: FakeMessage) => m.message_id)).toEqual(['m1', 'm1b', 'm1c', 'm2']);
  });

  it('throws when aborted before fetch', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = {
      fetchTopicsWithServerPagination: vi.fn(),
    } as any;

    const iter = exportChatBatches(client, 'space-1', { signal: controller.signal });
    await expect(iter.next()).rejects.toThrow('Aborted');
    expect(client.fetchTopicsWithServerPagination).not.toHaveBeenCalled();
  });

  it('parses relative since/until values to microseconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-04T00:00:00.000Z'));

    try {
      const fetchTopicsWithServerPagination = vi.fn().mockResolvedValueOnce({
        topics: [makeTopic('t1', [makeMsg('m1')])],
        messages: [],
        pagination: {
          has_more: false,
          next_sort_time_cursor: undefined,
          next_timestamp_cursor: undefined,
          anchor_timestamp: 'a1',
          contains_first_topic: true,
          contains_last_topic: true,
        },
        total_topics: 1,
        total_messages: 1,
      });

      const client = { fetchTopicsWithServerPagination } as any;

      const iter = exportChatBatches(client, 'space-1', { since: '7d', until: '24h', maxPages: 1 });
      await iter.next();

      const nowMs = new Date('2026-02-04T00:00:00.000Z').getTime();
      const expectedSinceUsec = (nowMs - 7 * 24 * 60 * 60 * 1000) * 1000;
      const expectedUntilUsec = (nowMs - 24 * 60 * 60 * 1000) * 1000;

      expect(fetchTopicsWithServerPagination).toHaveBeenCalledWith(
        'space-1',
        expect.objectContaining({
          since: expectedSinceUsec,
          until: expectedUntilUsec,
        })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on invalid since/until values', async () => {
    const client = { fetchTopicsWithServerPagination: vi.fn() } as any;

    const iter1 = exportChatBatches(client, 'space-1', { since: 'not-a-date' });
    await expect(iter1.next()).rejects.toThrow(/Invalid 'since' value/);

    const iter2 = exportChatBatches(client, 'space-1', { until: 'not-a-date' });
    await expect(iter2.next()).rejects.toThrow(/Invalid 'until' value/);

    expect(client.fetchTopicsWithServerPagination).not.toHaveBeenCalled();
  });

  it('stops when reached_since_boundary is true', async () => {
    const fetchTopicsWithServerPagination = vi.fn().mockResolvedValueOnce({
      topics: [makeTopic('t1', [makeMsg('m1')])],
      messages: [],
      pagination: {
        has_more: true,
        next_sort_time_cursor: 'c1',
        next_timestamp_cursor: 'ts1',
        anchor_timestamp: 'a1',
        contains_first_topic: false,
        contains_last_topic: false,
        reached_since_boundary: true,
      },
      total_topics: 1,
      total_messages: 1,
    });

    const client = { fetchTopicsWithServerPagination } as any;

    const pages: any[] = [];
    for await (const batch of exportChatBatches(client, 'space-1')) pages.push(batch);

    expect(pages).toHaveLength(1);
    expect(fetchTopicsWithServerPagination).toHaveBeenCalledTimes(1);
  });

  it('honors maxPages even if has_more stays true', async () => {
    const fetchTopicsWithServerPagination = vi
      .fn()
      .mockResolvedValue({
        topics: [makeTopic('t1', [makeMsg('m1')])],
        messages: [],
        pagination: {
          has_more: true,
          next_sort_time_cursor: 'c1',
          next_timestamp_cursor: 'ts1',
          anchor_timestamp: 'a1',
          contains_first_topic: false,
          contains_last_topic: false,
        },
        total_topics: 1,
        total_messages: 1,
      });

    const client = { fetchTopicsWithServerPagination } as any;

    const pages: any[] = [];
    for await (const batch of exportChatBatches(client, 'space-1', { maxPages: 2 })) pages.push(batch);

    expect(pages).toHaveLength(2);
    expect(fetchTopicsWithServerPagination).toHaveBeenCalledTimes(2);
  });
});
