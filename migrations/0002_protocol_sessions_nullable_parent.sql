-- Repair protocol session schema for databases where the old
-- sessions migration is already recorded with parent_message_id NOT NULL.
-- This migration is safe for fresh databases as well.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
  chat_session_id TEXT PRIMARY KEY,
  parent_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions_protocol_v3 (
  chat_session_id TEXT PRIMARY KEY,
  parent_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO sessions_protocol_v3 (chat_session_id, parent_message_id, created_at, updated_at)
SELECT chat_session_id,
       CASE WHEN parent_message_id = 0 THEN NULL ELSE parent_message_id END,
       created_at,
       updated_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_protocol_v3 RENAME TO sessions;

COMMIT;
