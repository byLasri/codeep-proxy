-- Protocol session state migration.
-- Creates the canonical sessions table with nullable parent_message_id.
-- The CREATE below makes the migration safe for a fresh database; on an existing
-- database it is a no-op and the existing rows are converted transactionally.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  chat_session_id TEXT PRIMARY KEY,
  parent_message_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions_protocol_v2 (
  chat_session_id TEXT PRIMARY KEY,
  parent_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO sessions_protocol_v2 (chat_session_id, parent_message_id, created_at, updated_at)
SELECT chat_session_id,
       CASE WHEN parent_message_id = 0 THEN NULL ELSE parent_message_id END,
       created_at,
       updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_protocol_v2 RENAME TO sessions;

COMMIT;
