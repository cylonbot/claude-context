import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { MerkleDAG } from './merkle';
import * as os from 'os';

export class FileSynchronizer {
    private fileHashes: Map<string, string>;
    private merkleDAG: MerkleDAG;
    private rootDir: string;
    private snapshotPath: string;
    private ignorePatterns: string[];
    private supportedExtensions: string[];
    // State observed by the most recent checkForChanges(), held until the caller
    // confirms a successful index via commitChanges(). See checkForChanges().
    private pendingFileHashes: Map<string, string> | null = null;
    private pendingMerkleDAG: MerkleDAG | null = null;
    // Identity (mtime + size) of the on-disk snapshot as of the last time THIS instance
    // read or wrote it. The snapshot file is shared by every process that syncs the same
    // codebase, so before diffing we check whether someone else has moved it on.
    // See reloadSnapshotIfChangedOnDisk().
    private loadedSnapshotStamp: { mtimeMs: number; size: number } | null = null;

    constructor(rootDir: string, ignorePatterns: string[] = [], supportedExtensions: string[] = []) {
        this.rootDir = rootDir;
        this.snapshotPath = this.getSnapshotPath(rootDir);
        this.fileHashes = new Map();
        this.merkleDAG = new MerkleDAG();
        this.ignorePatterns = ignorePatterns;
        this.supportedExtensions = supportedExtensions;
    }

    private getSnapshotPath(codebasePath: string): string {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');

        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');

        return path.join(merkleDir, `${hash}.json`);
    }

    private async hashFile(filePath: string): Promise<string> {
        // Double-check that this is actually a file, not a directory
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
            throw new Error(`Attempted to hash a directory: ${filePath}`);
        }
        const content = await fs.readFile(filePath, 'utf-8');
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async generateFileHashes(dir: string): Promise<Map<string, string>> {
        const fileHashes = new Map<string, string>();

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch (error: any) {
            console.warn(`[Synchronizer] Cannot read directory ${dir}: ${error.message}`);
            return fileHashes;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(this.rootDir, fullPath);

            // Check if this path should be ignored BEFORE any file system operations
            if (this.shouldIgnore(relativePath)) {
                continue; // Skip completely - no access at all
            }

            // Double-check with fs.stat to be absolutely sure about file type
            let stat;
            try {
                stat = await fs.stat(fullPath);
            } catch (error: any) {
                console.warn(`[Synchronizer] Cannot stat ${fullPath}: ${error.message}`);
                continue;
            }

            if (stat.isDirectory()) {
                // Verify it's really a directory and not ignored
                if (!this.shouldIgnore(relativePath)) {
                    const subHashes = await this.generateFileHashes(fullPath);
                    const entries = Array.from(subHashes.entries());
                    for (let i = 0; i < entries.length; i++) {
                        const [p, h] = entries[i];
                        fileHashes.set(p, h);
                    }
                }
            } else if (stat.isFile()) {
                // Verify it's really a file and not ignored
                if (!this.shouldIgnore(relativePath)) {
                    const ext = path.extname(entry.name);
                    if (this.supportedExtensions.length > 0 && !this.supportedExtensions.includes(ext)) {
                        continue;
                    }
                    try {
                        const hash = await this.hashFile(fullPath);
                        fileHashes.set(relativePath, hash);
                    } catch (error: any) {
                        console.warn(`[Synchronizer] Cannot hash file ${fullPath}: ${error.message}`);
                        continue;
                    }
                }
            }
            // Skip other types (symlinks, etc.)
        }
        return fileHashes;
    }

    private shouldIgnore(relativePath: string): boolean {
        // Always ignore hidden files and directories (starting with .)
        const pathParts = relativePath.split(path.sep);
        if (pathParts.some(part => part.startsWith('.'))) {
            return true;
        }

        if (this.ignorePatterns.length === 0) {
            return false;
        }

        // Normalize path separators and remove leading/trailing slashes
        const normalizedPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');

        if (!normalizedPath) {
            return false; // Don't ignore root
        }

        // Check direct pattern matches first
        for (const pattern of this.ignorePatterns) {
            if (this.matchPattern(normalizedPath, pattern)) {
                return true;
            }
        }

        // Check if any parent directory is ignored
        const normalizedPathParts = normalizedPath.split('/');
        for (let i = 0; i < normalizedPathParts.length; i++) {
            const partialPath = normalizedPathParts.slice(0, i + 1).join('/');
            for (const pattern of this.ignorePatterns) {
                if (this.matchPattern(partialPath, pattern)) {
                    return true;
                }
            }
        }

        return false;
    }

    private matchPattern(filePath: string, pattern: string): boolean {
        // Clean both path and pattern
        const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
        const normalizedPattern = pattern.replace(/\\/g, '/');
        const cleanPattern = normalizedPattern.replace(/^\/+|\/+$/g, '');
        const isRootAnchored = normalizedPattern.startsWith('/');
        const isDirectoryPattern = normalizedPattern.endsWith('/');

        if (!cleanPath || !cleanPattern) {
            return false;
        }

        // Handle directory patterns (ending with /)
        if (isDirectoryPattern) {
            if (isRootAnchored) {
                return this.simpleGlobMatch(cleanPath, cleanPattern) ||
                    cleanPath.startsWith(`${cleanPattern}/`);
            }

            return this.matchesDirectoryPattern(cleanPath, cleanPattern);
        }

        if (isRootAnchored) {
            return this.simpleGlobMatch(cleanPath, cleanPattern);
        }

        // Handle path patterns (containing /)
        if (cleanPattern.includes('/')) {
            return this.simpleGlobMatch(cleanPath, cleanPattern);
        }

        // Handle filename patterns (no /) - match against basename
        const fileName = path.basename(cleanPath);
        return this.simpleGlobMatch(fileName, cleanPattern);
    }

    private matchesDirectoryPattern(filePath: string, dirPattern: string): boolean {
        const pathParts = filePath.split('/');
        const dirPartCount = dirPattern.split('/').length;

        for (let i = 0; i <= pathParts.length - dirPartCount; i++) {
            const candidate = pathParts.slice(i, i + dirPartCount).join('/');
            if (this.simpleGlobMatch(candidate, dirPattern)) {
                return true;
            }
        }

        return false;
    }

    private simpleGlobMatch(text: string, pattern: string): boolean {
        if (!text || !pattern) return false;

        // Convert glob pattern to regex
        const regexPattern = pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
            .replace(/\*/g, '.*'); // Convert * to .*

        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(text);
    }

    private buildMerkleDAG(fileHashes: Map<string, string>): MerkleDAG {
        const dag = new MerkleDAG();
        const keys = Array.from(fileHashes.keys());
        const sortedPaths = keys.slice().sort(); // Create a sorted copy

        // Create a root node for the entire directory
        let valuesString = "";
        keys.forEach(key => {
            valuesString += fileHashes.get(key);
        });
        const rootNodeData = "root:" + valuesString;
        const rootNodeId = dag.addNode(rootNodeData);

        // Add each file as a child of the root
        for (const path of sortedPaths) {
            const fileData = path + ":" + fileHashes.get(path);
            dag.addNode(fileData, rootNodeId);
        }

        return dag;
    }

    public async initialize() {
        console.log(`Initializing file synchronizer for ${this.rootDir}`);
        await this.loadSnapshot();
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        console.log(`[Synchronizer] File synchronizer initialized. Loaded ${this.fileHashes.size} file hashes.`);
    }

    public async checkForChanges(): Promise<{ added: string[], removed: string[], modified: string[] }> {
        console.log('[Synchronizer] Checking for file changes...');

        await this.reloadSnapshotIfChangedOnDisk();

        const newFileHashes = await this.generateFileHashes(this.rootDir);
        const newMerkleDAG = this.buildMerkleDAG(newFileHashes);

        // Compare the DAGs
        const changes = MerkleDAG.compare(this.merkleDAG, newMerkleDAG);

        // If there are any changes in the DAG, do a file-level comparison
        if (changes.added.length > 0 || changes.removed.length > 0) {
            console.log('[Synchronizer] Merkle DAG has changed. Comparing file states...');
            const fileChanges = this.compareStates(this.fileHashes, newFileHashes);

            // Stash the observed state but DON'T persist it yet. The caller must call
            // commitChanges() only after it has successfully indexed these changes, so
            // that an interrupted/failed embedding is retried on the next sync instead
            // of being silently marked as done (which leaves the vector DB stale forever).
            this.pendingFileHashes = newFileHashes;
            this.pendingMerkleDAG = newMerkleDAG;

            console.log(`[Synchronizer] Found changes: ${fileChanges.added.length} added, ${fileChanges.removed.length} removed, ${fileChanges.modified.length} modified.`);
            return fileChanges;
        }

        console.log('[Synchronizer] No changes detected based on Merkle DAG comparison.');
        return { added: [], removed: [], modified: [] };
    }

    /**
     * Persist the file state observed by the most recent {@link checkForChanges}.
     * MUST be called only after the caller has successfully indexed those changes.
     * If indexing fails (or the process dies) before this is called, the on-disk
     * snapshot stays at the previous state and the changes are re-detected next time.
     * No-op when there is nothing pending.
     */
    public async commitChanges(): Promise<void> {
        if (!this.pendingFileHashes || !this.pendingMerkleDAG) {
            return;
        }
        this.fileHashes = this.pendingFileHashes;
        this.merkleDAG = this.pendingMerkleDAG;
        this.pendingFileHashes = null;
        this.pendingMerkleDAG = null;
        await this.saveSnapshot();
    }

    private compareStates(oldHashes: Map<string, string>, newHashes: Map<string, string>): { added: string[], removed: string[], modified: string[] } {
        const added: string[] = [];
        const removed: string[] = [];
        const modified: string[] = [];

        const newEntries = Array.from(newHashes.entries());
        for (let i = 0; i < newEntries.length; i++) {
            const [file, hash] = newEntries[i];
            if (!oldHashes.has(file)) {
                added.push(file);
            } else if (oldHashes.get(file) !== hash) {
                modified.push(file);
            }
        }

        const oldKeys = Array.from(oldHashes.keys());
        for (let i = 0; i < oldKeys.length; i++) {
            const file = oldKeys[i];
            if (!newHashes.has(file)) {
                removed.push(file);
            }
        }

        return { added, removed, modified };
    }

    public getFileHash(filePath: string): string | undefined {
        return this.fileHashes.get(filePath);
    }

    private async saveSnapshot(): Promise<void> {
        const merkleDir = path.dirname(this.snapshotPath);
        await fs.mkdir(merkleDir, { recursive: true });

        // Convert Map to array without using iterator
        const fileHashesArray: [string, string][] = [];
        const keys = Array.from(this.fileHashes.keys());
        keys.forEach(key => {
            fileHashesArray.push([key, this.fileHashes.get(key)!]);
        });

        const data = JSON.stringify({
            fileHashes: fileHashesArray,
            merkleDAG: this.merkleDAG.serialize()
        });
        await fs.writeFile(this.snapshotPath, data, 'utf-8');
        this.loadedSnapshotStamp = await this.statSnapshot();
        console.log(`Saved snapshot to ${this.snapshotPath}`);
    }

    private async statSnapshot(): Promise<{ mtimeMs: number; size: number } | null> {
        try {
            const stat = await fs.stat(this.snapshotPath);
            return { mtimeMs: stat.mtimeMs, size: stat.size };
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    private applySerializedSnapshot(data: string): void {
        const obj = JSON.parse(data);

        // Reconstruct Map without using constructor with iterator
        this.fileHashes = new Map();
        for (const [key, value] of obj.fileHashes) {
            this.fileHashes.set(key, value);
        }

        if (obj.merkleDAG) {
            this.merkleDAG = MerkleDAG.deserialize(obj.merkleDAG);
        }
    }

    /**
     * The snapshot file is shared by every process syncing this codebase (one MCP server
     * per Claude session, serialized by the sync lock). Only the process that actually
     * indexed a change writes the new snapshot; without this, every OTHER process keeps
     * diffing against its own stale in-memory copy and re-indexes the same change on its
     * next turn — N processes, N embeddings of every edit. So before diffing, pick up
     * whatever the last committer wrote. A missing file keeps the in-memory state: that
     * is still the best baseline we have, and regenerating it here would silently drop
     * real changes.
     */
    private async reloadSnapshotIfChangedOnDisk(): Promise<void> {
        // stat BEFORE read: if the file changes in between we record an older stamp
        // and simply reload again next time, instead of missing an update.
        const stamp = await this.statSnapshot();
        if (!stamp) {
            return;
        }
        if (this.loadedSnapshotStamp
            && this.loadedSnapshotStamp.mtimeMs === stamp.mtimeMs
            && this.loadedSnapshotStamp.size === stamp.size) {
            return;
        }

        const data = await fs.readFile(this.snapshotPath, 'utf-8');
        this.applySerializedSnapshot(data);
        this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
        this.loadedSnapshotStamp = stamp;
        console.log(`[Synchronizer] Snapshot on disk changed since this process last read it (another process synced?). Reloaded ${this.fileHashes.size} file hashes.`);
    }

    private async loadSnapshot(): Promise<void> {
        try {
            const stamp = await this.statSnapshot();
            const data = await fs.readFile(this.snapshotPath, 'utf-8');
            this.applySerializedSnapshot(data);
            this.loadedSnapshotStamp = stamp;
            console.log(`Loaded snapshot from ${this.snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found at ${this.snapshotPath}. Generating new one.`);
                this.fileHashes = await this.generateFileHashes(this.rootDir);
                this.merkleDAG = this.buildMerkleDAG(this.fileHashes);
                await this.saveSnapshot();
            } else {
                throw error;
            }
        }
    }

    /**
     * Delete snapshot file for a given codebase path
     */
    static async deleteSnapshot(codebasePath: string): Promise<void> {
        const homeDir = os.homedir();
        const merkleDir = path.join(homeDir, '.context', 'merkle');
        const normalizedPath = path.resolve(codebasePath);
        const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
        const snapshotPath = path.join(merkleDir, `${hash}.json`);

        try {
            await fs.unlink(snapshotPath);
            console.log(`Deleted snapshot file: ${snapshotPath}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log(`Snapshot file not found (already deleted): ${snapshotPath}`);
            } else {
                console.error(`[Synchronizer] Failed to delete snapshot file ${snapshotPath}:`, error.message);
                throw error; // Re-throw non-ENOENT errors
            }
        }
    }
}
