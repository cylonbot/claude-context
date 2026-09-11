import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IndexAbortError } from "@zilliz/claude-context-core";
import { SyncManager } from "./sync.js";

// Each test gets its own HOME (where the global sync lock lives) and sync log, plus a real
// codebase directory, since the sync cycle skips paths that don't exist.
async function withTempHome(run: (paths: { repo: string; lockPath: string; logPath: string }) => Promise<void>): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-context-mcp-sync-takeover-"));
    const overrides: Record<string, string> = {
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        CLAUDE_CONTEXT_SYNC_LOG: path.join(tempRoot, "sync.log"),
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);

    const repo = path.join(tempRoot, "repo");
    fs.mkdirSync(repo);
    try {
        await run({
            repo,
            lockPath: path.join(tempRoot, ".context", "mcp-sync.lock"),
            logPath: overrides.CLAUDE_CONTEXT_SYNC_LOG,
        });
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function until(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 1000 && !predicate(); i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(predicate(), "condition never became true");
}

test("cancelCodebaseSync aborts the in-flight run on that codebase and waits for it", async () => {
    await withTempHome(async ({ repo, lockPath, logPath }) => {
        let runSignal: AbortSignal | undefined;
        const context = {
            // A run that only ends when it is cancelled, like one paced on a rate-limited key.
            reindexByChange: (...args: unknown[]) => new Promise((_resolve, reject) => {
                runSignal = args[5] as AbortSignal;
                runSignal.addEventListener("abort", () => reject(new IndexAbortError("aborted by test")));
            }),
        };
        const snapshot = { getIndexedCodebases: () => [repo], getCodebaseInfo: () => undefined };
        const manager = new SyncManager(context as any, snapshot as any);

        const cycle = manager.handleSyncIndex();
        await until(() => runSignal !== undefined);
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8"));
        assert.equal(owner.codebase, repo, "the lock announces the codebase being synced");
        assert.equal(await manager.cancelCodebaseSync(path.join(repo, "..", "elsewhere")), false);

        assert.equal(await manager.cancelCodebaseSync(repo), true);
        assert.equal(runSignal!.aborted, true);
        await cycle;

        assert.match(fs.readFileSync(logPath, "utf8"), /reindexByChange ABORTED 'repo'/);
        assert.equal(fs.existsSync(lockPath), false, "the cycle still releases the lock");
    });
});

test("skips a codebase that is no longer indexed by the time the cycle reaches it", async () => {
    await withTempHome(async ({ repo, logPath }) => {
        let reads = 0;
        const snapshot = {
            // Indexed when the cycle starts; taken over (e.g. by a force re-index) when the loop gets to it.
            getIndexedCodebases: () => (reads++ === 0 ? [repo] : []),
            getCodebaseInfo: () => undefined,
        };
        let reindexCalls = 0;
        const context = {
            reindexByChange: async () => {
                reindexCalls++;
                return { added: 0, removed: 0, modified: 0 };
            },
        };

        await new SyncManager(context as any, snapshot as any).handleSyncIndex();

        assert.equal(reindexCalls, 0);
        assert.match(fs.readFileSync(logPath, "utf8"), /reindexByChange SKIP 'repo'/);
    });
});
