import { describe, expect, it, vi } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';

describe('GoogleChatClient request helpers', () => {
  it('parseXssiJson strips XSSI prefixes', () => {
    const client = new GoogleChatClient({} as any);
    const parseXssiJson = (client as any).parseXssiJson as (raw: string) => unknown;

    expect(parseXssiJson(`)]}'\n{\"ok\":true}`)).toEqual({ ok: true });
    expect(parseXssiJson(`)]}'{\"ok\":true}`)).toEqual({ ok: true });
    expect(parseXssiJson(`  {\"ok\":true}  `)).toEqual({ ok: true });
  });

  it('fetchWithAuthRetry retries once on 401/403', async () => {
    const client = new GoogleChatClient({} as any);
    client.authenticate = vi.fn(async () => undefined) as any;

    const doFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 403 } as any)
      .mockResolvedValueOnce({ ok: true, status: 200 } as any);

    const res = await (client as any).fetchWithAuthRetry(doFetch);

    expect(client.authenticate).toHaveBeenCalledWith(true);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
  });

  it('fetchWithAuthRetry does not retry for non-auth failures', async () => {
    const client = new GoogleChatClient({} as any);
    client.authenticate = vi.fn(async () => undefined) as any;

    const doFetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500 } as any);
    const res = await (client as any).fetchWithAuthRetry(doFetch);

    expect(client.authenticate).not.toHaveBeenCalled();
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});
