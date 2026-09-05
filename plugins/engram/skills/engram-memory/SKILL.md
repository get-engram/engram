---
name: engram-memory
description: Use Engram as persistent memory across sessions — search it before starting work on a project, and save decisions and their reasoning before finishing. Use whenever the user refers to earlier work, past decisions, or something discussed in a previous session.
---

# Using Engram as memory

Engram stores conversations verbatim and retrieves them by meaning. Unlike a
summary-based memory, nothing is compressed or paraphrased — what was said is
what comes back.

## Search before you assume

At the start of work on a project, and any time the user references something
from before ("like we discussed", "the thing we decided", "last time"), search
first rather than asking them to repeat it:

```
search
  query: "<what you need to know>"
  limit: 5
```

Search by meaning, not keywords. "why did we pick this database" works better
than "database". If the first search misses, rephrase rather than giving up —
the index is semantic, so a different angle often finds it.

## Save what you would regret losing

Before finishing a substantial piece of work, save it:

```
create_conversation
  title: "<concise description of what was decided or built>"
  tags: [<project>, <topic>]

append_messages
  conversation_id: "<id from above>"
  messages:
    - role: "user"
      content: "<what was asked>"
    - role: "assistant"
      content: "<what was done, and WHY>"
```

**Save:** decisions and their reasoning, bugs and what actually caused them,
constraints the user stated, preferences they expressed, anything you had to
work out that isn't obvious from the code.

**Don't save:** routine file reads, trivial exchanges, or anything already
recorded in the repository or git history. Those are already durable; storing
them again adds noise to future searches.

## The reasoning matters more than the outcome

"We chose Cloudflare D1" is nearly useless six months later. "We chose D1
because we wanted to stay on Cloudflare and accepted the 10 GB cap, planning to
shard per-organization later" is the note that prevents the decision being
relitigated. Always record the why.
