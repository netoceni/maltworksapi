CREATE TABLE notification_dismissals (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX idx_notification_dismissals_user
  ON notification_dismissals(user_id, dismissed_at DESC);
