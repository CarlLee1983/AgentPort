-- S4 makes Context follow-up ordering durable without changing prior Task rows.
-- The predecessor edge is written only at admission time.
ALTER TABLE tasks ADD COLUMN predecessor_task_id TEXT REFERENCES tasks(task_id);
CREATE INDEX tasks_context_predecessor ON tasks(context_id, predecessor_task_id);
CREATE INDEX tasks_predecessor_state_queue ON tasks(predecessor_task_id, state, queue_order);
