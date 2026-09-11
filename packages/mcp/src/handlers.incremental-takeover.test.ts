import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-takeover-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }

        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }

        await rm(tempRoot, { recursive: true, force: true });
    }
}

/** A codebase that the snapshot (and, via the fake context, the vector DB) consider indexed. */
async function indexedCodebase(tempRoot: string): Promise<{ codebasePath: string; snapshotManager: SnapshotManager }> {
    const codebasePath = path.join(tempRoot, "repo");
    await mkdir(codebasePath, { recursive: true });
    const snapshotManager = new SnapshotManager();
    snapshotManager.setCodebaseIndexed(codebasePath, { indexedFiles: 1, totalChunks: 1, status: "completed" });
    snapshotManager.saveCodebaseSnapshot();
    return { codebasePath, snapshotManager };
}

function newHandlers(
    context: object,
    snapshotManager: SnapshotManager,
    sync: { cancelCodebaseSync(codebasePath: string): Promise<boolean>; getForeignCodebaseSync(codebasePath: string): number | null }
): ToolHandlers {
    const handlers = new ToolHandlers(context as any, snapshotManager, sync);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => { };
    return handlers;
}

const busyElsewhere = { cancelCodebaseSync: async () => false, getForeignCodebaseSync: () => 4242 };

test("index_codebase force refuses while another session is syncing the codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const { codebasePath, snapshotManager } = await indexedCodebase(tempRoot);
        let cleared = 0;
        const handlers = newHandlers(
            { hasIndex: async () => true, clearIndex: async () => { cleared++; } },
            snapshotManager,
            busyElsewhere
        );

        const result = await handlers.handleIndexCodebase({ path: codebasePath, force: true });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /another claude-context MCP process \(pid 4242/);
        assert.equal(cleared, 0);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("index_codebase force stops this session's own run before clearing the index", async () => {
    await withTempHome(async (tempRoot) => {
        const { codebasePath, snapshotManager } = await indexedCodebase(tempRoot);
        const events: string[] = [];
        const handlers = newHandlers(
            {
                hasIndex: async () => true,
                clearIndex: async () => { events.push("clear"); },
                // Ends the call right after the clear, before background indexing would start.
                getVectorDatabase: () => ({ checkCollectionLimit: async () => false }),
            },
            snapshotManager,
            {
                cancelCodebaseSync: async (p) => { events.push(`cancel ${p}`); return true; },
                getForeignCodebaseSync: () => null,
            }
        );

        await handlers.handleIndexCodebase({ path: codebasePath, force: true });

        assert.deepEqual(events, [`cancel ${codebasePath}`, "clear"]);
    });
});

test("clear_index refuses while another session is syncing the codebase", async () => {
    await withTempHome(async (tempRoot) => {
        const { codebasePath, snapshotManager } = await indexedCodebase(tempRoot);
        let cleared = 0;
        const handlers = newHandlers({ clearIndex: async () => { cleared++; } }, snapshotManager, busyElsewhere);

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /another claude-context MCP process \(pid 4242/);
        assert.equal(cleared, 0);
        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
    });
});

test("clear_index stops this session's own run before dropping the index", async () => {
    await withTempHome(async (tempRoot) => {
        const { codebasePath, snapshotManager } = await indexedCodebase(tempRoot);
        const events: string[] = [];
        const handlers = newHandlers(
            { clearIndex: async () => { events.push("clear"); } },
            snapshotManager,
            {
                cancelCodebaseSync: async (p) => { events.push(`cancel ${p}`); return true; },
                getForeignCodebaseSync: () => null,
            }
        );

        const result = await handlers.handleClearIndex({ path: codebasePath });

        assert.match(result.content[0].text, /Successfully cleared/);
        assert.deepEqual(events, [`cancel ${codebasePath}`, "clear"]);
    });
});
