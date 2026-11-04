// Takes a database back from v24 (one message table) to the three message tables before it, keeping
// each message's id, so tests that roll a database back further start from the layout those versions had.
export const UNDO_V24 = `
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escalation_id TEXT NOT NULL REFERENCES escalations(id),
    author_kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_escalation ON messages(escalation_id, id);
  CREATE TABLE lane_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX lane_messages_lane ON lane_messages(lane_id, id);
  CREATE TABLE epic_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_id INTEGER NOT NULL REFERENCES epics(num) ON DELETE CASCADE,
    author_kind TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX epic_messages_epic ON epic_messages(epic_id, id);
  INSERT INTO messages SELECT id, escalation_id, author_kind, author, body, created_at FROM group_messages WHERE escalation_id IS NOT NULL;
  INSERT INTO lane_messages SELECT id, lane_id, author_kind, author, body, created_at FROM group_messages WHERE lane_id IS NOT NULL;
  INSERT INTO epic_messages SELECT id, epic_id, author_kind, author, body, created_at FROM group_messages WHERE epic_id IS NOT NULL;
  ALTER TABLE attachments ADD COLUMN message_id INTEGER;
  ALTER TABLE attachments ADD COLUMN lane_message_id INTEGER;
  ALTER TABLE attachments ADD COLUMN epic_message_id INTEGER;
  UPDATE attachments SET message_id = group_message_id WHERE group_message_id IN (SELECT id FROM messages);
  UPDATE attachments SET lane_message_id = group_message_id WHERE group_message_id IN (SELECT id FROM lane_messages);
  UPDATE attachments SET epic_message_id = group_message_id WHERE group_message_id IN (SELECT id FROM epic_messages);
  CREATE INDEX attachments_message ON attachments(message_id) WHERE message_id IS NOT NULL;
  CREATE INDEX attachments_lane_message ON attachments(lane_message_id) WHERE lane_message_id IS NOT NULL;
  CREATE INDEX attachments_epic_message ON attachments(epic_message_id) WHERE epic_message_id IS NOT NULL;
  DROP INDEX attachments_group_message;
  ALTER TABLE attachments DROP COLUMN group_message_id;
  DROP TABLE group_messages;
  UPDATE meta SET value = '23' WHERE key = 'schema_version';
`;

// Takes a database back from v26 (groups hold questions of their own): their internal lanes, their
// own questions, and their codes and status lines go.
export const UNDO_V26 = `
  DELETE FROM lane_events WHERE lane_id LIKE '%/~group-%';
  DELETE FROM group_messages WHERE escalation_id IN (SELECT id FROM escalations WHERE lane_id LIKE '%/~group-%');
  DELETE FROM escalations WHERE lane_id LIKE '%/~group-%';
  DELETE FROM lanes WHERE id LIKE '%/~group-%';
  ALTER TABLE groups DROP COLUMN code_ref;
  ALTER TABLE groups DROP COLUMN status_line;
  UPDATE meta SET value = '25' WHERE key = 'schema_version';
`;
