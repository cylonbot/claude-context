import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// --- Incremental-sync file logging --------------------------------------------
// Separate from console.log on purpose: the MCP server's stdout is the JSON-RPC
// stdio channel, so sync/embedding console logs are NOT visible anywhere. This
// file (default ~/.context/sync.log, override via CLAUDE_CONTEXT_SYNC_LOG) gives
// real visibility into what the background incremental indexer is doing, with
// size-based rotation so it never grows unbounded. Kept dependency-free so both
// the sync manager and the embedding factory can use it without layering issues.
const SYNC_LOG_MAX_BYTES = 2 * 1024 * 1024; // rotate at 2MB
const SYNC_LOG_KEEP = 3;                     // sync.log + .1 + .2 (~well over 24h of low-volume sync logs)

function getSyncLogPath(): string {
    return process.env.CLAUDE_CONTEXT_SYNC_LOG || path.join(os.homedir(), ".context", "sync.log");
}

function rotateSyncLogIfNeeded(logPath: string): void {
    try {
        if (fs.statSync(logPath).size < SYNC_LOG_MAX_BYTES) {
            return;
        }
        // sync.log.(N-1) -> .N, ..., sync.log -> .1 (oldest is discarded).
        for (let i = SYNC_LOG_KEEP - 1; i >= 1; i--) {
            const src = i === 1 ? logPath : `${logPath}.${i - 1}`;
            const dst = `${logPath}.${i}`;
            if (fs.existsSync(src)) {
                fs.renameSync(src, dst);
            }
        }
    } catch {
        // statSync throws when the file doesn't exist yet — nothing to rotate.
    }
}

export function syncLog(message: string): void {
    try {
        const logPath = getSyncLogPath();
        rotateSyncLogIfNeeded(logPath);
        fs.appendFileSync(logPath, `${new Date().toISOString()} [pid ${process.pid}] ${message}\n`);
    } catch {
        // Logging must never break syncing.
    }
}

/** Aggregate the structured sync log lines from the last 24h into a one-line summary. */
export function computeSyncStats24h(): string {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let syncCycles = 0, withChanges = 0, added = 0, removed = 0, modified = 0, errors = 0;
    const logPath = getSyncLogPath();
    for (const f of [`${logPath}.2`, `${logPath}.1`, logPath]) {
        let content: string;
        try { content = fs.readFileSync(f, "utf8"); } catch { continue; }
        for (const line of content.split("\n")) {
            const tsMatch = line.match(/^(\S+)/);
            if (!tsMatch) continue;
            const ts = Date.parse(tsMatch[1]);
            if (!Number.isFinite(ts) || ts < cutoff) continue;
            if (line.includes("sync START")) syncCycles++;
            const done = line.match(/DONE .* added=(\d+) removed=(\d+) modified=(\d+)/);
            if (done) {
                added += +done[1]; removed += +done[2]; modified += +done[3];
                if (+done[1] + +done[2] + +done[3] > 0) withChanges++;
            }
            if (line.includes("reindexByChange ERROR")) errors++;
        }
    }
    return `[STATS-24H] syncCycles=${syncCycles} withChanges=${withChanges} files:+${added}/-${removed}/~${modified} errors=${errors}`;
}
