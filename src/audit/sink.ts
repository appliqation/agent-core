// Observability, not a knowledge channel: an AuditRecord is a record of what
// an invocation did, for a human to read later (a dashboard, an ad-hoc query)
// — never something fed back into a future agent's own decision-making, which
// is exactly what keeps this distinct from the write-trust boundary
// enrich_project_context's action=write sits behind (see tools/projectContext.ts).
// A write here failing must never affect the real task it's describing — see
// safeRecord() below, the one function every CLI should actually call.

import { MongoClient, type Collection } from 'mongodb';
import { appendFile } from 'node:fs/promises';

export interface AuditRecord {
  /** e.g. 'appliqation-autotest', 'appliqation-autopilot'. */
  agent: string;
  /** e.g. 'judge', 'generate', 'fix', 'explore', 'raise', 'run'. */
  subcommand: string;
  startedAt: number;
  endedAt: number;
  durationMillis: number;
  /** Absent for agents with no LLM loop at all (appliqation-pr-raise). */
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
  };
  turns?: number;
  budgetExceeded?: boolean;
  exitCode: number;
  /** The CLI's own already-built --json summary object, verbatim — no second schema to maintain. */
  outcome: Record<string, unknown>;
}

export interface AuditSink {
  record(entry: AuditRecord): Promise<void>;
}

export const noopAuditSink: AuditSink = {
  async record() {
    // Intentionally does nothing — the default when no sink is configured.
  },
};

export function createJsonlAuditSink(opts: { filePath: string }): AuditSink {
  return {
    async record(entry) {
      await appendFile(opts.filePath, JSON.stringify(entry) + '\n', 'utf8');
    },
  };
}

export function createMongoAuditSink(opts: { uri: string; dbName: string; collection: string }): AuditSink {
  let collectionPromise: Promise<Collection<AuditRecord>> | undefined;

  function getCollection(): Promise<Collection<AuditRecord>> {
    // Lazy-connect-once: the client is created and connected on the first
    // record() call, then reused — a CLI invocation that never calls
    // record() (e.g. audit unconfigured elsewhere in the same process)
    // never opens a connection at all.
    if (!collectionPromise) {
      const client = new MongoClient(opts.uri);
      collectionPromise = client.connect().then(() => client.db(opts.dbName).collection<AuditRecord>(opts.collection));
    }
    return collectionPromise;
  }

  return {
    async record(entry) {
      const collection = await getCollection();
      await collection.insertOne(entry);
    },
  };
}

/**
 * The one function CLIs should actually call — never `sink.record()` directly.
 * An audit write is observability, not part of the task it's describing: a
 * failure here (a down Mongo instance, a bad path) must never affect the real
 * run's exit code or output, so it's caught and logged as a warning, not
 * propagated. Same reasoning as browserTools.ts's screenshot-staging failure
 * already being non-fatal.
 */
export async function safeRecord(sink: AuditSink, entry: AuditRecord): Promise<void> {
  try {
    await sink.record(entry);
  } catch (err) {
    console.error(`[audit] failed to record: ${(err as Error).message}`);
  }
}

export interface AuditEnv {
  auditMongoUri?: string;
  auditMongoDb?: string;
  auditMongoCollection?: string;
  auditJsonlPath?: string;
}

/**
 * Precedence mirrors resolveProvider()'s own shape: Mongo (if fully
 * configured) > JSONL > noop. Nothing writes anywhere unless explicitly
 * configured — same BYO-credential/optional posture as every LLM key and
 * resolveApiAuth() elsewhere in this family.
 */
export function resolveAuditSink(env: AuditEnv): AuditSink {
  if (env.auditMongoUri) {
    if (!env.auditMongoDb || !env.auditMongoCollection) {
      throw new Error('AUDIT_MONGO_URI is set but AUDIT_MONGO_DB/AUDIT_MONGO_COLLECTION are missing — no collection-name fallback.');
    }
    return createMongoAuditSink({ uri: env.auditMongoUri, dbName: env.auditMongoDb, collection: env.auditMongoCollection });
  }
  if (env.auditJsonlPath) return createJsonlAuditSink({ filePath: env.auditJsonlPath });
  return noopAuditSink;
}

interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/** Sums usage across however many 'usage' onEvent callbacks a run emits into one invocation-level total. */
export function createUsageAccumulator() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;

  return {
    onUsage(u: UsageDelta): void {
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
      cacheWriteTokens += u.cacheWriteTokens ?? 0;
      cacheReadTokens += u.cacheReadTokens ?? 0;
    },
    totals(): AuditRecord['usage'] {
      return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens };
    },
  };
}
