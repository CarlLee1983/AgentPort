-- Preserve the opaque native callback relation used for trusted answer
-- delivery. Existing rows remain readable but cannot be delivered or
-- acknowledged without both native identifiers.
ALTER TABLE questions ADD COLUMN native_tool_use_id TEXT;
ALTER TABLE questions ADD COLUMN native_request_id TEXT;
