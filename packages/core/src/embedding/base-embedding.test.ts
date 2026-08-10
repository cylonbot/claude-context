import { Embedding, EmbeddingVector } from './base-embedding';

class TestEmbedding extends Embedding {
    protected maxTokens = 10; // 40 chars — small enough to exercise truncation

    async detectDimension(): Promise<number> {
        return 1;
    }

    async embed(): Promise<EmbeddingVector> {
        return { vector: [1], dimension: 1 };
    }

    async embedBatch(texts: string[]): Promise<EmbeddingVector[]> {
        return texts.map(() => ({ vector: [1], dimension: 1 }));
    }

    getDimension(): number {
        return 1;
    }

    getProvider(): string {
        return 'test';
    }

    public preprocess(text: string): string {
        return this.preprocessText(text);
    }
}

/** True when the string survives a UTF-8 round trip — i.e. it can be put on the wire at all. */
const isEncodable = (text: string) => Buffer.from(text, 'utf8').toString('utf8') === text;

describe('Embedding.preprocessText', () => {
    const embedding = new TestEmbedding();

    it('leaves ordinary text and whole emoji untouched', () => {
        expect(embedding.preprocess('const blocked = "🚫";')).toBe('const blocked = "🚫";');
    });

    it('repairs a chunk that starts or ends mid-emoji', () => {
        // What an AST chunk boundary through 🚫 (U+1F6AB) actually produces.
        const [high, low] = ['\uD83D', '\uDEAB'];
        const tail = `Game.map.visual.text('${high}`;
        const head = `${low}', position);`;

        expect(isEncodable(tail)).toBe(false);
        expect(isEncodable(head)).toBe(false);
        expect(isEncodable(embedding.preprocess(tail))).toBe(true);
        expect(isEncodable(embedding.preprocess(head))).toBe(true);
        expect(embedding.preprocess(tail)).toBe(`Game.map.visual.text('�`);
    });

    it('repairs a pair broken by its own truncation', () => {
        // 39 chars then the emoji: the 40-char cut lands between the surrogates.
        const text = 'x'.repeat(39) + '🚫' + 'tail';

        const processed = embedding.preprocess(text);

        expect(processed).toHaveLength(40);
        expect(isEncodable(processed)).toBe(true);
    });

    it('still replaces empty input with a space', () => {
        expect(embedding.preprocess('')).toBe(' ');
    });
});
