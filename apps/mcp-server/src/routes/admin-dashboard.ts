// Self-contained admin dashboard HTML — served at GET /admin
// Auth is handled client-side: user enters ADMIN_SECRET, stored in sessionStorage.

export const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Engram Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0a0a; --surface: #141414; --border: #262626;
    --text: #e5e5e5; --muted: #737373; --accent: #3b82f6;
    --green: #22c55e; --red: #ef4444; --yellow: #eab308; --purple: #a855f7;
  }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  a { color: var(--accent); text-decoration: none; }

  /* Login */
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 2rem; width: 360px; }
  .login-box h1 { font-size: 1.25rem; margin-bottom: 1rem; }
  .login-box input { width: 100%; padding: .6rem .8rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: .9rem; margin-bottom: 1rem; }
  .login-box input:focus { outline: none; border-color: var(--accent); }
  .login-box .error { color: var(--red); font-size: .85rem; margin-bottom: .75rem; display: none; }

  /* Layout */
  .app { display: none; max-width: 1200px; margin: 0 auto; padding: 1.5rem; }
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .header h1 { font-size: 1.25rem; font-weight: 600; }
  .header-actions { display: flex; gap: .5rem; align-items: center; }
  .header-actions label { font-size: .8rem; color: var(--muted); display: flex; align-items: center; gap: .3rem; }

  /* Buttons */
  .btn { padding: .4rem .8rem; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; font-size: .8rem; transition: background .15s; }
  .btn:hover { background: var(--border); }
  .btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { color: var(--red); }
  .btn-danger:hover { background: rgba(239,68,68,.15); }
  .btn-sm { padding: .25rem .5rem; font-size: .75rem; }

  /* Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1.5rem; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .card .label { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: .25rem; }
  .card .value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card .value.green { color: var(--green); }
  .card .value.blue { color: var(--accent); }
  .card .value.purple { color: var(--purple); }

  /* Sections */
  .section { margin-bottom: 2rem; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: .75rem; }
  .section-header h2 { font-size: 1rem; font-weight: 600; }

  /* Tags */
  .tags { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: 1.5rem; }
  .tag { display: inline-flex; align-items: center; gap: .3rem; padding: .25rem .6rem; background: var(--surface); border: 1px solid var(--border); border-radius: 99px; font-size: .75rem; }
  .tag .count { font-weight: 700; }

  /* Tables */
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { background: var(--surface); font-weight: 600; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); cursor: pointer; user-select: none; }
  th:hover { color: var(--text); }
  th.active { color: var(--accent); }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }

  /* Tier select */
  .tier-select { padding: .2rem .4rem; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-size: .8rem; cursor: pointer; }
  .tier-select:focus { outline: none; border-color: var(--accent); }

  /* Tier badges */
  .tier-badge { display: inline-block; padding: .1rem .4rem; border-radius: 4px; font-size: .7rem; font-weight: 600; text-transform: uppercase; }
  .tier-free { background: rgba(115,115,115,.2); color: var(--muted); }
  .tier-pro { background: rgba(59,130,246,.15); color: var(--accent); }
  .tier-team { background: rgba(168,85,247,.15); color: var(--purple); }
  .tier-enterprise { background: rgba(234,179,8,.15); color: var(--yellow); }

  /* Pagination */
  .pagination { display: flex; align-items: center; justify-content: space-between; padding: .75rem; background: var(--surface); border-top: 1px solid var(--border); font-size: .8rem; color: var(--muted); }
  .pagination .page-info { font-variant-numeric: tabular-nums; }
  .pagination .page-btns { display: flex; gap: .4rem; }

  /* Audit */
  .audit-input { display: flex; gap: .5rem; margin-bottom: .75rem; }
  .audit-input input { flex: 1; padding: .4rem .6rem; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: .85rem; }
  .audit-input input:focus { outline: none; border-color: var(--accent); }

  /* Status */
  .status-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: .4rem 1rem; font-size: .75rem; color: var(--muted); background: var(--surface); border-top: 1px solid var(--border); text-align: center; transition: opacity .3s; }

  /* Responsive */
  @media (max-width: 640px) {
    .cards { grid-template-columns: repeat(2, 1fr); }
    .app { padding: 1rem; }
  }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login" class="login-wrap">
  <div class="login-box">
    <h1>Engram Admin</h1>
    <div id="login-error" class="error"></div>
    <input type="password" id="secret-input" placeholder="Admin secret" autofocus>
    <button class="btn btn-primary" style="width:100%" onclick="doLogin()">Sign in</button>
  </div>
</div>

<!-- Dashboard -->
<div id="app" class="app">
  <div class="header">
    <h1>Engram Admin</h1>
    <div class="header-actions">
      <label><input type="checkbox" id="auto-refresh"> Auto-refresh</label>
      <button class="btn" onclick="refresh()">Refresh</button>
      <button class="btn btn-danger" onclick="logout()">Logout</button>
    </div>
  </div>

  <!-- Metric Cards -->
  <div id="cards" class="cards"></div>

  <!-- Tier + Referral Breakdown -->
  <div class="section">
    <div class="section-header"><h2>Tiers</h2></div>
    <div id="tiers" class="tags"></div>
    <div class="section-header"><h2>Referral Sources</h2></div>
    <div id="referrals" class="tags"></div>
  </div>

  <!-- Today's Signups -->
  <div class="section">
    <div class="section-header"><h2>Today's Signups</h2></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Tier</th><th>Referral</th><th>Created</th></tr></thead>
        <tbody id="today-body"></tbody>
      </table>
    </div>
  </div>

  <!-- All Users -->
  <div class="section">
    <div class="section-header">
      <h2>All Users</h2>
      <span id="user-count" style="font-size:.8rem;color:var(--muted)"></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th data-sort="created_at" class="active">Created</th>
            <th>Name</th>
            <th data-sort="email">Email</th>
            <th>Tier</th>
            <th>Referral</th>
            <th>Stripe</th>
            <th data-sort="conversations">Convs</th>
            <th data-sort="total_messages">Msgs</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="users-body"></tbody>
      </table>
      <div class="pagination">
        <span class="page-info" id="page-info"></span>
        <div class="page-btns">
          <button class="btn btn-sm" id="prev-btn" onclick="prevPage()">Prev</button>
          <button class="btn btn-sm" id="next-btn" onclick="nextPage()">Next</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Audit Logs -->
  <div class="section">
    <div class="section-header"><h2>Audit Logs</h2></div>
    <div class="audit-input">
      <input type="text" id="audit-org-input" placeholder="Organization ID">
      <button class="btn" onclick="loadAudit()">Load</button>
    </div>
    <div class="table-wrap" id="audit-wrap" style="display:none">
      <table>
        <thead><tr><th>Action</th><th>Actor</th><th>Details</th><th>Time</th></tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
    </div>
  </div>
</div>

<div id="status-bar" class="status-bar" style="opacity:0"></div>

<script>
const BASE = location.origin;
let secret = '';
let sortField = 'created_at';
let sortOrder = 'desc';
let currentOffset = 0;
const PAGE_SIZE = 50;
let totalUsers = 0;
let refreshTimer = null;

function getHeaders() {
  return { 'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json' };
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + '/admin' + path, { headers: getHeaders(), ...opts });
  if (res.status === 401) { logout(); throw new Error('Unauthorized'); }
  return res.json();
}

function status(msg) {
  const bar = document.getElementById('status-bar');
  bar.textContent = msg;
  bar.style.opacity = '1';
  setTimeout(() => bar.style.opacity = '0', 2000);
}

function esc(s) {
  if (s == null) return '<span style="color:var(--muted)">-</span>';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function tierBadge(tier) {
  const t = tier || 'free';
  return '<span class="tier-badge tier-' + t + '">' + t + '</span>';
}

function shortTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
         d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function tierSelect(userId, currentTier) {
  const tiers = ['free', 'pro', 'team', 'enterprise'];
  let html = '<select class="tier-select" onchange="changeTier(\\'' + userId + '\\', this.value)">';
  for (const t of tiers) {
    html += '<option value="' + t + '"' + (t === (currentTier || 'free') ? ' selected' : '') + '>' + t + '</option>';
  }
  html += '</select>';
  return html;
}

// ---- Login ----
async function doLogin() {
  secret = document.getElementById('secret-input').value.trim();
  if (!secret) return;
  try {
    await api('/metrics');
    sessionStorage.setItem('engram_admin', secret);
    showApp();
    refresh();
  } catch {
    document.getElementById('login-error').textContent = 'Invalid secret';
    document.getElementById('login-error').style.display = 'block';
    secret = '';
  }
}

document.getElementById('secret-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

function logout() {
  secret = '';
  sessionStorage.removeItem('engram_admin');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('secret-input').value = '';
  document.getElementById('login-error').style.display = 'none';
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

function showApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
}

// ---- Metrics ----
async function loadMetrics() {
  const m = await api('/metrics');

  const cards = [
    { label: 'Total Users', value: m.signups.total, color: '' },
    { label: 'Last 24h', value: m.signups.last_1d, color: 'green' },
    { label: 'Last 7d', value: m.signups.last_7d, color: 'green' },
    { label: 'Last 30d', value: m.signups.last_30d, color: 'green' },
    { label: 'Active (30d)', value: m.active_users_30d, color: 'blue' },
    { label: 'Conversations', value: m.storage.conversations.toLocaleString(), color: '' },
    { label: 'Messages', value: m.storage.messages.toLocaleString(), color: '' },
    { label: 'Chunks', value: m.storage.chunks.toLocaleString(), color: '' },
    { label: 'API Keys', value: m.storage.api_keys, color: 'purple' },
  ];

  document.getElementById('cards').innerHTML = cards.map(c =>
    '<div class="card"><div class="label">' + c.label + '</div><div class="value ' + c.color + '">' + c.value + '</div></div>'
  ).join('');

  // Tiers
  document.getElementById('tiers').innerHTML = Object.entries(m.tiers).map(([t, n]) =>
    '<span class="tag">' + tierBadge(t) + ' <span class="count">' + n + '</span></span>'
  ).join('');

  // Referrals
  document.getElementById('referrals').innerHTML = Object.entries(m.referrals).map(([s, n]) =>
    '<span class="tag">' + esc(s) + ' <span class="count">' + n + '</span></span>'
  ).join('');

  // Today's signups
  document.getElementById('today-body').innerHTML = (m.today_signups || []).map(u =>
    '<tr><td>' + esc(u.name) + '</td><td>' + esc(u.email) + '</td><td>' + tierBadge(u.tier) +
    '</td><td>' + esc(u.referral_source) + '</td><td>' + shortTime(u.created_at) + '</td></tr>'
  ).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:1rem">No signups today</td></tr>';
}

// ---- Users ----
async function loadUsers() {
  const params = '?sort=' + sortField + '&order=' + sortOrder + '&limit=' + PAGE_SIZE + '&offset=' + currentOffset;
  const data = await api('/users' + params);
  totalUsers = data.total;

  document.getElementById('user-count').textContent = totalUsers + ' total';

  document.getElementById('users-body').innerHTML = data.users.map(u =>
    '<tr>' +
    '<td>' + shortTime(u.created_at) + '</td>' +
    '<td>' + esc(u.name) + '</td>' +
    '<td>' + esc(u.email) + '</td>' +
    '<td>' + tierSelect(u.id, u.tier) + '</td>' +
    '<td>' + esc(u.referral_source) + '</td>' +
    '<td>' + (u.stripe_customer_id ? '<span style="color:var(--green)" title="' + esc(u.stripe_customer_id) + '">Yes</span>' : '<span style="color:var(--muted)">-</span>') + '</td>' +
    '<td>' + u.conversations + '</td>' +
    '<td>' + u.total_messages + '</td>' +
    '<td><button class="btn btn-sm btn-danger" onclick="deleteUser(\\'' + u.id + '\\', \\'' + esc(u.name).replace(/'/g, "\\\\'") + '\\')">Del</button>' +
    ' <button class="btn btn-sm" onclick="loadAuditFor(\\'' + u.id + '\\')">Audit</button></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:1rem">No users</td></tr>';

  const page = Math.floor(currentOffset / PAGE_SIZE) + 1;
  const pages = Math.ceil(totalUsers / PAGE_SIZE);
  document.getElementById('page-info').textContent = 'Page ' + page + ' of ' + pages + ' (' + totalUsers + ' users)';
  document.getElementById('prev-btn').disabled = currentOffset === 0;
  document.getElementById('next-btn').disabled = currentOffset + PAGE_SIZE >= totalUsers;

  // Update sort header styling
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.toggle('active', th.dataset.sort === sortField);
    th.textContent = th.textContent.replace(/ [\\u25B2\\u25BC]$/, '');
    if (th.dataset.sort === sortField) {
      th.textContent += sortOrder === 'asc' ? ' \\u25B2' : ' \\u25BC';
    }
  });
}

// Sort
document.querySelectorAll('th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    if (sortField === th.dataset.sort) {
      sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    } else {
      sortField = th.dataset.sort;
      sortOrder = 'desc';
    }
    currentOffset = 0;
    loadUsers();
  });
});

function prevPage() { currentOffset = Math.max(0, currentOffset - PAGE_SIZE); loadUsers(); }
function nextPage() { if (currentOffset + PAGE_SIZE < totalUsers) { currentOffset += PAGE_SIZE; loadUsers(); } }

// ---- Actions ----
async function changeTier(userId, tier) {
  await api('/users/' + userId, { method: 'PATCH', body: JSON.stringify({ tier }) });
  status('Tier updated to ' + tier);
}

async function deleteUser(userId, name) {
  if (!confirm('Delete user "' + name + '"? This is a soft delete.')) return;
  await api('/users/' + userId, { method: 'DELETE' });
  status('User deleted');
  refresh();
}

// ---- Audit ----
async function loadAuditFor(orgId) {
  document.getElementById('audit-org-input').value = orgId;
  loadAudit();
  document.getElementById('audit-wrap').scrollIntoView({ behavior: 'smooth' });
}

async function loadAudit() {
  const orgId = document.getElementById('audit-org-input').value.trim();
  if (!orgId) return;
  const data = await api('/audit/' + orgId);
  document.getElementById('audit-wrap').style.display = 'block';
  document.getElementById('audit-body').innerHTML = (data.logs || []).map(l =>
    '<tr><td>' + esc(l.action) + '</td><td>' + esc(l.actor_id) + '</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">' +
    esc(typeof l.details === 'string' ? l.details : JSON.stringify(l.details)) +
    '</td><td>' + shortTime(l.created_at) + '</td></tr>'
  ).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:1rem">No audit logs</td></tr>';
}

// ---- Refresh ----
async function refresh() {
  status('Loading...');
  try {
    await Promise.all([loadMetrics(), loadUsers()]);
    status('Updated ' + new Date().toLocaleTimeString());
  } catch (e) {
    status('Error: ' + e.message);
  }
}

document.getElementById('auto-refresh').addEventListener('change', (e) => {
  if (e.target.checked) {
    refreshTimer = setInterval(refresh, 30000);
  } else {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

// ---- Init ----
const saved = sessionStorage.getItem('engram_admin');
if (saved) {
  secret = saved;
  api('/metrics').then(() => { showApp(); refresh(); }).catch(() => {
    sessionStorage.removeItem('engram_admin');
    secret = '';
  });
}
</script>
</body>
</html>`;
