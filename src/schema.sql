-- Echo Timesheet v1.0.0 — AI-Powered Time Tracking
-- D1 Schema

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  currency TEXT DEFAULT 'USD',
  default_rate REAL DEFAULT 0,
  week_start TEXT DEFAULT 'monday',
  settings JSON DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  hourly_rate REAL DEFAULT 0,
  weekly_capacity REAL DEFAULT 40,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, email)
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER,
  name TEXT NOT NULL,
  code TEXT,
  color TEXT DEFAULT '#14b8a6',
  budget_hours REAL,
  budget_amount REAL,
  hourly_rate REAL,
  is_billable INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  estimated_hours REAL,
  is_billable INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  project_id INTEGER,
  task_id INTEGER,
  description TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_sec INTEGER DEFAULT 0,
  is_billable INTEGER DEFAULT 1,
  is_running INTEGER DEFAULT 0,
  tags JSON DEFAULT '[]',
  date TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_member ON time_entries(member_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_project ON time_entries(project_id, date);
CREATE INDEX IF NOT EXISTS idx_entries_workspace ON time_entries(workspace_id, date);

CREATE TABLE IF NOT EXISTS timesheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  total_hours REAL DEFAULT 0,
  billable_hours REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',
  submitted_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  rejected_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, member_id, week_start)
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  client_id INTEGER NOT NULL,
  invoice_number TEXT,
  period_start TEXT,
  period_end TEXT,
  total_hours REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  notes TEXT,
  status TEXT DEFAULT 'draft',
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  total_hours REAL DEFAULT 0,
  billable_hours REAL DEFAULT 0,
  members_active INTEGER DEFAULT 0,
  projects_active INTEGER DEFAULT 0,
  UNIQUE(workspace_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
