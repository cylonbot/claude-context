import { VoyageAIClient } from 'voyageai';
import { Embedding, EmbeddingVector, EmbedOptions } from './base-embedding';
import { SlidingWindowRateLimiter } from './voyage-rate-limiter';

export interface VoyageAIEmbeddingConfig {
    model: string;
    /** Paid / commercial key (VOYAGEAI_API_KEY). Required. Used for full indexing and as search fallback. */
    apiKey: string;
    /** Pool of free keys (VOYAGEAI_API_KEY_FREE, comma-separated). Each gets its own RPM/TPM window;
     *  incremental indexing fans out across them (one worker per key) and search picks any with budget. */
    freeApiKeys?: string[];
    /** Single free key — back-compat shorthand for a one-element freeApiKeys. */
    freeApiKey?: string;
    /** Free-tier requests-per-minute limit (default 3). */
    freeRpm?: number;
    /** Free-tier tokens-per-minute limit (default 10000). */
    freeTpm?: number;
    /** Patience for a single chunk that keeps hitting 429 on the free key (default 100 window-waits). */
    incrementalMaxRetries?: number;
    /** Fraction of the real free TPM we actually pace/size against, to absorb token-estimate error (default 0.7). */
    freeTpmSafety?: number;
    /** Optional sink for incremental embedding progress (e.g. wired to the MCP sync log file). */
    logger?: (message: string) => void;
}

export const DEFAULT_FREE_RPM = 3;
export const DEFAULT_FREE_TPM = 10000;
// High by design: this is per-single-chunk patience (each retry waits a full window), NOT a
// "give up on the batch" cap. Background incremental should keep pausing-and-retrying, not fail.
const DEFAULT_INCREMENTAL_MAX_RETRIES = 100;
export const DEFAULT_FREE_TPM_SAFETY = 0.7;

export class VoyageAIEmbedding extends Embedding {
    /** Paid client — full indexing + search fallback. */
    private paidClient: VoyageAIClient;
    /** Pool of free keys, each with its own rate-limit window (its own 10K TPM). Empty → everything on paid. */
    private freePool: Array<{ client: VoyageAIClient; limiter: SlidingWindowRateLimiter }>;
    /** Whether at least one distinct free key was provided. When false, everything runs on the paid key. */
    private hasFree: boolean;
    /** Round-robin cursor for single-embed incremental across the free pool. */
    private rrCounter: number = 0;
    private freeTpm: number;
    private effectiveFreeTpm: number;
    private incrementalMaxRetries: number;
    private logger?: (message: string) => void;
    private model: string;
    private dimension: number = 1024; // Default dimension for voyage-code-3
    private inputType: 'document' | 'query' = 'document';
    protected maxTokens: number = 32000; // Default max tokens

    constructor(config: VoyageAIEmbeddingConfig) {
        super();
        this.model = config.model || 'voyage-code-3';
        this.paidClient = new VoyageAIClient({ apiKey: config.apiKey });

        const freeRpm = config.freeRpm ?? DEFAULT_FREE_RPM;
        this.freeTpm = config.freeTpm ?? DEFAULT_FREE_TPM;
        this.incrementalMaxRetries = config.incrementalMaxRetries ?? DEFAULT_INCREMENTAL_MAX_RETRIES;
        this.logger = config.logger;
        // Our token counts are estimates (~chars/4) and code is denser than that, so we pace and
        // size free-tier requests against a conservative fraction of the real TPM. A single request
        // that actually exceeds the per-minute token cap can NEVER succeed (it 429s no matter how
        // long we wait), so staying well under it is what keeps incremental indexing reliable.
        const safety = config.freeTpmSafety ?? DEFAULT_FREE_TPM_SAFETY;
        this.effectiveFreeTpm = Math.max(1, Math.floor(this.freeTpm * safety));

        // Build the free-key pool (each key = its own client + its own rate-limit window).
        const freeKeys = [...new Set([
            ...(config.freeApiKeys ?? []),
            ...(config.freeApiKey ? [config.freeApiKey] : []),
        ].map(k => k.trim()).filter(Boolean))];
        this.freePool = freeKeys.map(key => ({
            client: new VoyageAIClient({ apiKey: key }),
            limiter: new SlidingWindowRateLimiter(freeRpm, this.effectiveFreeTpm),
        }));
        this.hasFree = this.freePool.length > 0;

        if (this.hasFree) {
            console.log(`[VoyageAI] 🔑 Dual-key mode: ${this.freePool.length} free key(s) (search + incremental, each ${freeRpm} RPM / ${this.freeTpm} TPM, pacing ~${this.effectiveFreeTpm} est-tokens/min @ safety ${safety}; incremental fans out across them) + paid key (full indexing + search fallback)`);
        } else {
            console.warn(`[VoyageAI] ⚠️  No VOYAGEAI_API_KEY_FREE provided — all operations use the single paid key (VOYAGEAI_API_KEY)`);
        }

        // Set dimension and context length based on different models
        this.updateModelSettings(this.model);
    }

    private estimateTokens(text: string): number {
        // Rough estimate consistent with the rest of the codebase (~4 chars/token).
        return Math.max(1, Math.ceil(text.length / 4));
    }

    private isRateLimitError(err: any): boolean {
        const code = err?.statusCode ?? err?.status ?? err?.response?.status;
        if (code === 429) {
            return true;
        }
        const msg = (err?.message ?? String(err ?? '')).toLowerCase();
        return /\b429\b|too many requests|rate limit/.test(msg);
    }

    /** Single network call + response validation. Works for both single and batch input. */
    private async callEmbedRaw(client: VoyageAIClient, input: string | string[]): Promise<EmbeddingVector[]> {
        const response = await client.embed({
            input,
            model: this.model,
            inputType: this.inputType,
        });

        if (!response.data) {
            throw new Error('VoyageAI API returned invalid response');
        }

        // Guard against any out-of-order batch response: align by the item index so
        // vectors can never be silently mismatched with their source chunks.
        const ordered = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        return ordered.map((item) => {
            if (!item.embedding) {
                throw new Error('VoyageAI API returned invalid embedding data');
            }
            return {
                vector: item.embedding,
                dimension: this.dimension
            };
        });
    }

    /**
     * Embed a group of chunks on the free key, reliably:
     *  - pace via the sliding-window limiter (respect RPM + TPM),
     *  - on a real 429, if the group has >1 chunk, HALVE it and retry each half — this
     *    auto-adapts the request size down to whatever the free tier actually accepts,
     *    so we never get stuck retrying a request that is fundamentally too big,
     *  - a lone chunk that still 429s is pure window contention: wait out the window and
     *    retry patiently (background work, no hard "give up" — only a high runaway guard),
     *  - non-429 errors fail fast (don't loop on a genuinely broken chunk).
     * Never falls back to paid (incremental is free-only by design).
     */
    private async embedFreeResilient(texts: string[], poolIndex: number, singleChunkAttempt: number = 0): Promise<EmbeddingVector[]> {
        const pool = this.freePool[poolIndex];
        const tokens = texts.reduce((sum, t) => sum + this.estimateTokens(t), 0);
        // waitForCapacity atomically reserves the slot before we await the network call.
        await pool.limiter.waitForCapacity(tokens);
        try {
            const res = await this.callEmbedRaw(pool.client, texts);
            this.logger?.(`embed(free#${poolIndex}): ${texts.length} chunk(s), ~${tokens} est-tokens — ok`);
            return res;
        } catch (err) {
            if (!this.isRateLimitError(err)) {
                throw err; // genuine error — don't loop forever
            }
            pool.limiter.markExhausted();
            if (texts.length > 1) {
                const mid = Math.floor(texts.length / 2);
                this.logger?.(`embed(free#${poolIndex}): 429 on ${texts.length} chunks (~${tokens} tok) → splitting ${mid}+${texts.length - mid}`);
                const left = await this.embedFreeResilient(texts.slice(0, mid), poolIndex);
                const right = await this.embedFreeResilient(texts.slice(mid), poolIndex);
                return [...left, ...right];
            }
            if (singleChunkAttempt >= this.incrementalMaxRetries) {
                throw new Error(`Free tier still rate-limiting a single chunk after ${this.incrementalMaxRetries} window-waits: ${(err as any)?.message || err}`);
            }
            this.logger?.(`embed(free#${poolIndex}): 429 on a single chunk — waiting for window, retry ${singleChunkAttempt + 1}/${this.incrementalMaxRetries}`);
            return this.embedFreeResilient(texts, poolIndex, singleChunkAttempt + 1);
        }
    }

    /** Split texts into sub-batches whose estimated tokens stay within the free TPM budget. */
    private splitByTokenBudget(texts: string[], budget: number): string[][] {
        const batches: string[][] = [];
        let current: string[] = [];
        let currentTokens = 0;
        for (const text of texts) {
            const t = this.estimateTokens(text);
            // Always keep at least one item per sub-batch, even if it alone exceeds the budget.
            if (current.length > 0 && currentTokens + t > budget) {
                batches.push(current);
                current = [];
                currentTokens = 0;
            }
            current.push(text);
            currentTokens += t;
        }
        if (current.length > 0) {
            batches.push(current);
        }
        return batches;
    }

    private updateModelSettings(model: string): void {
        const supportedModels = VoyageAIEmbedding.getSupportedModels();
        const modelInfo = supportedModels[model];

        if (modelInfo) {
            if (typeof modelInfo.dimension === 'string') {
                // Parse default dimension from string like "1024 (default), 256, 512, 2048"
                const match = modelInfo.dimension.match(/^(\d+)/);
                this.dimension = match ? parseInt(match[1], 10) : 1024;
            } else {
                this.dimension = modelInfo.dimension;
            }
            // Set max tokens based on model's context length
            this.maxTokens = modelInfo.contextLength;
        } else {
            // Use default dimension and context length for unknown models
            this.dimension = 1024;
            this.maxTokens = 32000;
        }
    }

    async detectDimension(): Promise<number> {
        // VoyageAI doesn't need dynamic detection, return configured dimension
        return this.dimension;
    }

    /**
     * Embed a single text. Only used by the search path, so the default mode is 'search':
     * try the free key first and proactively fall back to the paid key once the free
     * sliding-window budget would be exceeded (or on a real 429).
     */
    async embed(text: string, options?: EmbedOptions): Promise<EmbeddingVector> {
        const mode = options?.mode ?? 'search';
        const processedText = this.preprocessText(text);
        const tokens = this.estimateTokens(processedText);

        // Full indexing, or no distinct free key configured → always paid.
        if (mode === 'full' || !this.hasFree) {
            return (await this.callEmbedRaw(this.paidClient, processedText))[0];
        }

        // Incremental → free only, paced + resilient (never paid). Round-robin across the pool.
        if (mode === 'incremental') {
            const idx = (this.rrCounter++) % this.freePool.length;
            return (await this.embedFreeResilient([processedText], idx))[0];
        }

        // Search (default): use the first free key that still has per-minute budget; only when
        // EVERY free key is at its budget do we fall back to paid. tryAcquire reserves atomically,
        // so concurrent searches can't all slip past a key's budget.
        for (let i = 0; i < this.freePool.length; i++) {
            if (!this.freePool[i].limiter.tryAcquire(tokens)) {
                continue;
            }
            try {
                return (await this.callEmbedRaw(this.freePool[i].client, processedText))[0];
            } catch (err) {
                if (this.isRateLimitError(err)) {
                    // This key was actually exhausted — shut its window and try the next free key.
                    this.freePool[i].limiter.markExhausted();
                    continue;
                }
                throw err;
            }
        }
        // Every free key is at (or just hit) its per-minute budget → paid.
        return (await this.callEmbedRaw(this.paidClient, processedText))[0];
    }

    /**
     * Embed a batch of texts. Only used by the indexing path.
     *   - 'full' (default): always paid key, no throttling.
     *   - 'incremental': free key only, split into TPM-bounded sub-batches and paced
     *     by the sliding-window limiter so the free tier (RPM + TPM) is respected.
     */
    async embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingVector[]> {
        const mode = options?.mode ?? 'full';
        const processedTexts = this.preprocessTexts(texts);

        if (mode === 'incremental' && this.hasFree) {
            const subBatches = this.splitByTokenBudget(processedTexts, this.effectiveFreeTpm);
            this.logger?.(`embed(free) incremental: ${processedTexts.length} chunks → ${subBatches.length} sub-batch(es) @ ≤${this.effectiveFreeTpm} est-tokens, across ${this.freePool.length} free key(s)`);
            // One worker per free key, each paced on its OWN rate-limit window. Workers pull
            // sub-batches off a shared cursor (synchronous read+increment is atomic in JS), so N
            // keys ≈ N× throughput. Results are stored by index to preserve input order.
            const results: EmbeddingVector[][] = new Array(subBatches.length);
            let cursor = 0;
            const worker = async (poolIndex: number) => {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const i = cursor++;
                    if (i >= subBatches.length) return;
                    this.logger?.(`embed(free#${poolIndex}): sub-batch ${i + 1}/${subBatches.length} (${subBatches[i].length} chunks)...`);
                    results[i] = await this.embedFreeResilient(subBatches[i], poolIndex);
                }
            };
            await Promise.all(this.freePool.map((_, k) => worker(k)));
            return results.flat();
        }

        // Full indexing (or incremental without a free key) → paid, no throttle.
        return this.callEmbedRaw(this.paidClient, processedTexts);
    }

    getDimension(): number {
        return this.dimension;
    }

    getProvider(): string {
        return 'VoyageAI';
    }

    /**
     * Set model type
     * @param model Model name
     */
    setModel(model: string): void {
        this.model = model;
        this.updateModelSettings(model);
    }

    /**
     * Set input type (VoyageAI specific feature)
     * @param inputType Input type: 'document' | 'query'
     */
    setInputType(inputType: 'document' | 'query'): void {
        this.inputType = inputType;
    }

    /**
     * Get client instance (for advanced usage). Returns the paid client.
     */
    getClient(): VoyageAIClient {
        return this.paidClient;
    }

    /**
     * Get list of supported models
     */
    static getSupportedModels(): Record<string, { dimension: number | string; contextLength: number; description: string }> {
        return {
            // Voyage 4 series (January 2026)
            'voyage-4-large': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Best general-purpose and multilingual retrieval quality (latest)'
            },
            'voyage-4': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Optimized for general-purpose and multilingual retrieval quality'
            },
            'voyage-4-lite': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Optimized for latency and cost'
            },
            'voyage-4-nano': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Open-weight model, smallest and fastest'
            },
            // Voyage 3 series
            'voyage-3-large': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'The best general-purpose and multilingual retrieval quality'
            },
            'voyage-3.5': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Optimized for general-purpose and multilingual retrieval quality'
            },
            'voyage-3.5-lite': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Optimized for latency and cost'
            },
            'voyage-code-3': {
                dimension: '1024 (default), 256, 512, 2048',
                contextLength: 32000,
                description: 'Optimized for code retrieval (recommended for code)'
            },
            // Professional domain models
            'voyage-finance-2': {
                dimension: 1024,
                contextLength: 32000,
                description: 'Optimized for finance retrieval and RAG'
            },
            'voyage-law-2': {
                dimension: 1024,
                contextLength: 16000,
                description: 'Optimized for legal retrieval and RAG'
            },
            'voyage-multilingual-2': {
                dimension: 1024,
                contextLength: 32000,
                description: 'Legacy: Use voyage-3.5 for multilingual tasks'
            },
            'voyage-large-2-instruct': {
                dimension: 1024,
                contextLength: 16000,
                description: 'Legacy: Use voyage-3.5 instead'
            },
            // Legacy models
            'voyage-large-2': {
                dimension: 1536,
                contextLength: 16000,
                description: 'Legacy: Use voyage-3.5 instead'
            },
            'voyage-code-2': {
                dimension: 1536,
                contextLength: 16000,
                description: 'Previous generation of code embeddings'
            },
            'voyage-3': {
                dimension: 1024,
                contextLength: 32000,
                description: 'Legacy: Use voyage-3.5 instead'
            },
            'voyage-3-lite': {
                dimension: 512,
                contextLength: 32000,
                description: 'Legacy: Use voyage-3.5-lite instead'
            },
            'voyage-2': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy: Use voyage-3.5-lite instead'
            },
            // Other legacy models
            'voyage-02': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-01': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-01': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-01-instruct': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            },
            'voyage-lite-02-instruct': {
                dimension: 1024,
                contextLength: 4000,
                description: 'Legacy model'
            }
        };
    }
} 