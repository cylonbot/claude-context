import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SyncManager } from "./sync.js";

const STALE_MS = 60_000;
const FOREIGN_TOKEN = "other-process-token";

// The global sync lock lives under ~/.context and every lock transition goes to the sync log,
// so each test gets its own HOME and log file.
function withTempHome(run: (paths: { lockPath: string; logPath: string }) => void): void {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claude-context-mcp-sync-lock-"));
    const overrides: Record<string, string> = {
        HOME: tempRoot,
        USERPROFILE: tempRoot,
        CLAUDE_CONTEXT_SYNC_LOG: path.join(tempRoot, "sync.log"),
        CLAUDE_CONTEXT_SYNC_LOCK_STALE_MS: String(STALE_MS),
    };
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);

    try {
        run({
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

function newManager(): SyncManager {
    return new SyncManager({} as any, {} as any);
}

function acquire(manager: SyncManager): boolean {
    return (manager as any).acquireGlobalSyncLock();
}

function ownerToken(lockPath: string): string | undefined {
    try {
        return JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf8")).token;
    } catch {
        return undefined;
    }
}

/** Put a lock owned by another process in place, taking over any existing one. */
function writeForeignLock(lockPath: string, owner: { pid: number; codebase?: string }): void {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({ token: FOREIGN_TOKEN, ...owner }));
}

test("shutdown of a process that only saw the lock busy does not free it for others", () => {
    withTempHome(({ lockPath }) => {
        const holder = newManager();
        const bystander = newManager();
        assert.equal(acquire(holder), true);
        assert.equal(acquire(bystander), false);

        bystander.releaseLockForShutdown();

        assert.equal(fs.existsSync(lockPath), true, "the holder's lock must survive a bystander's shutdown");
        assert.equal(acquire(newManager()), false, "a newcomer must still see the lock as busy");
        holder.releaseLockForShutdown();
    });
});

test("releases its own lock", () => {
    withTempHome(({ lockPath }) => {
        const manager = newManager();
        assert.equal(acquire(manager), true);

        manager.releaseLockForShutdown();

        assert.equal(fs.existsSync(lockPath), false);
    });
});

test("does not remove a lock another process has taken over since", () => {
    withTempHome(({ lockPath }) => {
        const manager = newManager();
        assert.equal(acquire(manager), true);

        writeForeignLock(lockPath, { pid: 999999 });
        manager.releaseLockForShutdown();

        assert.equal(ownerToken(lockPath), FOREIGN_TOKEN);
    });
});

test("heartbeat reports a lost lock once instead of going quiet", (t) => {
    withTempHome(({ lockPath, logPath }) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const manager = newManager();
        assert.equal(acquire(manager), true);

        fs.rmSync(lockPath, { recursive: true, force: true });
        t.mock.timers.tick(STALE_MS); // several heartbeat intervals

        const lostLines = fs.readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes("lock LOST"));
        assert.equal(lostLines.length, 1);
        manager.releaseLockForShutdown();
    });
});

test("reports another live process syncing the same codebase", () => {
    withTempHome(({ lockPath }) => {
        writeForeignLock(lockPath, { pid: process.ppid, codebase: "/repo" });
        const manager = newManager();

        assert.equal(manager.getForeignCodebaseSync("/repo"), process.ppid);
        assert.equal(manager.getForeignCodebaseSync("/other-repo"), null);
    });
});

test("ignores a codebase announcement left behind by a dead process", () => {
    withTempHome(({ lockPath }) => {
        const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
        writeForeignLock(lockPath, { pid: deadPid, codebase: "/repo" });

        assert.equal(newManager().getForeignCodebaseSync("/repo"), null);
    });
});

test("does not report its own sync as foreign", () => {
    withTempHome(() => {
        const manager = newManager();
        assert.equal(acquire(manager), true);
        (manager as any).announceSyncCodebase("/repo");

        assert.equal(manager.getForeignCodebaseSync("/repo"), null);
        manager.releaseLockForShutdown();
    });
});
