import { describe, expect, it } from 'vitest';

import { auth, logger, unreads, utils } from '../src/index.ts';

describe('client public exports', () => {
  it('exports utils namespace', () => {
    expect(typeof utils.exportChatBatches).toBe('function');
    expect(typeof utils.startStayOnline).toBe('function');
    expect(typeof utils.parseTimeToUsec).toBe('function');
  });

  it('exports core namespaces', () => {
    expect(typeof auth.getCookies).toBe('function');
    expect(typeof logger.createLogger).toBe('function');
    expect(typeof unreads.createUnreadService).toBe('function');
  });
});
