# Reddit r/MachineLearning Draft

**Title:** [P] Engram: hybrid vector + FTS retrieval over verbatim conversation transcripts, with sliding-window chunking and RRF fusion

---

I've been working on a retrieval system designed specifically for conversational data (AI agent transcripts). The system, Engram, takes a different approach from most memory/RAG solutions: it stores complete conversation transcripts verbatim and relies entirely on the retrieval pipeline to surface relevant context. No extraction, no summarization, no knowledge graph construction.

**The retrieval pipeline:**

1. **Chunking**: Sliding window over message sequences. Window size 5, stride 3, overlap 2. Each chunk is formatted as `[role]: content` lines preserving turn structure. This was chosen empirically -- individual messages lack sufficient context for meaningful embeddings (a standalone "yes" is useless), while full-conversation embeddings lose specificity.

2. **Embedding**: BAAI bge-base-en-v1.5 (768 dimensions). Running on Cloudflare Workers AI, which provides zero-cost inference at the edge. Chunks are batch-embedded synchronously at write time. Typical latency: 10-30ms per batch.

3. **Indexing**: Vectors stored in Cloudflare Vectorize (HNSW-based ANN index, cosine similarity). Metadata-filtered by organization_id before similarity search for tenant isolation. Capacity: ~5M vectors on free tier.

4. **Hybrid retrieval**: At query time, two parallel search paths execute:
   - **Vector path**: Query text is embedded, nearest neighbors retrieved from Vectorize with metadata filtering
   - **Keyword path**: FTS5 full-text search over chunk text in SQLite (D1)

   Results are fused using **Reciprocal Rank Fusion** (RRF) with k=60. The RRF score for each chunk is: `sum(1 / (k + rank_i))` across both result lists, normalized to [0, 1] against the theoretical maximum. This handles the classic failure modes where vector search misses exact terms and keyword search misses semantic similarity.

5. **Post-processing**: Results are filtered by minimum score threshold (default 0.3), deduplicated per conversation (keep highest-scoring chunk per conversation), filtered by tag metadata, and truncated to the requested snippet size (default 2K chars, max 5K).

**Design decisions and tradeoffs:**

*Why verbatim over extraction?* Extraction (a la Mem0, MemGPT) produces compact, structured memories but is lossy. A conversation about "Postgres 16 JSONB GIN indexes being 30% slower for nested lookups" becomes "user prefers MongoDB for catalog service." The benchmark data, version specificity, and conditional nature of the decision are destroyed. For agent-to-agent memory transfer across sessions, we found that preserving the full reasoning chain matters more than saving tokens.

*Why sliding window over semantic chunking?* Conversations have natural turn-based boundaries. Semantic chunking (splitting on topic shifts) requires an additional inference pass and doesn't respect turn boundaries well. The fixed-window approach is deterministic, fast (no inference at chunk time), and the overlap ensures no context is orphaned at boundaries.

*Why RRF over learned fusion?* RRF is parameter-free (k=60 is standard) and robust. Learned fusion requires training data we don't have at this stage. The vector and keyword signals are sufficiently complementary for conversational data that RRF performs well empirically.

*Why not reranking?* We considered a cross-encoder reranking step but the latency budget is tight (target: <150ms total for search). The current pipeline achieves 50-150ms end-to-end. Adding a reranker would roughly double that. May revisit as the corpus grows.

**Infrastructure note:**

The entire system runs on Cloudflare's edge network. Compute (Workers), storage (D1/SQLite), vector index (Vectorize), and inference (Workers AI) all communicate via internal RPC bindings -- no HTTP between components. This gives sub-5ms latency for DB calls and ~20ms for embedding generation. The system is fully stateless per request (new V8 isolate per request, no connection pools, no shared state).

**Open questions I'd appreciate input on:**

- Better chunking strategies for multi-turn dialogue? The current approach doesn't account for topic coherence within windows.
- Experience with bge-base-en-v1.5 vs. alternatives (e.g., Nomic, Jina v3, GTE) for conversational retrieval specifically?
- Thoughts on when to add a reranking step vs. improving the first-stage retrieval?

Code: https://github.com/get-engram/engram
