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
