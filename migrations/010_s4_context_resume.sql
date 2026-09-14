CREATE TABLE context_blockers (
  context_id TEXT PRIMARY KEY REFERENCES contexts(context_id),
  predecessor_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  state TEXT NOT NULL CHECK(state IN ('failed','canceled','interrupted','recovering')),
  created_at TEXT NOT NULL
);
CREATE INDEX context_blockers_predecessor ON context_blockers(predecessor_task_id);
CREATE TABLE context_continuations (
  context_id TEXT PRIMARY KEY REFERENCES contexts(context_id),
  mode TEXT NOT NULL CHECK(mode IN ('preserve','fresh_session')),
  context_summary TEXT,
  native_continuity TEXT NOT NULL CHECK(native_continuity IN ('preserved','abandoned')),
  updated_at TEXT NOT NULL,
  CHECK((mode='preserve' AND context_summary IS NULL AND native_continuity='preserved') OR (mode='fresh_session' AND context_summary IS NOT NULL AND native_continuity='abandoned'))
);
