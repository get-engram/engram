#!/usr/bin/env python3
"""
Generate SQL to seed a welcome conversation for all orgs with zero conversations.
Run the output through: wrangler d1 execute engram-db --remote --file=seed-welcome.sql
"""
import secrets
import string
import json

def nanoid(size=21):
    alphabet = string.ascii_letters + string.digits + '_-'
    return ''.join(secrets.choice(alphabet) for _ in range(size))

# Orgs with zero conversations (from D1 query)
# We'll generate the SQL that checks at insert time
WELCOME_TITLE = "Welcome to Engram"
AGENT_ID = "engram"
TAGS = json.dumps(["welcome", "getting-started"])
METADATA = json.dumps({"system": True, "type": "welcome"})

WELCOME_MESSAGE = """Welcome to Engram — your AI's long-term memory.

Here's how to get started:

1. **Save a conversation**: After a good chat, say "remember this" or "save this conversation." Your AI will store it in Engram.

2. **Recall later**: In any future session, ask "what do you remember about [topic]?" Your AI will search your stored conversations and bring back the context.

3. **Works everywhere**: Engram works across ChatGPT, Claude Code, Cursor, and any MCP-compatible tool. Save something in one, recall it in another.

That's it. Three steps. Your AI now has memory that persists across sessions, projects, and tools.

Try it now — have a conversation about something you're working on, then say "remember this." Tomorrow, ask about it and watch the magic happen."""

# Read org IDs from stdin or generate for all empty orgs
import sys

orgs_json = sys.stdin.read()
orgs = json.loads(orgs_json)
if isinstance(orgs, list) and len(orgs) > 0 and isinstance(orgs[0], dict) and 'results' in orgs[0]:
    orgs = orgs[0]['results']

stmts = []
for org in orgs:
    org_id = org['id']
    conv_id = f"conv_{nanoid()}"
    msg_id = f"msg_{nanoid()}"

    stmts.append(
        f"INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata, message_count, created_at, updated_at) "
        f"VALUES ('{conv_id}', '{org_id}', '{WELCOME_TITLE}', '{AGENT_ID}', '{TAGS}', '{METADATA}', 1, datetime('now'), datetime('now'));"
    )

    content = WELCOME_MESSAGE.replace("'", "''")
    stmts.append(
        f"INSERT INTO messages (id, conversation_id, organization_id, role, content, sequence, metadata, created_at) "
        f"VALUES ('{msg_id}', '{conv_id}', '{org_id}', 'assistant', '{content}', 0, '{{}}', datetime('now'));"
    )

print('\n'.join(stmts))
sys.stderr.write(f"Generated {len(orgs)} welcome conversations ({len(stmts)} statements)\n")
