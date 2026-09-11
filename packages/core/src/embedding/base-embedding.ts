// Interface definitions
export interface EmbeddingVector {
    vector: number[];
    dimension: number;
}

/**
 * Per-call options for embedding requests.
 *
 * `mode` lets providers pick a different strategy/credential depending on the
 * operation that triggered the call:
 *   - 'search'      — interactive query embedding (low latency preferred)
 *   - 'full'        — initial / forced full indexing
 *   - 'incremental' — background sync of changed files (rate-limit friendly)
 *
 * Providers that don't care about the mode simply ignore this argument.
 */
export interface EmbedOptions {
    mode?: 'search' | 'incremental' | 'full';
    /**
     * Cancels the call. Providers that pace requests (VoyageAI's free-key pool) stop waiting
     * for rate-limit capacity and reject as soon as it fires; others may ignore it.
     */
    signal?: AbortSignal;
}

/**
 * Abstract base class for embedding implementations
 */
export abstract class Embedding {
    protected abstract maxTokens: number;

    /**
     * Preprocess text to ensure it's valid for embedding
     * @param text Input text
     * @returns Processed text
     */
    protected preprocessText(text: string): string {
        // Replace empty string with single space
        if (text === '') {
            return ' ';
        }

        // Simple character-based truncation (approximation)
        // Each token is roughly 4 characters on average for English text
        const maxChars = this.maxTokens * 4;
        const truncated = text.length > maxChars ? text.substring(0, maxChars) : text;

        return Embedding.replaceLoneSurrogates(truncated);
    }

    /**
     * Replace unpaired surrogates with U+FFFD.
     *
     * A chunk can end mid-astral-character — one emoji in a comment landing on a split point
     * is enough, and the truncation above cuts by UTF-16 unit too. The resulting string has no
     * valid UTF-8 encoding, so the request body is malformed and the provider rejects the whole
     * batch (VoyageAI answers 400 "ensure that your input is encoded in valid UTF-8"), which
     * aborts the entire indexing run over a single split emoji.
     */
    private static replaceLoneSurrogates(text: string): string {
        return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
    }

    /**
     * Detect embedding dimension 
     * @param testText Test text for dimension detection
     * @returns Embedding dimension
     */
    abstract detectDimension(testText?: string): Promise<number>;

    /**
     * Preprocess array of texts
     * @param texts Array of input texts
     * @returns Array of processed texts
     */
    protected preprocessTexts(texts: string[]): string[] {
        return texts.map(text => this.preprocessText(text));
    }

    // Abstract methods that must be implemented by subclasses
    /**
     * Generate text embedding vector
     * @param text Text content
     * @param options Optional per-call options (e.g. operation mode)
     * @returns Embedding vector
     */
    abstract embed(text: string, options?: EmbedOptions): Promise<EmbeddingVector>;

    /**
     * Generate text embedding vectors in batch
     * @param texts Text array
     * @param options Optional per-call options (e.g. operation mode)
     * @returns Embedding vector array
     */
    abstract embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingVector[]>;

    /**
     * Get embedding vector dimension
     * @returns Vector dimension
     */
    abstract getDimension(): number;

    /**
     * Get service provider name
     * @returns Provider name
     */
    abstract getProvider(): string;

    /**
     * Model identifier this instance embeds with. Used to bind an index to the model that
     * produced it: vectors from two different models are not comparable even when their
     * dimensions match, and that mismatch is otherwise invisible at query time.
     * Providers override this; the fallback only makes index naming coarser, never wrong.
     * @returns Model name
     */
    getModel(): string {
        return 'default';
    }
}