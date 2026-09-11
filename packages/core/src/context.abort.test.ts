import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, IndexAbortError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { Splitter, CodeChunk } from './splitter';
import { FileSynchronizer } from './sync/synchronizer';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    constructor(private readonly onEmbedBatch?: () => void) {
        super();
    }

    async detectDimension(): Promise<number> {
        return 3;
    }

    async embed(_text: string): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 3 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        this.onEmbedBatch?.();
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 3 }));
    }

    getDimension(): number {
        return 3;
    }

    getProvider(): string {
        return 'test';
    }
}

class CountingSplitter implements Splitter {
    public calls = 0;

    constructor(private readonly onCall?: (callIndex: number) => void) { }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        this.calls += 1;
        this.onCall?.(this.calls);
        return [{
            content: code,
            metadata: {
                startLine: 1,
                endLine: code.split('\n').length,
                language,
                filePath,
            },
        }];
    }

    setChunkSize(): void { }
    setChunkOverlap(): void { }
}

const createVectorDatabase = (): jest.Mocked<VectorDatabase> => ({
    createCollection: jest.fn().mockResolvedValue(undefined),
    createHybridCollection: jest.fn().mockResolvedValue(undefined),
    dropCollection: jest.fn().mockResolvedValue(undefined),
    hasCollection: jest.fn().mockResolvedValue(false),
    listCollections: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockResolvedValue(undefined),
    insertHybrid: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    hybridSearch: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    getCollectionDescription: jest.fn().mockResolvedValue(''),
    checkCollectionLimit: jest.fn().mockResolvedValue(true),
    getCollectionRowCount: jest.fn().mockResolvedValue(0),
});

// Every test gets a throwaway HOME (file snapshots live under ~/.context) and non-hybrid mode.
let tempRoot: string;
let originalHome: string | undefined;
let originalHybridMode: string | undefined;

beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-context-abort-'));
    const homeDir = path.join(tempRoot, 'home');
    await fs.mkdir(homeDir, { recursive: true });
    originalHome = process.env.HOME;
    originalHybridMode = process.env.HYBRID_MODE;
    process.env.HOME = homeDir;
    process.env.HYBRID_MODE = 'false';
});

afterEach(async () => {
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalHybridMode === undefined) {
        delete process.env.HYBRID_MODE;
    } else {
        process.env.HYBRID_MODE = originalHybridMode;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('Context indexCodebase AbortSignal support', () => {
    it('completes normally when no signal is provided (regression guard)', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        for (let i = 0; i < 3; i++) {
            await fs.writeFile(path.join(project, `file${i}.ts`), `const v${i} = ${i};`);
        }

        const vectorDatabase = createVectorDatabase();
        const splitter = new CountingSplitter();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        const stats = await context.indexCodebase(project);

        expect(stats.indexedFiles).toBe(3);
        expect(stats.status).toBe('completed');
        expect(splitter.calls).toBe(3);
        const insertedDocuments = vectorDatabase.insert.mock.calls
            .flatMap(([, documents]) => documents);
        expect(insertedDocuments).toHaveLength(3);
    });

    it('completes normally when signal is provided but never fires', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        for (let i = 0; i < 3; i++) {
            await fs.writeFile(path.join(project, `file${i}.ts`), `const v${i} = ${i};`);
        }

        const vectorDatabase = createVectorDatabase();
        const splitter = new CountingSplitter();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        const controller = new AbortController();
        const stats = await context.indexCodebase(project, undefined, false, [], [], undefined, controller.signal);

        expect(stats.indexedFiles).toBe(3);
        expect(stats.status).toBe('completed');
    });

    it('throws IndexAbortError and stops processing when the signal fires mid-indexing', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        // Five files; controller fires after the splitter has been called twice.
        for (let i = 0; i < 5; i++) {
            await fs.writeFile(path.join(project, `file${i}.ts`), `const v${i} = ${i};`);
        }

        const vectorDatabase = createVectorDatabase();
        const controller = new AbortController();
        const splitter = new CountingSplitter((callIndex) => {
            if (callIndex === 2) {
                controller.abort();
            }
        });
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        await expect(
            context.indexCodebase(project, undefined, false, [], [], undefined, controller.signal)
        ).rejects.toBeInstanceOf(IndexAbortError);

        // Two files were processed before the signal fired; the remaining
        // three must NOT have been split.
        expect(splitter.calls).toBe(2);

        // No insert should fire after abort: chunks are buffered until the
        // batch threshold (100) so a small project never flushes mid-loop, and
        // the final-batch flush is skipped when the signal is aborted.
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });

    it('throws IndexAbortError when the signal is already aborted before indexing begins', async () => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'only.ts'), 'const x = 1;');

        const vectorDatabase = createVectorDatabase();
        const splitter = new CountingSplitter();
        const context = new Context({
            embedding: new TestEmbedding(),
            vectorDatabase,
            codeSplitter: splitter,
        });

        const controller = new AbortController();
        controller.abort();

        await expect(
            context.indexCodebase(project, undefined, false, [], [], undefined, controller.signal)
        ).rejects.toBeInstanceOf(IndexAbortError);

        expect(splitter.calls).toBe(0);
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });
});

describe('Context reindexByChange AbortSignal support', () => {
    /** An indexed project with two changes pending since its file snapshot: one edited file, one new. */
    const setUpChangedProject = async (embedding: Embedding) => {
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project);
        await fs.writeFile(path.join(project, 'kept.ts'), 'const kept = 1;');

        const vectorDatabase = createVectorDatabase();
        // Incremental sync requires an existing index; without it reindexByChange bails out.
        vectorDatabase.hasCollection.mockResolvedValue(true);
        const context = new Context({ embedding, vectorDatabase, codeSplitter: new CountingSplitter() });
        const synchronizer = new FileSynchronizer(
            project,
            await context.getEffectiveIgnorePatterns(project),
            context.getEffectiveSupportedExtensions()
        );
        await synchronizer.initialize();
        context.setSynchronizer(context.getCollectionName(project), synchronizer);

        await fs.writeFile(path.join(project, 'kept.ts'), 'const kept = 2;');
        await fs.writeFile(path.join(project, 'added.ts'), 'const added = 1;');
        return { project, vectorDatabase, context };
    };

    it('throws IndexAbortError without writing or committing when aborted up front', async () => {
        const { project, vectorDatabase, context } = await setUpChangedProject(new TestEmbedding());
        const controller = new AbortController();
        controller.abort();

        await expect(
            context.reindexByChange(project, undefined, [], [], undefined, controller.signal)
        ).rejects.toBeInstanceOf(IndexAbortError);

        expect(vectorDatabase.query).not.toHaveBeenCalled(); // no old chunks looked up for deletion
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        // Nothing was committed, so the next sync still sees both changes.
        await expect(context.reindexByChange(project)).resolves.toEqual({ added: 1, removed: 0, modified: 1 });
    });

    it('drops a batch whose embedding finished after the signal fired', async () => {
        const controller = new AbortController();
        // Cancelled while the embedding call is in flight, e.g. waiting on a paced free key.
        const { project, vectorDatabase, context } = await setUpChangedProject(new TestEmbedding(() => controller.abort()));

        await expect(
            context.reindexByChange(project, undefined, [], [], undefined, controller.signal)
        ).rejects.toBeInstanceOf(IndexAbortError);

        expect(vectorDatabase.insert).not.toHaveBeenCalled();
    });
});
