import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-cloud-sync-"));
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

/** Context stub exposing only what syncIndexedCodebasesFromCloud touches. */
function createContext(collectionName: string, codebasePath: string, rowCount: number) {
    return {
        getCollectionName: () => collectionName,
        getVectorDatabase: () => ({
            listCollections: async () => [collectionName],
            getCollectionDescription: async () => `codebasePath:${codebasePath}`,
            getCollectionRowCount: async () => rowCount,
        }),
    } as any;
}

test("cloud sync does not overwrite a codebase that is still indexing", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        // Mid-index: the collection already exists in the cloud and is filling up, while the
        // snapshot tracks progress — exactly the state a status check used to corrupt.
        snapshotManager.setCodebaseIndexing(codebasePath, 98);

        const handlers = new ToolHandlers(
            createContext("hybrid_code_chunks_abcdef12_935e49", codebasePath, 1000),
            snapshotManager
        );

        await (handlers as any).syncIndexedCodebasesFromCloud();

        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexing");
        const info = snapshotManager.getCodebaseInfo(codebasePath) as any;
        assert.equal(info.status, "indexing");
        assert.equal(info.indexingPercentage, 98);
    });
});

test("cloud sync still recovers a codebase that is not being indexed", async () => {
    await withTempHome(async (tempRoot) => {
        const codebasePath = path.join(tempRoot, "repo");
        await mkdir(codebasePath, { recursive: true });

        const snapshotManager = new SnapshotManager();
        const handlers = new ToolHandlers(
            createContext("hybrid_code_chunks_abcdef12_935e49", codebasePath, 1000),
            snapshotManager
        );

        await (handlers as any).syncIndexedCodebasesFromCloud();

        assert.equal(snapshotManager.getCodebaseStatus(codebasePath), "indexed");
        const info = snapshotManager.getCodebaseInfo(codebasePath) as any;
        assert.equal(info.totalChunks, 1000);
    });
});
