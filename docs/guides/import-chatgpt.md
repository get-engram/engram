# Import your ChatGPT / Claude history into Engram

A chat model can't bulk-upload your past conversations — it only sees the current
chat. To give Engram your real history, export your data and import the file with
the Engram CLI. **ChatGPT and Claude exports are both supported** (the format is
auto-detected). Every conversation is stored verbatim and embedded for semantic
search, so you can recall it from any connected client.

## 1. Export your data

**ChatGPT:** Settings → **Data controls → Export data**. You'll be emailed a
download link; unzip it and find **`conversations.json`**.

**Claude:** Settings → **Account → Export data**. Same idea — unzip and find
**`conversations.json`**.

## 2. Import it

You need an Engram API key (from [getengram.app/dashboard](https://getengram.app/dashboard)).

```bash
# Point the CLI at your key (or run `engram login` first)
export ENGRAM_API_KEY=engram_sk_live_...

# Preview first — counts only, writes nothing
npx @getengram/cli import ~/Downloads/chatgpt-export/conversations.json --dry-run

# Do the import
npx @getengram/cli import ~/Downloads/chatgpt-export/conversations.json
```

Each ChatGPT conversation becomes an Engram conversation (tagged
`chatgpt-import`), with user/assistant messages stored in order. System and
tool/code messages are skipped.

### Options

| Flag | Effect |
|------|--------|
| `--dry-run` | Parse and report counts without writing anything |
| `--limit <n>` | Import only the first `n` conversations |
| `--tag <name>` | Add an extra tag to every imported conversation |

## 3. Verify

```bash
npx @getengram/cli search "something you discussed in ChatGPT"
```

Or, in any connected client (ChatGPT, Claude, Cursor), ask it to search Engram —
your imported history is now part of your memory.

## Notes

- **Plan limits.** A full export can be large. If you hit your monthly message
  limit mid-import, the CLI stops and tells you — [upgrade](https://getengram.app/pricing)
  and re-run. Already-imported conversations will duplicate on a re-run, so clear
  them first if needed (filter by the `chatgpt-import` tag).
- **Re-running** imports everything again; it does not de-duplicate. Use
  `--limit` to test on a small slice first.
- **Going forward**, you don't need this — connected clients append new
  conversations to Engram live.
