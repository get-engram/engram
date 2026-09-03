#!/usr/bin/env python3
"""
Generate SQL to seed a welcome conversation for all orgs with zero conversations.
Run the output through: wrangler d1 execute engram-db --remote --file=seed-welcome.sql
"""
import secrets
import string
import json
import sys

def nanoid(size=21):
    """Generate a unique ID using standard alphabet for D1 efficiency."""
    alphabet = string.ascii_letters + string.digits + '_-'
    return ''.join(secrets.choice(alphabet) for _ in range(size))

# Orgs with zero conversations (from D1 query)
# We'll generate the SQL that checks at insert time
WELCOME_TITLE = "Welcome to Engram"
AGENT_ID = "engram"
TAGS = json.dumps(["welcome", "getting-started"])
METADATA = json.dumps({"system": True, "type": "welcome"})

# Use standard en-dash for better Unicode compatibility in D1
WELCOME_MESSAGE = (
    "Welcome to Engram — your AI's long-term memory.\n\n"
    "Here's how to get started:\n\n"
    '1. **Save a conversation**: After a good chat, say "remember this" or "save this conversation." '
    "Your AI will store it in Engram.\n\n"
    '2. **Recall later**: In any future session, ask "what do you remember about [topic]?" '
    "Your AI will search your stored conversations and bring back the context.\n\n"
    '3. **Works everywhere**: Engram works across ChatGPT, Claude Code, Cursor, and any MCP-compatible tool. '
    "Save something in one, recall it in another.\n\n"
    "That's it. Three steps. Your AI now has memory that persists across sessions, projects, and tools.\n\n"
    'Try it now — have a conversation about something you\'re working on, then say "remember this." '
    "Tomorrow, ask about it and watch the magic happen."
)

def normalize_orgs(data):
    """
    Normalize the raw JSON from stdin (often D1 export format) into a simple list of dicts.
    Handles the 'results' wrapper often found in nested D1 exports.
    """
    if isinstance(data, list) and len(data) > 0 and isinstance(data[0], dict):
        if 'results' in data[0]:
            return data[0]['results']
        return data
    
    # Fallback: if it's just a list of dicts
    return data

stmts = []

# Read org IDs from stdin or generate for all empty orgs
orgs_json = sys.stdin.read()
if orgs_json.strip():
    orgs = json.loads(orgs_json)
    orgs = normalize_orgs(orgs)

    for org in orgs:
        org_id = org['id']
        conv_id = f"conv_{nanoid()}"
        msg_id = f"msg_{nanoid()}"

        # Conversation insert
        stmts.append(
            f"INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata, message_count, created_at, updated_at) "
            f"VALUES ('{conv_id}', '{org_id}', '{WELCOME_TITLE}', '{AGENT_ID}', '{TAGS}', '{METADATA}', 1, datetime('now'), datetime('now'));"
        )

        # Message insert (escaping single quotes for the SQL string)
        content = WELCOME_MESSAGE.replace("'", "''")
        stmts.append(
            f"INSERT INTO messages (id, conversation_id, organization_id, role, content, sequence, metadata, created_at) "
            f"VALUES ('{msg_id}', '{conv_id}', '{org_id}', 'assistant', '{content}', 0, '{{}}', datetime('now'));"
        )

print('\n'.join(stmts))
sys.stderr.write(f"Generated {len(orgs)} welcome conversations ({len(stmts)} statements)\n")