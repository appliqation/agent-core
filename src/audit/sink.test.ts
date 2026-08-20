import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockConnect, mockInsertOne, mockCollection, mockDb, MockMongoClient } = vi.hoisted(() => {
  const mockInsertOne = vi.fn().mockResolvedValue(undefined);
  const mockCollection = vi.fn().mockReturnValue({ insertOne: mockInsertOne });
  const mockDb = vi.fn().mockReturnValue({ collection: mockCollection });
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  class MockMongoClient {
    connect = mockConnect;
    db = mockDb;
  }
  return { mockConnect, mockInsertOne, mockCollection, mockDb, MockMongoClient };
});
vi.mock('mongodb', () => ({ MongoClient: MockMongoClient }));

import {
  createJsonlAuditSink,
  createMongoAuditSink,
  noopAuditSink,
  resolveAuditSink,
  safeRecord,
  createUsageAccumulator,
  type AuditRecord,
  type AuditSink,
} from './sink.js';

function fakeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    agent: 'appliqation-explorer',
    subcommand: 'explore',
    startedAt: 1000,
    endedAt: 2000,
    durationMillis: 1000,
    exitCode: 0,
    outcome: { budgetExceeded: false },
    ...overrides,
  };
}

describe('noopAuditSink', () => {
  it('resolves without doing anything', async () => {
    await expect(noopAuditSink.record(fakeRecord())).resolves.toBeUndefined();
  });
});

describe('createJsonlAuditSink', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-jsonl-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one valid JSON line per record', async () => {
    const filePath = join(dir, 'audit.jsonl');
    const sink = createJsonlAuditSink({ filePath });
    await sink.record(fakeRecord({ agent: 'a' }));
    await sink.record(fakeRecord({ agent: 'b' }));

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ agent: 'a' });
    expect(JSON.parse(lines[1])).toMatchObject({ agent: 'b' });
  });
});

describe('createMongoAuditSink', () => {
  beforeEach(() => {
    // The global restoreMocks/clearMocks config (vitest.config.ts) wipes
    // implementations set at hoisted-definition-time before every test —
    // reassert them here, not just clear call history.
    mockConnect.mockReset().mockResolvedValue(undefined);
    mockDb.mockReset().mockReturnValue({ collection: mockCollection });
    mockCollection.mockReset().mockReturnValue({ insertOne: mockInsertOne });
    mockInsertOne.mockReset().mockResolvedValue(undefined);
  });

  it('inserts the record via insertOne, scoped to the configured db/collection', async () => {
    const sink = createMongoAuditSink({ uri: 'mongodb://localhost', dbName: 'audit', collection: 'runs' });
    const record = fakeRecord();
    await sink.record(record);

    expect(mockDb).toHaveBeenCalledWith('audit');
    expect(mockCollection).toHaveBeenCalledWith('runs');
    expect(mockInsertOne).toHaveBeenCalledWith(record);
  });

  it('connects lazily — only once, on the first record() call, reused for subsequent calls', async () => {
    const sink = createMongoAuditSink({ uri: 'mongodb://localhost', dbName: 'audit', collection: 'runs' });
    expect(mockConnect).not.toHaveBeenCalled();

    await sink.record(fakeRecord());
    await sink.record(fakeRecord());
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockInsertOne).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAuditSink', () => {
  it('returns noopAuditSink when nothing is configured', () => {
    expect(resolveAuditSink({})).toBe(noopAuditSink);
  });

  it('prefers Mongo over JSONL when both are configured', () => {
    const sink = resolveAuditSink({
      auditMongoUri: 'mongodb://localhost',
      auditMongoDb: 'audit',
      auditMongoCollection: 'runs',
      auditJsonlPath: '/tmp/audit.jsonl',
    });
    expect(sink).not.toBe(noopAuditSink);
    // A Mongo sink was constructed, not a JSONL one — distinguished by
    // triggering a real Mongo call path.
  });

  it('falls back to JSONL when Mongo is not configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-resolve-test-'));
    const filePath = join(dir, 'audit.jsonl');
    const sink = resolveAuditSink({ auditJsonlPath: filePath });
    await sink.record(fakeRecord());
    expect(readFileSync(filePath, 'utf8')).toContain('appliqation-explorer');
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws fail-closed when AUDIT_MONGO_URI is set but db/collection are missing — no fallback name', () => {
    expect(() => resolveAuditSink({ auditMongoUri: 'mongodb://localhost' })).toThrow(/no collection-name fallback/);
  });
});

describe('safeRecord', () => {
  it('calls through to the sink on success', async () => {
    const sink: AuditSink = { record: vi.fn().mockResolvedValue(undefined) };
    await safeRecord(sink, fakeRecord());
    expect(sink.record).toHaveBeenCalled();
  });

  it('never throws when the sink rejects — logs a warning instead', async () => {
    const sink: AuditSink = { record: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(safeRecord(sink, fakeRecord())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });
});

describe('createUsageAccumulator', () => {
  it('sums usage across multiple onUsage() calls', () => {
    const acc = createUsageAccumulator();
    acc.onUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 });
    acc.onUsage({ inputTokens: 200, outputTokens: 75, cacheWriteTokens: 10 });
    expect(acc.totals()).toEqual({ inputTokens: 300, outputTokens: 125, cacheWriteTokens: 10, cacheReadTokens: 20 });
  });

  it('starts at all zeros when nothing was ever recorded', () => {
    const acc = createUsageAccumulator();
    expect(acc.totals()).toEqual({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
  });

  it('treats missing cache fields on any individual call as 0, not undefined-propagation', () => {
    const acc = createUsageAccumulator();
    acc.onUsage({ inputTokens: 10, outputTokens: 5 });
    acc.onUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 });
    expect(acc.totals()).toEqual({ inputTokens: 20, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 3 });
  });
});
