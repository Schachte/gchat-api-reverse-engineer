import { describe, expect, it } from 'vitest';

import { GoogleChatClient } from '../src/core/client.ts';
import { GoogleChatChannel } from '../src/core/channel.ts';

describe('Presence parsing', () => {
  it('GoogleChatClient.parseUserPresence unwraps nested userId + string enums', () => {
    const client = new GoogleChatClient({} as any);
    const parseUserPresence = (item: unknown[]) => (client as any).parseUserPresence(item);

    const item = [
      [[['1234567890']], 1],
      '1', 
      '1700000000000000', 
      '2', 
      [null, ['In a meeting', '💬', '1700000000000000']], 
    ];

    const parsed = parseUserPresence(item);
    expect(parsed).toMatchObject({
      userId: '1234567890',
      presence: 1,
      presenceLabel: 'active',
      dndState: 2,
      dndLabel: 'dnd',
      activeUntilUsec: 1700000000000000,
      customStatus: {
        statusText: 'In a meeting',
        statusEmoji: '💬',
        expiryTimestampUsec: 1700000000000000,
      },
    });
  });

  it('GoogleChatClient.parsePresenceResponse supports multiple wrapper shapes', () => {
    const client = new GoogleChatClient({} as any);
    const parsePresenceResponse = (data: unknown[], requested: string[]) => (client as any).parsePresenceResponse(data, requested);

    const presenceItem = [[['42']], 2, 0, 1, null];

    const shapeA = [['header', [presenceItem]]];
    expect(parsePresenceResponse(shapeA, ['42']).presences).toHaveLength(1);

    const shapeB = [['header', null, [presenceItem]]];
    expect(parsePresenceResponse(shapeB, ['42']).presences).toHaveLength(1);

    const shapeC = [presenceItem];
    expect(parsePresenceResponse(shapeC, ['42']).presences).toHaveLength(1);
  });

  it('GoogleChatChannel._parseUserStatusEvent parses string enums', () => {
    const channel = new GoogleChatChannel('');
    const parseUserStatusEvent = (channel as any)._parseUserStatusEvent as (body: unknown[]) => any;

    const statusData = [
      [[['99']], 1], 
      '2', 
      '1700000000000000', 
      '2', 
      [null, ['OOO', '🏝️', '1700000000000000']], 
    ];

    const body: unknown[] = [];
    (body as any)[22] = statusData;

    const parsed = parseUserStatusEvent(body);
    expect(parsed.userStatus).toMatchObject({
      userId: '99',
      presence: 2,
      presenceLabel: 'inactive',
      dndState: 2,
      dndLabel: 'dnd',
      activeUntilUsec: 1700000000000000,
      customStatus: {
        statusText: 'OOO',
        statusEmoji: '🏝️',
        expiryTimestampUsec: 1700000000000000,
      },
    });
  });
});
