/**
 * Echo Timesheet v1.0.0
 * AI-Powered Time Tracking — Toggl/Harvest Alternative
 * Cloudflare Worker — D1 + KV
 */

interface Env {
  DB: D1Database;
  TS_CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY: string;
}

interface RLState { c: number; t: number }
const WINDOW = 60_000, MAX_REQ = 120;

function sanitize(s: unknown, max = 2000): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max);
}
function authOk(req: Request, env: Env): boolean { return req.headers.get('X-Echo-API-Key') === env.ECHO_API_KEY; }
function json(data: unknown, status = 200): Response { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }); }
async function rateLimit(ip: string, kv: KVNamespace): Promise<boolean> {
  const key = `rl:${ip}`;
  const raw = await kv.get(key);
  const now = Date.now();
  let st: RLState = raw ? JSON.parse(raw) : { c: 0, t: now };
  const elapsed = now - st.t;
  const decayed = Math.max(0, st.c - (elapsed / WINDOW) * MAX_REQ);
  if (decayed + 1 > MAX_REQ) return false;
  st = { c: decayed + 1, t: now };
  await kv.put(key, JSON.stringify(st), { expirationTtl: 120 });
  return true;
}

function fmtHours(sec: number): number { return Math.round((sec / 3600) * 100) / 100; }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Echo-API-Key' } });
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || '0';
    if (!(await rateLimit(ip, env.TS_CACHE))) return json({ error: 'rate limited' }, 429);

    try {
      if (p === '/health') return json({ status: 'ok', service: 'echo-timesheet', version: '1.0.0', timestamp: new Date().toISOString() });
      if (!authOk(req, env)) return json({ error: 'unauthorized' }, 401);
      const db = env.DB;

      /* ═══ WORKSPACES ═══ */
      if (p === '/workspaces' && m === 'GET') { return json({ workspaces: (await db.prepare('SELECT * FROM workspaces ORDER BY name').all()).results }); }
      if (p === '/workspaces' && m === 'POST') {
        const b = await req.json() as any;
        const name = sanitize(b.name, 200);
        const slug = sanitize(b.slug || b.name, 100).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (!name) return json({ error: 'name required' }, 400);
        const r = await db.prepare('INSERT INTO workspaces (name,slug,currency,default_rate,week_start) VALUES (?,?,?,?,?)').bind(name, slug, sanitize(b.currency || 'USD', 10), b.default_rate || 0, sanitize(b.week_start || 'monday', 10)).run();
        return json({ id: r.meta.last_row_id, slug });
      }

      /* ═══ MEMBERS ═══ */
      if (p === '/members' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        if (!wsId) return json({ error: 'workspace_id required' }, 400);
        return json({ members: (await db.prepare('SELECT * FROM members WHERE workspace_id=? ORDER BY name').bind(wsId).all()).results });
      }
      if (p === '/members' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.name || !b.email) return json({ error: 'workspace_id, name, email required' }, 400);
        const r = await db.prepare('INSERT INTO members (workspace_id,name,email,role,hourly_rate,weekly_capacity) VALUES (?,?,?,?,?,?)').bind(b.workspace_id, sanitize(b.name, 100), sanitize(b.email, 200).toLowerCase(), sanitize(b.role || 'member', 20), b.hourly_rate || 0, b.weekly_capacity || 40).run();
        return json({ id: r.meta.last_row_id });
      }

      /* ═══ CLIENTS ═══ */
      if (p === '/clients' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        if (!wsId) return json({ error: 'workspace_id required' }, 400);
        return json({ clients: (await db.prepare('SELECT * FROM clients WHERE workspace_id=? ORDER BY name').bind(wsId).all()).results });
      }
      if (p === '/clients' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.name) return json({ error: 'workspace_id and name required' }, 400);
        const r = await db.prepare('INSERT INTO clients (workspace_id,name,email,currency,notes) VALUES (?,?,?,?,?)').bind(b.workspace_id, sanitize(b.name, 200), sanitize(b.email || '', 200), sanitize(b.currency || 'USD', 10), sanitize(b.notes || '', 2000)).run();
        return json({ id: r.meta.last_row_id });
      }

      /* ═══ PROJECTS ═══ */
      if (p === '/projects' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        const clientId = url.searchParams.get('client_id');
        let q = 'SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE 1=1';
        const params: any[] = [];
        if (wsId) { q += ' AND p.workspace_id=?'; params.push(wsId); }
        if (clientId) { q += ' AND p.client_id=?'; params.push(clientId); }
        q += ' ORDER BY p.name';
        return json({ projects: (await db.prepare(q).bind(...params).all()).results });
      }
      if (p === '/projects' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.name) return json({ error: 'workspace_id and name required' }, 400);
        const r = await db.prepare('INSERT INTO projects (workspace_id,client_id,name,code,color,budget_hours,budget_amount,hourly_rate,is_billable) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.workspace_id, b.client_id || null, sanitize(b.name, 200), sanitize(b.code || '', 20), sanitize(b.color || '#14b8a6', 10), b.budget_hours || null, b.budget_amount || null, b.hourly_rate || null, b.is_billable !== false ? 1 : 0).run();
        return json({ id: r.meta.last_row_id });
      }
      if (p.match(/^\/projects\/(\d+)$/) && m === 'GET') {
        const id = p.split('/')[2];
        const proj = await db.prepare('SELECT p.*, c.name as client_name FROM projects p LEFT JOIN clients c ON p.client_id=c.id WHERE p.id=?').bind(id).first();
        if (!proj) return json({ error: 'not found' }, 404);
        const tasks = await db.prepare('SELECT * FROM tasks WHERE project_id=? ORDER BY name').bind(id).all();
        const totalSec = await db.prepare('SELECT COALESCE(SUM(duration_sec),0) as total FROM time_entries WHERE project_id=?').bind(id).first() as any;
        const billableSec = await db.prepare('SELECT COALESCE(SUM(duration_sec),0) as total FROM time_entries WHERE project_id=? AND is_billable=1').bind(id).first() as any;
        return json({ ...proj, tasks: tasks.results, total_hours: fmtHours(totalSec.total), billable_hours: fmtHours(billableSec.total) });
      }
      if (p.match(/^\/projects\/(\d+)$/) && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['name', 'code', 'color', 'status'].includes(k)) { fields.push(`${k}=?`); vals.push(sanitize(String(v), 200)); }
          if (['client_id', 'budget_hours', 'budget_amount', 'hourly_rate', 'is_billable'].includes(k)) { fields.push(`${k}=?`); vals.push(v); }
        }
        if (fields.length === 0) return json({ error: 'no valid fields' }, 400);
        fields.push("updated_at=datetime('now')");
        vals.push(id);
        await db.prepare(`UPDATE projects SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        return json({ updated: true });
      }

      /* ═══ TASKS ═══ */
      if (p === '/tasks' && m === 'GET') {
        const projId = url.searchParams.get('project_id');
        if (!projId) return json({ error: 'project_id required' }, 400);
        return json({ tasks: (await db.prepare("SELECT * FROM tasks WHERE project_id=? AND status='active' ORDER BY name").bind(projId).all()).results });
      }
      if (p === '/tasks' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.project_id || !b.workspace_id || !b.name) return json({ error: 'project_id, workspace_id, name required' }, 400);
        const r = await db.prepare('INSERT INTO tasks (project_id,workspace_id,name,estimated_hours,is_billable) VALUES (?,?,?,?,?)').bind(b.project_id, b.workspace_id, sanitize(b.name, 200), b.estimated_hours || null, b.is_billable !== false ? 1 : 0).run();
        return json({ id: r.meta.last_row_id });
      }

      /* ═══ TIME ENTRIES ═══ */
      if (p === '/time' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        const memberId = url.searchParams.get('member_id');
        const projectId = url.searchParams.get('project_id');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        let q = 'SELECT te.*, p.name as project_name, p.color as project_color, t.name as task_name, m.name as member_name FROM time_entries te LEFT JOIN projects p ON te.project_id=p.id LEFT JOIN tasks t ON te.task_id=t.id LEFT JOIN members m ON te.member_id=m.id WHERE 1=1';
        const params: any[] = [];
        if (wsId) { q += ' AND te.workspace_id=?'; params.push(wsId); }
        if (memberId) { q += ' AND te.member_id=?'; params.push(memberId); }
        if (projectId) { q += ' AND te.project_id=?'; params.push(projectId); }
        if (from) { q += ' AND te.date>=?'; params.push(from); }
        if (to) { q += ' AND te.date<=?'; params.push(to); }
        q += ' ORDER BY te.start_time DESC LIMIT 500';
        return json({ entries: (await db.prepare(q).bind(...params).all()).results });
      }
      // Create time entry (manual)
      if (p === '/time' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.member_id || !b.start_time) return json({ error: 'workspace_id, member_id, start_time required' }, 400);
        const start = new Date(b.start_time);
        const end = b.end_time ? new Date(b.end_time) : null;
        const durSec = end ? Math.round((end.getTime() - start.getTime()) / 1000) : 0;
        const date = b.date || start.toISOString().split('T')[0];
        const r = await db.prepare('INSERT INTO time_entries (workspace_id,member_id,project_id,task_id,description,start_time,end_time,duration_sec,is_billable,is_running,tags,date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(
          b.workspace_id, b.member_id, b.project_id || null, b.task_id || null,
          sanitize(b.description || '', 2000), b.start_time, b.end_time || null,
          b.duration_sec || durSec, b.is_billable !== false ? 1 : 0, end ? 0 : 1,
          b.tags ? JSON.stringify(b.tags) : '[]', date
        ).run();
        return json({ id: r.meta.last_row_id });
      }
      // Start timer
      if (p === '/time/start' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.member_id) return json({ error: 'workspace_id, member_id required' }, 400);
        // Stop any running timer for this member
        const running = await db.prepare('SELECT id, start_time FROM time_entries WHERE member_id=? AND is_running=1').bind(b.member_id).first() as any;
        if (running) {
          const dur = Math.round((Date.now() - new Date(running.start_time).getTime()) / 1000);
          await db.prepare("UPDATE time_entries SET is_running=0, end_time=datetime('now'), duration_sec=?, updated_at=datetime('now') WHERE id=?").bind(dur, running.id).run();
        }
        const now = new Date().toISOString();
        const date = now.split('T')[0];
        const r = await db.prepare('INSERT INTO time_entries (workspace_id,member_id,project_id,task_id,description,start_time,is_billable,is_running,date) VALUES (?,?,?,?,?,?,?,1,?)').bind(b.workspace_id, b.member_id, b.project_id || null, b.task_id || null, sanitize(b.description || '', 2000), now, b.is_billable !== false ? 1 : 0, date).run();
        return json({ id: r.meta.last_row_id, started: true });
      }
      // Stop timer
      if (p === '/time/stop' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.member_id) return json({ error: 'member_id required' }, 400);
        const running = await db.prepare('SELECT id, start_time FROM time_entries WHERE member_id=? AND is_running=1').bind(b.member_id).first() as any;
        if (!running) return json({ error: 'no running timer' }, 404);
        const dur = Math.round((Date.now() - new Date(running.start_time).getTime()) / 1000);
        await db.prepare("UPDATE time_entries SET is_running=0, end_time=datetime('now'), duration_sec=?, updated_at=datetime('now') WHERE id=?").bind(dur, running.id).run();
        return json({ stopped: true, duration_sec: dur, hours: fmtHours(dur) });
      }
      // Get running timer
      if (p === '/time/running' && m === 'GET') {
        const memberId = url.searchParams.get('member_id');
        if (!memberId) return json({ error: 'member_id required' }, 400);
        const running = await db.prepare('SELECT te.*, p.name as project_name FROM time_entries te LEFT JOIN projects p ON te.project_id=p.id WHERE te.member_id=? AND te.is_running=1').bind(memberId).first();
        return json({ running: running || null });
      }
      // Update time entry
      if (p.match(/^\/time\/(\d+)$/) && m === 'PUT') {
        const id = p.split('/')[2];
        const b = await req.json() as any;
        const fields: string[] = [];
        const vals: any[] = [];
        for (const [k, v] of Object.entries(b)) {
          if (['description', 'start_time', 'end_time', 'date'].includes(k)) { fields.push(`${k}=?`); vals.push(sanitize(String(v), 2000)); }
          if (['project_id', 'task_id', 'duration_sec', 'is_billable'].includes(k)) { fields.push(`${k}=?`); vals.push(v); }
          if (k === 'tags') { fields.push(`${k}=?`); vals.push(JSON.stringify(v)); }
        }
        if (fields.length === 0) return json({ error: 'no valid fields' }, 400);
        // Recalculate duration if start/end changed
        if (b.start_time && b.end_time && !b.duration_sec) {
          const dur = Math.round((new Date(b.end_time).getTime() - new Date(b.start_time).getTime()) / 1000);
          fields.push('duration_sec=?'); vals.push(dur);
        }
        fields.push("updated_at=datetime('now')");
        vals.push(id);
        await db.prepare(`UPDATE time_entries SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();
        return json({ updated: true });
      }
      if (p.match(/^\/time\/(\d+)$/) && m === 'DELETE') {
        await db.prepare('DELETE FROM time_entries WHERE id=?').bind(p.split('/')[2]).run();
        return json({ deleted: true });
      }

      /* ═══ TIMESHEETS ═══ */
      if (p === '/timesheets' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        const memberId = url.searchParams.get('member_id');
        const status = url.searchParams.get('status');
        let q = 'SELECT ts.*, m.name as member_name FROM timesheets ts JOIN members m ON ts.member_id=m.id WHERE 1=1';
        const params: any[] = [];
        if (wsId) { q += ' AND ts.workspace_id=?'; params.push(wsId); }
        if (memberId) { q += ' AND ts.member_id=?'; params.push(memberId); }
        if (status) { q += ' AND ts.status=?'; params.push(status); }
        q += ' ORDER BY ts.week_start DESC';
        return json({ timesheets: (await db.prepare(q).bind(...params).all()).results });
      }
      // Generate weekly timesheet
      if (p === '/timesheets/generate' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.member_id || !b.week_start) return json({ error: 'workspace_id, member_id, week_start required' }, 400);
        const weekEnd = new Date(new Date(b.week_start).getTime() + 6 * 86400000).toISOString().split('T')[0];
        const totals = await db.prepare('SELECT COALESCE(SUM(duration_sec),0) as total, COALESCE(SUM(CASE WHEN is_billable=1 THEN duration_sec ELSE 0 END),0) as billable FROM time_entries WHERE member_id=? AND date>=? AND date<=?').bind(b.member_id, b.week_start, weekEnd).first() as any;
        const r = await db.prepare('INSERT OR REPLACE INTO timesheets (workspace_id,member_id,week_start,week_end,total_hours,billable_hours,status) VALUES (?,?,?,?,?,?,?)').bind(b.workspace_id, b.member_id, b.week_start, weekEnd, fmtHours(totals.total), fmtHours(totals.billable), 'draft').run();
        return json({ id: r.meta.last_row_id, total_hours: fmtHours(totals.total), billable_hours: fmtHours(totals.billable) });
      }
      if (p.match(/^\/timesheets\/(\d+)\/submit$/) && m === 'POST') {
        await db.prepare("UPDATE timesheets SET status='submitted', submitted_at=datetime('now') WHERE id=?").bind(p.split('/')[2]).run();
        return json({ submitted: true });
      }
      if (p.match(/^\/timesheets\/(\d+)\/approve$/) && m === 'POST') {
        const b = await req.json() as any;
        await db.prepare("UPDATE timesheets SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?").bind(sanitize(b.approved_by || 'admin', 100), p.split('/')[2]).run();
        return json({ approved: true });
      }
      if (p.match(/^\/timesheets\/(\d+)\/reject$/) && m === 'POST') {
        const b = await req.json() as any;
        await db.prepare("UPDATE timesheets SET status='rejected', rejected_reason=? WHERE id=?").bind(sanitize(b.reason || '', 2000), p.split('/')[2]).run();
        return json({ rejected: true });
      }

      /* ═══ INVOICES ═══ */
      if (p === '/invoices' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        if (!wsId) return json({ error: 'workspace_id required' }, 400);
        return json({ invoices: (await db.prepare('SELECT i.*, c.name as client_name FROM invoices i JOIN clients c ON i.client_id=c.id WHERE i.workspace_id=? ORDER BY i.created_at DESC').bind(wsId).all()).results });
      }
      // Generate invoice from billable time
      if (p === '/invoices/generate' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.client_id || !b.period_start || !b.period_end) return json({ error: 'workspace_id, client_id, period_start, period_end required' }, 400);
        const entries = await db.prepare('SELECT te.duration_sec, COALESCE(p.hourly_rate, (SELECT default_rate FROM workspaces WHERE id=te.workspace_id)) as rate FROM time_entries te JOIN projects p ON te.project_id=p.id WHERE p.client_id=? AND te.is_billable=1 AND te.date>=? AND te.date<=?').bind(b.client_id, b.period_start, b.period_end).all();
        let totalSec = 0, totalAmount = 0;
        for (const e of entries.results as any[]) {
          totalSec += e.duration_sec;
          totalAmount += (e.duration_sec / 3600) * (e.rate || 0);
        }
        const invNum = `INV-${Date.now().toString(36).toUpperCase()}`;
        const r = await db.prepare('INSERT INTO invoices (workspace_id,client_id,invoice_number,period_start,period_end,total_hours,total_amount,currency,notes) VALUES (?,?,?,?,?,?,?,?,?)').bind(b.workspace_id, b.client_id, invNum, b.period_start, b.period_end, fmtHours(totalSec), Math.round(totalAmount * 100) / 100, sanitize(b.currency || 'USD', 10), sanitize(b.notes || '', 2000)).run();
        return json({ id: r.meta.last_row_id, invoice_number: invNum, total_hours: fmtHours(totalSec), total_amount: Math.round(totalAmount * 100) / 100 });
      }
      if (p.match(/^\/invoices\/(\d+)\/send$/) && m === 'POST') {
        await db.prepare("UPDATE invoices SET status='sent', sent_at=datetime('now') WHERE id=?").bind(p.split('/')[2]).run();
        return json({ sent: true });
      }
      if (p.match(/^\/invoices\/(\d+)\/paid$/) && m === 'POST') {
        await db.prepare("UPDATE invoices SET status='paid', paid_at=datetime('now') WHERE id=?").bind(p.split('/')[2]).run();
        return json({ paid: true });
      }

      /* ═══ REPORTS & ANALYTICS ═══ */
      if (p === '/reports/summary' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        if (!wsId) return json({ error: 'workspace_id required' }, 400);
        const dateFilter = from && to ? ' AND te.date>=? AND te.date<=?' : '';
        const params = from && to ? [wsId, from, to] : [wsId];

        const [byProject, byMember, byDay, totals] = await Promise.all([
          db.prepare(`SELECT p.name, p.color, COALESCE(SUM(te.duration_sec),0) as total_sec, COALESCE(SUM(CASE WHEN te.is_billable=1 THEN te.duration_sec ELSE 0 END),0) as billable_sec FROM time_entries te JOIN projects p ON te.project_id=p.id WHERE te.workspace_id=?${dateFilter} GROUP BY te.project_id ORDER BY total_sec DESC`).bind(...params).all(),
          db.prepare(`SELECT m.name, COALESCE(SUM(te.duration_sec),0) as total_sec, COALESCE(SUM(CASE WHEN te.is_billable=1 THEN te.duration_sec ELSE 0 END),0) as billable_sec FROM time_entries te JOIN members m ON te.member_id=m.id WHERE te.workspace_id=?${dateFilter} GROUP BY te.member_id ORDER BY total_sec DESC`).bind(...params).all(),
          db.prepare(`SELECT te.date, COALESCE(SUM(te.duration_sec),0) as total_sec FROM time_entries te WHERE te.workspace_id=?${dateFilter} GROUP BY te.date ORDER BY te.date`).bind(...params).all(),
          db.prepare(`SELECT COALESCE(SUM(duration_sec),0) as total, COALESCE(SUM(CASE WHEN is_billable=1 THEN duration_sec ELSE 0 END),0) as billable FROM time_entries WHERE workspace_id=?${dateFilter}`).bind(...params).first() as any,
        ]);

        return json({
          total_hours: fmtHours(totals.total),
          billable_hours: fmtHours(totals.billable),
          billable_percentage: totals.total > 0 ? Math.round((totals.billable / totals.total) * 100) : 0,
          by_project: (byProject.results as any[]).map(r => ({ ...r, hours: fmtHours(r.total_sec), billable_hours: fmtHours(r.billable_sec) })),
          by_member: (byMember.results as any[]).map(r => ({ ...r, hours: fmtHours(r.total_sec), billable_hours: fmtHours(r.billable_sec) })),
          by_day: (byDay.results as any[]).map(r => ({ date: r.date, hours: fmtHours(r.total_sec as number) })),
        });
      }

      // Project budget tracking
      if (p.match(/^\/reports\/budget\/(\d+)$/) && m === 'GET') {
        const projId = p.split('/')[3];
        const proj = await db.prepare('SELECT * FROM projects WHERE id=?').bind(projId).first() as any;
        if (!proj) return json({ error: 'not found' }, 404);
        const totalSec = await db.prepare('SELECT COALESCE(SUM(duration_sec),0) as total FROM time_entries WHERE project_id=?').bind(projId).first() as any;
        const usedHours = fmtHours(totalSec.total);
        const budgetHours = proj.budget_hours || 0;
        const rate = proj.hourly_rate || 0;
        return json({
          project: proj.name,
          budget_hours: budgetHours,
          used_hours: usedHours,
          remaining_hours: Math.max(0, budgetHours - usedHours),
          utilization: budgetHours > 0 ? Math.round((usedHours / budgetHours) * 100) : 0,
          budget_amount: proj.budget_amount || 0,
          spent_amount: Math.round(usedHours * rate * 100) / 100,
        });
      }

      /* ═══ AI ═══ */
      if (p === '/ai/productivity' && m === 'POST') {
        const b = await req.json() as any;
        if (!b.workspace_id || !b.member_id) return json({ error: 'workspace_id, member_id required' }, 400);
        const entries = await db.prepare("SELECT te.*, p.name as project_name FROM time_entries te LEFT JOIN projects p ON te.project_id=p.id WHERE te.member_id=? AND te.date >= date('now', '-30 days') ORDER BY te.date").bind(b.member_id).all();
        const member = await db.prepare('SELECT * FROM members WHERE id=?').bind(b.member_id).first() as any;
        let insights = 'AI insights unavailable';
        try {
          const prompt = `Analyze this time tracking data for ${member?.name || 'team member'} (weekly capacity: ${member?.weekly_capacity || 40}h). Last 30 days: ${entries.results.length} entries. Provide 3 productivity insights and 2 improvement suggestions. Data: ${JSON.stringify((entries.results as any[]).slice(0, 50).map(e => ({ project: e.project_name, hours: fmtHours(e.duration_sec), date: e.date, billable: e.is_billable })))}`;
          const aiResp = await env.ENGINE_RUNTIME.fetch('https://engine/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine_id: 'hr-advisor', query: prompt }) });
          if (aiResp.ok) { const data = await aiResp.json() as any; insights = data.response || data.answer || insights; }
        } catch {}
        return json({ insights });
      }

      /* ═══ EXPORT ═══ */
      if (p === '/export' && m === 'GET') {
        const wsId = url.searchParams.get('workspace_id');
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const format = url.searchParams.get('format') || 'json';
        if (!wsId) return json({ error: 'workspace_id required' }, 400);
        let q = 'SELECT te.*, p.name as project_name, t.name as task_name, m.name as member_name FROM time_entries te LEFT JOIN projects p ON te.project_id=p.id LEFT JOIN tasks t ON te.task_id=t.id JOIN members m ON te.member_id=m.id WHERE te.workspace_id=?';
        const params: any[] = [wsId];
        if (from) { q += ' AND te.date>=?'; params.push(from); }
        if (to) { q += ' AND te.date<=?'; params.push(to); }
        q += ' ORDER BY te.date, te.start_time';
        const entries = await db.prepare(q).bind(...params).all();
        if (format === 'csv') {
          let csv = 'Date,Member,Project,Task,Description,Start,End,Hours,Billable\n';
          for (const e of entries.results as any[]) {
            csv += `"${e.date}","${e.member_name}","${e.project_name || ''}","${e.task_name || ''}","${(e.description || '').replace(/"/g, '""')}","${e.start_time}","${e.end_time || ''}",${fmtHours(e.duration_sec)},${e.is_billable ? 'Yes' : 'No'}\n`;
          }
          return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="timesheet.csv"', 'Access-Control-Allow-Origin': '*' } });
        }
        return json({ entries: entries.results, exported_at: new Date().toISOString() });
      }

      /* ═══ STATS ═══ */
      if (p === '/stats' && m === 'GET') {
        const [ws, mem, proj, entries] = await Promise.all([
          db.prepare('SELECT COUNT(*) as cnt FROM workspaces').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM members').first() as any,
          db.prepare('SELECT COUNT(*) as cnt FROM projects').first() as any,
          db.prepare('SELECT COUNT(*) as cnt, COALESCE(SUM(duration_sec),0) as total_sec FROM time_entries').first() as any,
        ]);
        return json({ workspaces: ws?.cnt || 0, members: mem?.cnt || 0, projects: proj?.cnt || 0, time_entries: entries?.cnt || 0, total_hours: fmtHours(entries?.total_sec || 0) });
      }

      return json({ error: 'not found' }, 404);
    } catch (e: any) {
      return json({ error: e.message || 'internal error' }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const db = env.DB;
    const workspaces = await db.prepare("SELECT id FROM workspaces WHERE status='active'").all();
    const today = new Date().toISOString().split('T')[0];
    for (const ws of workspaces.results as any[]) {
      const stats = await db.prepare("SELECT COALESCE(SUM(duration_sec),0) as total, COALESCE(SUM(CASE WHEN is_billable=1 THEN duration_sec ELSE 0 END),0) as billable, COUNT(DISTINCT member_id) as members, COUNT(DISTINCT project_id) as projects FROM time_entries WHERE workspace_id=? AND date >= date('now','-7 days')").bind(ws.id).first() as any;
      await db.prepare('INSERT OR REPLACE INTO analytics_daily (workspace_id,date,total_hours,billable_hours,members_active,projects_active) VALUES (?,?,?,?,?,?)').bind(ws.id, today, fmtHours(stats.total), fmtHours(stats.billable), stats.members, stats.projects).run();
    }
  },
};
