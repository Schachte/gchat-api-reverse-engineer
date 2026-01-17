import { describe, expect, it, vi } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';

function makeRawMsg(params: {
  messageId: string;
  senderId?: string;
  senderName?: string;
  senderEmail?: string;
  createTimeUsec: string;
  text: string;
}): unknown[] {
  const raw: unknown[] = [];
  raw[0] = [null, params.messageId];
  raw[1] = [[params.senderId ?? 'u1'], params.senderName ?? 'Alice', null, params.senderEmail ?? 'alice@example.com'];
  raw[2] = params.createTimeUsec;
  raw[9] = params.text;
  raw[10] = null;
  raw[14] = null;
  return raw;
}

function makeRawTopic(params: {
  topicId: string;
  sortTimeUsec: string;
  messages: unknown[];
}): unknown[] {
  const raw: unknown[] = [];
  raw[0] = [null, params.topicId];
  raw[1] = params.sortTimeUsec;
  raw[6] = params.messages;
  return raw;
}

describe('GoogleChatClient.fetchTopicsWithServerPagination', () => {
  it('builds space list_topics JSON/PBLite payload', async () => {
    const client = new GoogleChatClient({} as any);
    const apiRequestJson = vi.fn(async () => [['dfe.t.lt', [], null, null, true, true]]);
    (client as any).apiRequestJson = apiRequestJson;

    await client.fetchTopicsWithServerPagination('AAAA0123456', { pageSize: 30 });

    expect(apiRequestJson).toHaveBeenCalledWith('list_topics', expect.any(Array), 'AAAA0123456');
    const payload = apiRequestJson.mock.calls[0][1] as unknown[];
    expect(payload).toHaveLength(91);
    expect(payload[1]).toBe(30);
    expect(payload[4]).toEqual([3, 1, 4]);
    expect(payload[5]).toBe(1000);
    expect(payload[6]).toBe(30);
    expect(payload[7]).toEqual([['AAAA0123456']]);
  });

  it('builds DM list_topics JSON/PBLite payload', async () => {
    const client = new GoogleChatClient({} as any);
    const apiRequestJson = vi.fn(async () => [['dfe.t.lt', [], null, null, true, true]]);
    (client as any).apiRequestJson = apiRequestJson;

    await client.fetchTopicsWithServerPagination('dm-123', { pageSize: 20 });

    expect(apiRequestJson).toHaveBeenCalledWith('list_topics', expect.any(Array), 'dm-123');
    const payload = apiRequestJson.mock.calls[0][1] as any[];
    expect(payload[4]).toEqual([3, 4]);
    expect(payload[6]).toBe(20);
    expect(payload[7]).toEqual([null, null, ['dm-123']]);
  });

  it('uses `until` as initial sortTimeCursor when no cursor provided', async () => {
    const client = new GoogleChatClient({} as any);
    const apiRequestJson = vi.fn(async () => [['dfe.t.lt', [], null, null, true, true]]);
    (client as any).apiRequestJson = apiRequestJson;

    await client.fetchTopicsWithServerPagination('AAAA0123456', { pageSize: 30, until: 100 });

    const payload = apiRequestJson.mock.calls[0][1] as any[];
    expect(payload[3]).toEqual(['100000000']);
  });

  it('computes next_sort_time_cursor as (lastSortTime - 1) when has_more=true', async () => {
    const client = new GoogleChatClient({} as any);
    const raw = [
      [
        'dfe.t.lt',
        [
          makeRawTopic({
            topicId: 't1',
            sortTimeUsec: '1700000000000000',
            messages: [makeRawMsg({ messageId: 'm1', createTimeUsec: '1700000000000000', text: 'hi' })],
          }),
          makeRawTopic({
            topicId: 't2',
            sortTimeUsec: '1699999999999990',
            messages: [makeRawMsg({ messageId: 'm2', createTimeUsec: '1699999999999990', text: 'yo' })],
          }),
        ],
        ['ts-next'],
        ['anchor-1'],
        false,
        true,
      ],
    ];

    (client as any).apiRequestJson = vi.fn(async () => raw);

    const res = await client.fetchTopicsWithServerPagination('AAAA0123456', { pageSize: 2 });

    expect(res.pagination.has_more).toBe(true);
    expect(res.pagination.next_sort_time_cursor).toBe('1699999999999989');
    expect(res.pagination.next_timestamp_cursor).toBe('ts-next');
    expect(res.pagination.anchor_timestamp).toBe('anchor-1');
  });

  it('sets reached_since_boundary=true and has_more=false when last raw topic is older than since', async () => {
    const client = new GoogleChatClient({} as any);
    const raw = [
      [
        'dfe.t.lt',
        [
          makeRawTopic({
            topicId: 't-old',
            sortTimeUsec: '1699999999999999',
            messages: [makeRawMsg({ messageId: 'm-old', createTimeUsec: '1699999999999999', text: 'old' })],
          }),
        ],
        null,
        null,
        false,
        true,
      ],
    ];

    (client as any).apiRequestJson = vi.fn(async () => raw);

    const res = await client.fetchTopicsWithServerPagination('AAAA0123456', {
      pageSize: 2,
      since: '1700000000000000',
    });

    expect(res.topics).toHaveLength(0);
    expect(res.pagination.reached_since_boundary).toBe(true);
    expect(res.pagination.has_more).toBe(false);
    expect(res.pagination.next_sort_time_cursor).toBeUndefined();
  });

  it('skips topics newer than `until`', async () => {
    const client = new GoogleChatClient({} as any);
    const raw = [
      [
        'dfe.t.lt',
        [
          makeRawTopic({
            topicId: 't-new',
            sortTimeUsec: '1700000000001000',
            messages: [makeRawMsg({ messageId: 'm-new', createTimeUsec: '1700000000001000', text: 'new' })],
          }),
          makeRawTopic({
            topicId: 't-ok',
            sortTimeUsec: '1699999999999000',
            messages: [makeRawMsg({ messageId: 'm-ok', createTimeUsec: '1699999999999000', text: 'ok' })],
          }),
        ],
        null,
        null,
        false,
        true,
      ],
    ];

    (client as any).apiRequestJson = vi.fn(async () => raw);

    const res = await client.fetchTopicsWithServerPagination('AAAA0123456', {
      pageSize: 10,
      until: '1700000000000000',
    });

    expect(res.topics.map((t) => t.topic_id)).toEqual(['t-ok']);
    expect(res.messages.map((m) => m.message_id)).toEqual(['m-ok']);
  });
});
