import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Context, IndexMissingError } from './context';
import { Embedding, EmbeddingVector } from './embedding';
import { VectorDatabase } from './vectordb';

class TestEmbedding extends Embedding {
    protected maxTokens = 8192;

    constructor(private readonly model: string, private readonly provider: string = 'test') {
        super();
    }

    async detectDimension(): Promise<number> {
        return 1024;
    }

    async embed(): Promise<EmbeddingVector> {
        return { vector: [1, 0, 0], dimension: 1024 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1, 0, 0], dimension: 1024 }));
    }

    getDimension(): number {
        return 1024;
    }

    getProvider(): string {
        return this.provider;
    }

    getModel(): string {
        return this.model;
    }
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

const createContext = (model: string, extra: { provider?: string; collectionNameOverride?: string } = {}) =>
    new Context({
        embedding: new TestEmbedding(model, extra.provider),
        vectorDatabase: createVectorDatabase(),
        collectionNameOverride: extra.collectionNameOverride,
    });

describe('Context collection naming', () => {
    const codebasePath = '/tmp/some/codebase';
    let tempRoot: string;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(async () => {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-context-collection-'));
        const homeDir = path.join(tempRoot, 'home');
        await fs.mkdir(homeDir, { recursive: true });
        originalEnv = {
            HOME: process.env.HOME,
            HYBRID_MODE: process.env.HYBRID_MODE,
            CODE_CHUNKS_COLLECTION_NAME_OVERRIDE: process.env.CODE_CHUNKS_COLLECTION_NAME_OVERRIDE,
        };
        process.env.HOME = homeDir;
        process.env.HYBRID_MODE = 'false';
        delete process.env.CODE_CHUNKS_COLLECTION_NAME_OVERRIDE;
    });

    afterEach(async () => {
        for (const [key, value] of Object.entries(originalEnv)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    it('is stable for the same embedding model and codebase', () => {
        const first = createContext('voyage-code-3.5').getCollectionName(codebasePath);
        const second = createContext('voyage-code-3.5').getCollectionName(codebasePath);

        expect(first).toBe(second);
    });

    it('separates collections per embedding model, even at identical dimensions', () => {
        // Both models are 1024-dimensional, so nothing downstream would notice the switch:
        // the vectors must not end up in the same collection.
        const oldModel = createContext('voyage-code-3').getCollectionName(codebasePath);
        const newModel = createContext('voyage-code-3.5').getCollectionName(codebasePath);

        expect(oldModel).not.toBe(newModel);
    });

    it('separates collections per provider for identically named models', () => {
        const voyage = createContext('shared-name', { provider: 'VoyageAI' }).getCollectionName(codebasePath);
        const openai = createContext('shared-name', { provider: 'OpenAI' }).getCollectionName(codebasePath);

        expect(voyage).not.toBe(openai);
    });

    it('still separates codebases indexed with the same model', () => {
        const context = createContext('voyage-code-3.5');

        expect(context.getCollectionName('/tmp/project-a')).not.toBe(context.getCollectionName('/tmp/project-b'));
    });

    it('applies the embedding signature to name overrides as well', () => {
        const custom = createContext('voyage-code-3.5', { collectionNameOverride: 'my_index' });
        const customOtherModel = createContext('voyage-code-3', { collectionNameOverride: 'my_index' });

        expect(custom.getCollectionName(codebasePath)).toMatch(/^code_chunks_my_index_[0-9a-f]{8}_[0-9a-f]{6}$/);
        expect(custom.getCollectionName(codebasePath)).not.toBe(customOtherModel.getCollectionName(codebasePath));
    });

    it('keeps overridden names within the vector DB name length limit', () => {
        const context = createContext('voyage-code-3.5', { collectionNameOverride: 'x'.repeat(400) });

        expect(context.getCollectionName(codebasePath).length).toBeLessThanOrEqual(255);
    });

    it('refuses to sync when the codebase has a snapshot but no collection', async () => {
        // What an embedding-model switch looks like from the sync path: the file snapshot is
        // still there and reports no changes, but the collection it belongs to is gone.
        const project = path.join(tempRoot, 'project');
        await fs.mkdir(project, { recursive: true });
        await fs.writeFile(path.join(project, 'index.ts'), 'const value = 1;');

        const vectorDatabase = createVectorDatabase();
        vectorDatabase.hasCollection.mockResolvedValue(false);
        const context = new Context({
            embedding: new TestEmbedding('voyage-code-3.5', 'VoyageAI'),
            vectorDatabase,
        });

        await expect(context.reindexByChange(project)).rejects.toThrow(IndexMissingError);
        await expect(context.reindexByChange(project)).rejects.toThrow(/VoyageAI\/voyage-code-3\.5/);
        // It must fail instead of quietly re-embedding: re-indexing is the user's decision.
        expect(vectorDatabase.insert).not.toHaveBeenCalled();
        expect(vectorDatabase.insertHybrid).not.toHaveBeenCalled();
        expect(vectorDatabase.createCollection).not.toHaveBeenCalled();
        expect(vectorDatabase.createHybridCollection).not.toHaveBeenCalled();
    });

    it('clears every collection this codebase has, whatever config built it', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding('voyage-code-3.5'),
            vectorDatabase,
        });
        const currentName = context.getCollectionName(codebasePath);
        const pathHash = currentName.match(/_([0-9a-f]{8})_[0-9a-f]{6}$/)![1];
        // Same codebase, indexed earlier under: the pre-signature naming, another embedding
        // model, a collection-name override, and hybrid mode.
        const stale = [
            `code_chunks_${pathHash}`,
            `code_chunks_${pathHash}_aaaaaa`,
            `code_chunks_old_override_${pathHash}_bbbbbb`,
            `hybrid_code_chunks_${pathHash}_cccccc`,
        ];
        const otherCodebase = 'code_chunks_deadbeef_dddddd';
        vectorDatabase.listCollections.mockResolvedValue([...stale, otherCodebase]);
        vectorDatabase.hasCollection.mockResolvedValue(true);

        await context.clearIndex(codebasePath);

        for (const name of [currentName, ...stale]) {
            expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(name);
        }
        expect(vectorDatabase.dropCollection).not.toHaveBeenCalledWith(otherCodebase);
    });

    it('still drops the current collection when the vector DB cannot list collections', async () => {
        const vectorDatabase = createVectorDatabase();
        const context = new Context({
            embedding: new TestEmbedding('voyage-code-3.5'),
            vectorDatabase,
        });
        const currentName = context.getCollectionName(codebasePath);
        vectorDatabase.listCollections.mockRejectedValue(new Error('list not supported'));
        vectorDatabase.hasCollection.mockResolvedValue(true);

        await context.clearIndex(codebasePath);

        expect(vectorDatabase.dropCollection).toHaveBeenCalledWith(currentName);
    });
});
