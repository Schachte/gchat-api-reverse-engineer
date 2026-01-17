import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { closeDb, getLastViewed, setLastViewed } from '../src/core/favorites.ts';

describe('core/favorites last_viewed', () => {
  it('returns null when unset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gchat-last-viewed-'));
    process.env.GCHAT_DATA_DIR = dir;
    closeDb();

    expect(getLastViewed()).toBeNull();

    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GCHAT_DATA_DIR;
  });

  it('saves and loads last viewed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gchat-last-viewed-'));
    process.env.GCHAT_DATA_DIR = dir;
    closeDb();

    const saved = setLastViewed('space-123', 'space');
    const loaded = getLastViewed();

    expect(loaded).not.toBeNull();
    expect(loaded?.channel_id).toBe('space-123');
    expect(loaded?.channel_type).toBe('space');
    expect(typeof loaded?.updated_at).toBe('number');
    expect(saved.channel_id).toBe('space-123');

    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GCHAT_DATA_DIR;
  });

  it('overwrites last viewed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gchat-last-viewed-'));
    process.env.GCHAT_DATA_DIR = dir;
    closeDb();

    setLastViewed('space-123', 'space');
    setLastViewed('dm-999', 'dm');

    const loaded = getLastViewed();
    expect(loaded?.channel_id).toBe('dm-999');
    expect(loaded?.channel_type).toBe('dm');

    closeDb();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GCHAT_DATA_DIR;
  });
});

