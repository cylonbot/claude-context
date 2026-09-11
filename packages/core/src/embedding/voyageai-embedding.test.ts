import { VoyageAIClient } from 'voyageai';
import { VoyageAIEmbedding } from './voyageai-embedding';

const mockEmbed = jest.fn();

jest.mock('voyageai', () => ({
    VoyageAIClient: jest.fn().mockImplementation(() => ({
        embed: mockEmbed,
    })),
}));

describe('VoyageAIEmbedding', () => {
    beforeEach(() => {
        mockEmbed.mockReset();
        (VoyageAIClient as unknown as jest.Mock).mockClear();
    });

    it('keeps voyage-4-nano metadata aligned with its default dimension', async () => {
        const supportedModels = VoyageAIEmbedding.getSupportedModels();

        expect(supportedModels['voyage-4-nano']).toMatchObject({
            dimension: '1024 (default), 256, 512, 2048',
            contextLength: 32000,
        });

        const embedding = new VoyageAIEmbedding({
            apiKey: 'test-api-key',
            model: 'voyage-4-nano',
        });

        expect(embedding.getDimension()).toBe(1024);
        await expect(embedding.detectDimension()).resolves.toBe(1024);
    });

    it('exposes voyage-code-3.5 as a supported code model', () => {
        const embedding = new VoyageAIEmbedding({ apiKey: 'test-api-key', model: 'voyage-code-3.5' });

        expect(embedding.getModel()).toBe('voyage-code-3.5');
        expect(embedding.getDimension()).toBe(1024);
        expect(VoyageAIEmbedding.getSupportedModels()['voyage-code-3.5']).toMatchObject({
            dimension: '1024 (default), 256, 512, 2048',
            contextLength: 32000,
        });
    });

    it('embeds searches as queries and indexed chunks as documents', async () => {
        mockEmbed.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
        const embedding = new VoyageAIEmbedding({ apiKey: 'test-api-key', model: 'voyage-code-3.5' });

        await embedding.embed('where do we split a batch on 429?', { mode: 'search' });
        expect(mockEmbed).toHaveBeenLastCalledWith(expect.objectContaining({ inputType: 'query' }));

        await embedding.embed('const value = 1;', { mode: 'full' });
        expect(mockEmbed).toHaveBeenLastCalledWith(expect.objectContaining({ inputType: 'document' }));

        await embedding.embedBatch(['const value = 1;']);
        expect(mockEmbed).toHaveBeenLastCalledWith(expect.objectContaining({ inputType: 'document' }));
    });

    it('stops waiting for free-tier capacity once the signal fires', async () => {
        mockEmbed.mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
        const embedding = new VoyageAIEmbedding({
            apiKey: 'paid-key',
            model: 'voyage-code-3.5',
            freeApiKeys: ['free-key'],
            freeRpm: 1,
        });
        // The one free request this minute is spent, so the next batch would wait ~60s for the window.
        await embedding.embedBatch(['const a = 1;'], { mode: 'incremental' });
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);

        await expect(
            embedding.embedBatch(['const b = 2;'], { mode: 'incremental', signal: controller.signal })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mockEmbed).toHaveBeenCalledTimes(1);
    });

    it('parses the leading default dimension from variable-dimension model metadata', () => {
        const defaultDimensionModels = [
            'voyage-4-large',
            'voyage-4',
            'voyage-4-lite',
            'voyage-4-nano',
            'voyage-code-3.5',
            'voyage-code-3',
        ];

        for (const model of defaultDimensionModels) {
            const embedding = new VoyageAIEmbedding({
                apiKey: 'test-api-key',
                model,
            });

            expect(embedding.getDimension()).toBe(1024);
        }
    });
});
