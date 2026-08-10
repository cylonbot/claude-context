import { OpenAIEmbedding } from './openai-embedding';

describe('OpenAIEmbedding provider identity', () => {
    it('reports OpenAI by default', () => {
        const embedding = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'text-embedding-3-small',
        });

        expect(embedding.getProvider()).toBe('OpenAI');
        expect(embedding.getModel()).toBe('text-embedding-3-small');
    });

    it('reports the configured provider for OpenAI-compatible endpoints', () => {
        // Same class, same model name, different backend — the index must not treat these
        // as one embedding, so the provider name has to travel with the instance.
        const openai = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'text-embedding-3-small',
        });
        const openrouter = new OpenAIEmbedding({
            apiKey: 'test-api-key',
            model: 'text-embedding-3-small',
            baseURL: 'https://openrouter.ai/api/v1',
            provider: 'OpenRouter',
        });

        expect(openrouter.getProvider()).toBe('OpenRouter');
        expect(openrouter.getProvider()).not.toBe(openai.getProvider());
    });
});
