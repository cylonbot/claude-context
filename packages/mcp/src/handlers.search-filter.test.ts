import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ToolHandlers } from "./handlers.js";
import { SnapshotManager } from "./snapshot.js";

interface SearchCall {
    codebasePath: string;
    query: string;
    topK: number;
    threshold: number;
    filterExpr?: string;
}

async function withTempHome(run: (tempRoot: string) => Promise<void>): Promise<void> {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "claude-context-mcp-search-"));
    const homeDir = path.join(tempRoot, "home");
    await mkdir(homeDir, { recursive: true });

    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    try {
        await run(tempRoot);
    } finally {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }

        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }

        await rm(tempRoot, { recursive: true, force: true });
    }
}

const HITS = [
    { relativePath: "src/lib/a.ts", startLine: 1, endLine: 9, language: "typescript", score: 0.91, content: "export const a = 1;" },
    { relativePath: "test/lib/a.test.ts", startLine: 4, endLine: 20, language: "typescript", score: 0.88, content: "test('a', () => {});" },
    { relativePath: "src/vendor/b.ts", startLine: 2, endLine: 5, language: "typescript", score: 0.85, content: "export const b = 2;" },
    { relativePath: "docs/x.md", startLine: 1, endLine: 3, language: "markdown", score: 0.8, content: "# x" },
];

const SRC_CLAUSE = String.raw`((relativePath >= "src/" and relativePath < "src0") or (relativePath >= "src\\" and relativePath < "src]"))`;
const TEST_CLAUSE = String.raw`((relativePath >= "test/" and relativePath < "test0") or (relativePath >= "test\\" and relativePath < "test]"))`;
const SRC_LIB_CLAUSE = String.raw`((relativePath >= "src/lib/" and relativePath < "src/lib0") or (relativePath >= "src\\lib\\" and relativePath < "src\\lib]"))`;

/** Evaluate one OR clause with UTF-8 byte ordering, as used by Milvus strings. */
function matchesRangeClause(relativePath: string, clause: string): boolean {
    assert.doesNotMatch(clause, /\blike\b/i, 'Prefix filtering must not depend on LIKE escaping');
    const ranges = Array.from(clause.matchAll(/relativePath >= ("(?:\\.|[^"\\])*")(?: and relativePath < ("(?:\\.|[^"\\])*"))?/g));
    assert.ok(ranges.length > 0, `Missing range clause: ${clause}`);
    const value = Buffer.from(relativePath);
    return ranges.some(([, lower, upper]) => {
        return Buffer.compare(value, Buffer.from(JSON.parse(lower))) >= 0
            && (upper === undefined || Buffer.compare(value, Buffer.from(JSON.parse(upper))) < 0);
    });
}

async function makeHandlers(tempRoot: string, results: any[] = HITS, search?: (call: SearchCall) => any[]) {
    const codebasePath = path.join(tempRoot, "repo");
    await mkdir(codebasePath, { recursive: true });

    const snapshotManager = new SnapshotManager();
    snapshotManager.setCodebaseIndexed(codebasePath, {
        indexedFiles: 2,
        totalChunks: Math.max(1, results.length),
        status: "completed",
    });
    // getIndexedCodebases() re-reads the snapshot file, not the in-memory list:
    // without persisting, the handler sees the codebase as not indexed.
    snapshotManager.saveCodebaseSnapshot();

    const calls: SearchCall[] = [];
    const context: any = {
        getEmbedding: () => ({ getProvider: () => "test" }),
        getCollectionName: () => "ctx_test",
        getVectorDatabase: () => ({ hasCollection: async () => true }),
        semanticSearch: async (searchedPath: string, query: string, topK: number, threshold: number, filterExpr?: string) => {
            const call = { codebasePath: searchedPath, query, topK, threshold, filterExpr };
            calls.push(call);
            return search ? search(call) : results;
        },
    };

    const handlers = new ToolHandlers(context, snapshotManager);
    (handlers as any).syncIndexedCodebasesFromCloud = async () => {};
    return { handlers, calls, codebasePath };
}

test("search keeps its previous contract when no path filter is given", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "anything" });

        assert.equal(result.isError, undefined);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].filterExpr, undefined);
        assert.equal(calls[0].topK, 10);
        assert.match(result.content[0].text, /Found 4 results/);
        assert.equal(result.structuredContent.count, 4);
        assert.equal(result.structuredContent.results[0].path, "src/lib/a.ts");
        assert.equal(result.structuredContent.results[0].score, 0.91);
    });
});

test("extensionFilter still builds the same Milvus clause and does not trigger the JS path filter", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "q", extensionFilter: [".ts"] });

        assert.equal(calls[0].filterExpr, "fileExtension in ['.ts']");
        assert.equal(calls[0].topK, 10);
        assert.equal(result.structuredContent.count, 4);
    });
});

test("includePaths goes to Milvus and is re-checked in JS", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "q", includePaths: ["src/"] });

        assert.equal(calls[0].filterExpr, SRC_CLAUSE);
        assert.equal(calls[0].topK, 10);
        assert.deepEqual(result.structuredContent.results.map((r: any) => r.path), ["src/lib/a.ts", "src/vendor/b.ts"]);
    });
});

test("excludePaths goes to Milvus and is re-checked in JS", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "q", excludePaths: ["test/"] });

        assert.equal(calls[0].filterExpr, 'not ' + TEST_CLAUSE);
        assert.equal(calls[0].topK, 10);
        assert.equal(result.structuredContent.count, 3);
        assert.ok(!result.structuredContent.results.some((r: any) => r.path.startsWith("test/")));
    });
});

test("combined filters AND the extension clause with the include clause", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({
            path: codebasePath,
            query: "q",
            extensionFilter: [".ts"],
            includePaths: ["src/", "packages/"],
            excludePaths: ["src/vendor/"],
        });

        assert.equal(
            calls[0].filterExpr,
            String.raw`fileExtension in ['.ts'] and ((relativePath >= "src/" and relativePath < "src0") or (relativePath >= "src\\" and relativePath < "src]") or (relativePath >= "packages/" and relativePath < "packages0") or (relativePath >= "packages\\" and relativePath < "packages]")) and not ((relativePath >= "src/vendor/" and relativePath < "src/vendor0") or (relativePath >= "src\\vendor\\" and relativePath < "src\\vendor]"))`,
        );
        assert.deepEqual(result.structuredContent.results.map((r: any) => r.path), ["src/lib/a.ts"]);
    });
});

test("windows separators in prefixes are normalized to '/'", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "q", includePaths: ["src\\lib\\"] });

        assert.equal(calls[0].filterExpr, SRC_LIB_CLAUSE);
        assert.deepEqual(result.structuredContent.results.map((r: any) => r.path), ["src/lib/a.ts"]);
    });
});

test("invalid path prefixes fail the call before any search", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot);

        const result: any = await handlers.handleSearchCode({
            path: codebasePath,
            query: "q",
            includePaths: ["/abs/", "../x", "src/%", 42, ""],
        });

        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
        assert.match(result.content[0].text, /Invalid path prefixes/);
    });
});

test("an empty result still carries structuredContent", async () => {
    await withTempHome(async (tempRoot) => {
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot, []);

        const result: any = await handlers.handleSearchCode({ path: codebasePath, query: "nothing", excludePaths: ["test/"] });

        assert.equal(calls.length, 1);
        assert.match(result.content[0].text, /No results found/);
        assert.equal(result.structuredContent.count, 0);
        assert.deepEqual(result.structuredContent.results, []);
    });
});

test("path filters work with backslash paths already stored by Windows indexing", async () => {
    await withTempHome(async (tempRoot) => {
        const windowsHits = HITS.map((hit) => ({ ...hit, relativePath: hit.relativePath.replace(/\//g, "\\") }));
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot, windowsHits);

        const result: any = await handlers.handleSearchCode({
            path: codebasePath,
            query: "q",
            includePaths: ["src\\"],
            excludePaths: ["src/vendor/"],
        });

        assert.deepEqual(result.structuredContent.results.map((r: any) => r.path), ["src\\lib\\a.ts"]);
        const lowerBounds = Array.from(calls[0].filterExpr!.matchAll(/relativePath >= ("(?:\\.|[^"\\])*")/g), (match) => JSON.parse(match[1]));
        assert.deepEqual(lowerBounds, ["src/", "src\\", "src/vendor/", "src\\vendor\\"]);
        const [includeClause, excludeClause] = calls[0].filterExpr!.split(' and not ');
        assert.equal(matchesRangeClause("src\\lib\\a.ts", includeClause), true);
        assert.equal(matchesRangeClause("src\\vendor\\b.ts", excludeClause), true);
        assert.equal(matchesRangeClause("test\\lib\\a.test.ts", includeClause), false);
    });
});

for (const limit of [10, 50]) {
    test(`exclusions are applied before topK even with more than 50 excluded hits (limit=${limit})`, async () => {
        await withTempHome(async (tempRoot) => {
            const ranked = [
                ...Array.from({ length: 60 }, (_, i) => ({ ...HITS[3], relativePath: `docs/${i}.md` })),
                ...Array.from({ length: 50 }, (_, i) => ({ ...HITS[0], relativePath: `src/${i}.ts` })),
            ];
            const { handlers, calls, codebasePath } = await makeHandlers(tempRoot, ranked, (call) => {
                // Model the database contract: scalar filtering happens BEFORE topK.
                const candidates = call.filterExpr
                    ? ranked.filter((hit) => !matchesRangeClause(hit.relativePath, call.filterExpr!))
                    : ranked;
                if (call.filterExpr) assert.match(call.filterExpr, /^not \(/);
                return candidates.slice(0, call.topK);
            });

            const result: any = await handlers.handleSearchCode({
                path: codebasePath, query: "q", limit, excludePaths: ["docs/"],
            });

            assert.equal(result.structuredContent.count, limit);
            assert.ok(result.structuredContent.results.every((hit: any) => hit.path.startsWith("src/")));
            assert.equal(calls.length, 1);
            assert.equal(calls[0].topK, limit);
            const lowerBounds = Array.from(calls[0].filterExpr!.matchAll(/relativePath >= ("(?:\\.|[^"\\])*")/g), (match) => JSON.parse(match[1]));
            assert.deepEqual(lowerBounds, ["docs/", "docs\\"]);
        });
    });
}

test("underscores are literal in server-side exclusions and do not remove sibling paths", async () => {
    await withTempHome(async (tempRoot) => {
        const hits = ["src_vendor/a.ts", "src_vendor\\b.ts", "src-vendor/c.ts", "srcXvendor\\d.ts"]
            .map((relativePath) => ({ ...HITS[0], relativePath }));
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot, hits, (call) => {
            assert.match(call.filterExpr!, /^not \(/);
            return hits.filter((hit) => !matchesRangeClause(hit.relativePath, call.filterExpr!)).slice(0, call.topK);
        });

        const result: any = await handlers.handleSearchCode({
            path: codebasePath, query: "q", excludePaths: ["src_vendor/"],
        });

        assert.deepEqual(result.structuredContent.results.map((hit: any) => hit.path), ["src-vendor/c.ts", "srcXvendor\\d.ts"]);
        const lowerBounds = Array.from(calls[0].filterExpr!.matchAll(/relativePath >= ("(?:\\.|[^"\\])*")/g), (match) => JSON.parse(match[1]));
        assert.deepEqual(lowerBounds, ["src_vendor/", "src_vendor\\"]);
    });
});

test("prefix ranges preserve startsWith semantics at Unicode and path boundaries", async () => {
    await withTempHome(async (tempRoot) => {
        const paths = [
            "src", "src/a.ts", "src2/a.ts", "srd/a.ts", "sr/a.ts",
            "src_vendor/a.ts", "src-vendor/a.ts", "src\\lib\\a.ts",
            "模块/😀a.ts", "模块/😁a.ts", "模块/🗿a.ts",
            "\ud7ff/a.ts", "\ue000/a.ts", "\uffff/a.ts", "𐀀/a.ts",
            "\u{10ffff}", "\u{10ffff}/a.ts", "dir\u{10ffff}/a.ts", "dis/a.ts",
        ];
        const { handlers, calls, codebasePath } = await makeHandlers(tempRoot, []);
        for (const prefix of ["src", "src/", "src_vendor/", "模块/😀", "\ud7ff", "\uffff", "\u{10ffff}", "dir\u{10ffff}"]) {
            await handlers.handleSearchCode({ path: codebasePath, query: "q", includePaths: [prefix] });
            const expression = calls[calls.length - 1].filterExpr!;
            for (const relativePath of paths) {
                assert.equal(
                    matchesRangeClause(relativePath, expression),
                    relativePath.replace(/\\/g, '/').startsWith(prefix),
                    `prefix=${JSON.stringify(prefix)}, path=${JSON.stringify(relativePath)}`,
                );
            }
        }
    });
});
