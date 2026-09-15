import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSynchronizer } from './synchronizer';

describe('FileSynchronizer commit semantics', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha');
    });

    afterEach(async () => {
        await FileSynchronizer.deleteSnapshot(tmpDir).catch(() => { });
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('does NOT persist detected changes until commitChanges() is called', async () => {
        const sync = new FileSynchronizer(tmpDir, [], []);
        await sync.initialize(); // snapshot now contains only a.txt

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');

        const changes = await sync.checkForChanges();
        expect(changes.added).toContain('b.txt');

        // Simulate a crash / failed embedding BEFORE commit: a fresh synchronizer
        // (new process) loads the on-disk snapshot and must STILL see b.txt as new,
        // because nothing was persisted yet — i.e. the change is retried, not lost.
        const reloaded = new FileSynchronizer(tmpDir, [], []);
        await reloaded.initialize();
        const afterReload = await reloaded.checkForChanges();
        expect(afterReload.added).toContain('b.txt');
    });

    it('clears the change once commitChanges() persists it', async () => {
        const sync = new FileSynchronizer(tmpDir, [], []);
        await sync.initialize();

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
        await sync.checkForChanges();
        await sync.commitChanges(); // persist only after a "successful index"

        const reloaded = new FileSynchronizer(tmpDir, [], []);
        await reloaded.initialize();
        const changes = await reloaded.checkForChanges();
        expect(changes.added).toEqual([]);
        expect(changes.modified).toEqual([]);
        expect(changes.removed).toEqual([]);
    });

    it('commitChanges() is a no-op when nothing is pending', async () => {
        const sync = new FileSynchronizer(tmpDir, [], []);
        await sync.initialize();
        await expect(sync.commitChanges()).resolves.toBeUndefined();
    });
});

describe('FileSynchronizer shared snapshot across processes', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha');
    });

    afterEach(async () => {
        await FileSynchronizer.deleteSnapshot(tmpDir).catch(() => { });
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // Two synchronizers on the same codebase = two MCP processes (one per Claude
    // session) sharing one snapshot file under ~/.context/merkle.
    async function twoProcesses(): Promise<[FileSynchronizer, FileSynchronizer]> {
        const a = new FileSynchronizer(tmpDir, [], []);
        await a.initialize();
        const b = new FileSynchronizer(tmpDir, [], []);
        await b.initialize();
        return [a, b];
    }

    it('does not re-detect a change another process already indexed and committed', async () => {
        const [a, b] = await twoProcesses();

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
        expect((await a.checkForChanges()).added).toEqual(['b.txt']);
        await a.commitChanges(); // process A indexed b.txt and wrote the shared snapshot

        // Process B still holds the pre-b.txt state in memory. It must pick up A's
        // snapshot instead of re-indexing b.txt a second time.
        const seenByB = await b.checkForChanges();
        expect(seenByB).toEqual({ added: [], removed: [], modified: [] });
    });

    it('still sees changes made after the other process committed', async () => {
        const [a, b] = await twoProcesses();

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
        await a.checkForChanges();
        await a.commitChanges();

        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'alpha-2');
        fs.writeFileSync(path.join(tmpDir, 'c.txt'), 'gamma');

        const seenByB = await b.checkForChanges();
        expect(seenByB.added).toEqual(['c.txt']);
        expect(seenByB.modified).toEqual(['a.txt']);
        expect(seenByB.removed).toEqual([]);
    });

    it('does not pick up the other process\'s changes while they are still uncommitted', async () => {
        const [a, b] = await twoProcesses();

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
        await a.checkForChanges(); // A is "still embedding": nothing persisted yet

        // If A dies now, B is the one that must retry b.txt.
        expect((await b.checkForChanges()).added).toEqual(['b.txt']);
    });

    it('keeps its own baseline when the snapshot file disappears', async () => {
        const sync = new FileSynchronizer(tmpDir, [], []);
        await sync.initialize();

        fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'beta');
        await FileSynchronizer.deleteSnapshot(tmpDir);

        // A missing file must not be "regenerated from the tree" here: that would make
        // b.txt part of the baseline and silently drop it from the diff.
        expect((await sync.checkForChanges()).added).toEqual(['b.txt']);
    });
});
