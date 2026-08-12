PRAGMA foreign_keys = ON;

CREATE TABLE system_admins (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'support')),
  created_at INTEGER NOT NULL
);

-- Em instalacoes existentes, a conta inicial criada pelo bootstrap pertence ao
-- operador da plataforma e recebe a administracao principal.
INSERT INTO system_admins (user_id, role, created_at)
SELECT id, 'superadmin', CAST(strftime('%s', 'now') AS INTEGER)
  FROM users
 ORDER BY created_at ASC, id ASC
 LIMIT 1;
