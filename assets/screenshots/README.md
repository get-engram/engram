# App Directory screenshots

Real captures of Engram working in ChatGPT (neutral demo content — no personal
data), for the ChatGPT App Directory submission (#191, epic #184).

| File | Shows | Use for submission |
|------|-------|--------------------|
| `01-connector-detail.png` | Engram connected (OAuth, MCP URL, tools) | ✅ connected state |
| `02-apps-list.png` | Engram enabled in ChatGPT's Apps list | optional |
| `03-store-memory.png` | "Use Engram to remember…" → *Remembered in Engram* | ✅ store |
| `04-recall-memory.png` | "Search Engram — what did we decide about rate limiting?" → recalls the sliding-window/Redis decision | ✅ **recall (hero shot)** |
| `05-store-preference.png` | "Remember I like concise answers…" → *Remembered* | ✅ store (2nd example) |
| `06-recall-preference.png` | "What are my writing preferences?" → *Concise, no preamble* | ✅ recall (2nd example) |
| `07-tool-call-in-progress.png` | tool call mid-flight | reference only |

**Recommended set for the form:** 04 (recall/hero), 03 (store), 06 + 05
(preference recall/store), 01 (connected). 

**Dimensions:** raw captures range ~1130×1245 (chat) to ~1354×1058 (settings).
The submission form states the exact required dimensions at upload time —
resize/crop to spec then (e.g. `sips -z <h> <w>` or `--cropToHeightWidth`).
