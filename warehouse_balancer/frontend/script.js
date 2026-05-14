// ─── CONFIG ──────────────────────────────────────────────────────────────────
// backend runs on port 5050 in this workspace
const socket   = io('http://127.0.0.1:5050');
const API_BASE = 'http://127.0.0.1:5050/api';

let currentUser       = null;
let systemState       = null;
let activeTab         = 'dashboard';
let activeZoneFilter  = 'all';
let orderQueueTimer   = null;
let healthTimer       = null;
let analyticsTimer    = null;
let shiftTimerInterval= null;
let shiftStartTime    = null;
let prevWorkerLevels  = {};
let alertedHighFatigue= new Set();
let canvasRunning     = false;
let animW             = {};

const ZONES = {
  'Sector 1':  {x:55, y:50},
  'Sector 2':  {x:195,y:50},
  'Sector 3':  {x:55, y:150},
  'Sector 4':  {x:195,y:150},
  'Break Room':{x:125,y:100},
};

// ─── VIEW MANAGEMENT ─────────────────────────────────────────────────────────
function switchView() {
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('adminView').classList.add('hidden');
  document.getElementById('employeeView').classList.add('hidden');

  if (!currentUser) {
    document.getElementById('loginView').classList.remove('hidden');
  } else if (currentUser.role === 'admin') {
    document.getElementById('adminView').classList.remove('hidden');
    if (!canvasRunning) { canvasRunning = true; requestAnimationFrame(drawFloorplan); }
    startHealthPoll();
    startAnalyticsPoll();
    // initialize admin panels immediately
    try { showAdminTab(activeTab || 'dashboard'); } catch(e) { console.warn('init admin tabs', e); }
    // wire quick actions
    try { initAdminQuickActions(); } catch(e) { /* ignore */ }
  } else {
    document.getElementById('employeeView').classList.remove('hidden');
    startShiftTimer();
    if (systemState) renderEmployeeDashboard();
    else loadEmployeeOrders();
  }
}

function initAdminQuickActions(){
  const addBtn = document.getElementById('addOrderBtn'); if (addBtn) addBtn.onclick = openOrderModal;
  const bulkBtn = document.getElementById('bulkOrderBtn'); if (bulkBtn) bulkBtn.onclick = openBulkModal;
  const addEmpBtn = document.querySelector('button[onclick="openAddModal()"]'); if (addEmpBtn) addEmpBtn.onclick = openAddModal;
}

function logout() {
  currentUser = null; systemState = null;
  alertedHighFatigue.clear(); prevWorkerLevels = {};
  clearInterval(orderQueueTimer); orderQueueTimer = null;
  clearInterval(healthTimer);     healthTimer     = null;
  clearInterval(analyticsTimer);  analyticsTimer  = null;
  clearInterval(shiftTimerInterval); shiftTimerInterval = null;
  document.getElementById('usernameInput').value = '';
  document.getElementById('passwordInput').value = '';
  switchView();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  btn.innerHTML = `<div class="loader" style="margin:0 auto"></div>`;
  err.classList.add('hidden');
  try {
    const res  = await fetch(`${API_BASE}/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        username: document.getElementById('usernameInput').value.trim(),
        password: document.getElementById('passwordInput').value,
      })
    });
    const data = await res.json();
    if (data.success) {
      currentUser    = data.user;
      shiftStartTime = Date.now();
      const st       = await fetch(`${API_BASE}/status`);
      systemState    = await st.json();
      if (systemState?.workers) systemState.workers.forEach(w => { prevWorkerLevels[w.id] = w.level; });
      switchView();
    } else {
      err.classList.remove('hidden');
    }
  } catch {
    err.textContent = 'Server offline — please start the backend.';
    err.classList.remove('hidden');
  }
  btn.textContent = 'Sign In';
});

// ─── SOCKET ───────────────────────────────────────────────────────────────────
socket.on('state_update', (data) => {
  systemState = data;
  if (!currentUser) return;
  if (currentUser.role === 'admin') {
    updateAdminDashboard(data);
    if (activeTab === 'leaderboard') renderLeaderboard(data.workers);
    if (activeTab === 'employees')   renderStaffTable(data.workers);
    if (activeTab === 'analytics')   renderAnalytics(data);
    checkFatigueAlerts(data.workers);
    checkLevelUps(data.workers);
  } else {
    renderEmployeeDashboard();
  }
});
socket.on('connect',    () => console.log('Socket connected'));
socket.on('disconnect', () => console.warn('Socket disconnected'));

// ─── ADMIN TABS ───────────────────────────────────────────────────────────────
const TABS = ['dashboard','orders','analytics','leaderboard','worklogs','employees'];

function showAdminTab(tab) {
  TABS.forEach(t => {
    const panel = document.getElementById(`panel-${t}`);
    const btn   = document.getElementById(`tab-${t}`);
    if (panel) panel.classList.remove('active');
    if (btn)   btn.classList.remove('active');
  });
  const activePanel = document.getElementById(`panel-${tab}`);
  const activeBtn   = document.getElementById(`tab-${tab}`);
  if (activePanel) activePanel.classList.add('active');
  if (activeBtn)   activeBtn.classList.add('active');
  activeTab = tab;

  if (tab === 'worklogs')  refreshWorkLogs();
  if (tab === 'orders')    { refreshOrderQueue(); startOrderQueuePoll(); }
  else                     { stopOrderQueuePoll(); }
  if (tab === 'leaderboard' && systemState) renderLeaderboard(systemState.workers);
  if (tab === 'employees'   && systemState) renderStaffTable(systemState.workers);
  if (tab === 'analytics'   && systemState) renderAnalytics(systemState);
}

function startOrderQueuePoll() { stopOrderQueuePoll(); orderQueueTimer = setInterval(refreshOrderQueue, 3000); }
function stopOrderQueuePoll()  { clearInterval(orderQueueTimer); orderQueueTimer = null; }

// ─── HEALTH POLL ──────────────────────────────────────────────────────────────
function startHealthPoll() {
  clearInterval(healthTimer); fetchSystemHealth();
  healthTimer = setInterval(fetchSystemHealth, 10000);
}
async function fetchSystemHealth() {
  try {
    const d = await (await fetch(`${API_BASE}/admin/system/health`)).json();
    const s = d.uptime_seconds || 0;
    const el = document.getElementById('sysUptime');
    if (el) el.textContent = `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    const mem = document.getElementById('sysMemory');
    if (mem) mem.textContent = d.memory_mb ? `${d.memory_mb} MB` : '—';
  } catch {}
}

// ─── ANALYTICS POLL ───────────────────────────────────────────────────────────
function startAnalyticsPoll() {
  clearInterval(analyticsTimer); fetchAnalyticsSummary();
  analyticsTimer = setInterval(fetchAnalyticsSummary, 5000);
}
async function fetchAnalyticsSummary() {
  try {
    const d = await (await fetch(`${API_BASE}/admin/analytics/summary`)).json();
    const t60 = document.getElementById('throughput60s'); if (t60) t60.textContent = d.throughput_60s ?? 0;
    const anTh = document.getElementById('an-throughput-hr'); if (anTh) anTh.textContent = d.throughput_hr ?? '—';
    const anAv = document.getElementById('an-avg-time'); if (anAv) anAv.textContent = `${d.avg_completion_s ?? '—'}s`;
    const an60 = document.getElementById('an-throughput-60'); if (an60) an60.textContent = d.throughput_60s ?? '—';
    // Ensure timeline chart exists before updating
    initTimelineChart();
    if (d.throughput_60s !== undefined) updateTimelineChart(d.throughput_60s);

    // Merge analytics worker_efficiency with live worker state (fatigue, qa, level)
    let mergedWorkers = [];
    try {
      const live = (systemState && systemState.workers) ? systemState.workers : [];
      const ai = d.worker_efficiency || [];
      // map ai by id for quick lookup
      const aiById = {};
      ai.forEach(a => { if (a && a.id !== undefined) aiById[a.id] = a; });
      mergedWorkers = live.map(w => {
        const a = aiById[w.id] || {};
        const merged = Object.assign({}, w, {
          efficiency: a.efficiency !== undefined ? a.efficiency : (w.shift_efficiency || 0),
          tasks_completed: a.tasks_completed !== undefined ? a.tasks_completed : (w.tasks_completed || 0)
        });
        // normalize fatigue value so all views display the same percentage
        merged.fatigue = normFatigue(merged.fatigue);
        return merged;
      });
    } catch (err) { mergedWorkers = systemState?.workers || []; }

    // Sync normalized fatigue back into systemState so dashboard/staff use same values
    if (systemState && Array.isArray(systemState.workers)) {
      systemState.workers = systemState.workers.map(w => {
        const m = mergedWorkers.find(x => x.id === w.id);
        return m ? Object.assign({}, w, { fatigue: m.fatigue }) : w;
      });
    }

    // Provide data to renderAnalytics so it can update charts including heatmap
    renderAnalytics({ ml_stats: systemState?.ml_stats || {}, workers: mergedWorkers });
  } catch {}
}

// ─── CHARTS ───────────────────────────────────────────────────────────────────
const ctx  = document.getElementById('analyticsChart').getContext('2d');
const grad = ctx.createLinearGradient(0,0,0,180);
grad.addColorStop(0,'rgba(124,58,237,.35)'); grad.addColorStop(1,'rgba(124,58,237,0)');
const analyticsChart = new Chart(ctx, {
  type:'line',
  data:{ labels:Array(40).fill(''), datasets:[{ label:'Load %', data:Array(40).fill(0),
    borderColor:'#7c3aed', backgroundColor:grad, tension:.4, fill:true, borderWidth:2, pointRadius:0 }] },
  options:{ responsive:true, maintainAspectRatio:false, animation:{duration:0},
    scales:{
      y:{ beginAtZero:true, max:100, grid:{color:'rgba(255,255,255,.04)'}, ticks:{color:'#475569',font:{size:10}} },
      x:{ grid:{display:false}, ticks:{display:false} }
    }, plugins:{legend:{display:false}} }
});

let timelineChart = null;
function initTimelineChart() {
  const el = document.getElementById('timelineChart');
  if (!el || timelineChart) return;
  const g2 = el.getContext('2d').createLinearGradient(0,0,0,140);
  g2.addColorStop(0,'rgba(6,182,212,.3)'); g2.addColorStop(1,'rgba(6,182,212,0)');
  timelineChart = new Chart(el, {
    type:'line',
    data:{ labels:Array(30).fill(''), datasets:[{ label:'Orders/60s', data:Array(30).fill(0),
      borderColor:'#06b6d4', backgroundColor:g2, tension:.4, fill:true, borderWidth:2, pointRadius:0 }] },
    options:{ responsive:true, maintainAspectRatio:false, animation:{duration:300},
      scales:{
        y:{ beginAtZero:true, grid:{color:'rgba(255,255,255,.05)'}, ticks:{color:'#475569',font:{size:10}} },
        x:{ grid:{display:false}, ticks:{display:false} }
      }, plugins:{legend:{display:false}} }
  });
}
function updateTimelineChart(v) {
  if (!timelineChart) return;
  timelineChart.data.datasets[0].data.shift();
  timelineChart.data.datasets[0].data.push(v);
  timelineChart.update();
}

function loadColor(p) { return p < 50 ? '#7c3aed' : (p < 80 ? '#f59e0b' : '#f43f5e'); }

// Normalize fatigue values to a 0-100 percentage for consistent display across views.
function normFatigue(raw) {
  let v = Number(raw || 0);
  if (isNaN(v)) v = 0;
  // If values look like 0..5 (small), assume they are fractions and scale to 0-100
  if (v > 0 && v <= 5) {
    // map roughly 0-5 to 0-100
    v = Math.min(100, v * 20);
  }
  // clamp
  v = Math.max(0, Math.min(100, v));
  return Math.round(v);
}

// format hours float into HhrMmin (e.g., 11hr20min)
function formatHoursMinutes(hoursFloat) {
  const totalMinutes = Math.round((Number(hoursFloat) || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}hr${m}min`;
}

// ─── ADMIN DASHBOARD ──────────────────────────────────────────────────────────
function updateAdminDashboard(data) {
  if (!currentUser || currentUser.role !== 'admin') return;
  const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  setEl('totalOrders', data.total_orders_completed);
  setEl('kpi-completed', data.total_orders_completed);
  setEl('unassignedOrders', data.unassigned_orders);
  setEl('aiForecast', data.ai_forecast);

  const sl = document.getElementById('systemLoad');
  if (sl) { sl.textContent = data.system_load_percentage + '%'; sl.style.color = loadColor(data.system_load_percentage); }

  if (data.workers) {
    const q = data.workers.reduce((s,w) => s + (w.workload||0), 0);
    setEl('queueSize', q);
  }
  if (data.ml_stats) {
    setEl('mlConfidence', data.ml_stats.confidence);
    setEl('mlWeightInfo', `wl=${data.ml_stats.w_workload}  ft=${data.ml_stats.w_fatigue}  b=${data.ml_stats.bias}`);
  }

  try {
    analyticsChart.data.datasets[0].data.shift();
    analyticsChart.data.datasets[0].data.push(data.system_load_percentage);
    analyticsChart.update();
  } catch {}

  if (activeTab === 'dashboard') {
    try { renderAdminWorkers(data.workers); } catch {}
    try { renderAdminLogs(data.logs); } catch {}
    try { parseWorkersIntoAnimation(data.workers); } catch {}
  }
}

// ─── WORKER CARDS ─────────────────────────────────────────────────────────────
function dotColor(status) {
  if (status === 'active')     return '#10b981';
  if (status === 'overloaded') return '#f43f5e';
  if (status === 'break')      return '#f59e0b';
  return '#475569';
}
function statusBadge(status) {
  const cls = { active:'badge-emerald', idle:'badge-slate', overloaded:'badge-rose', break:'badge-amber' };
  return `<span class="badge ${cls[status]||'badge-slate'}">${status}</span>`;
}

function renderAdminWorkers(workers) {
  const grid = document.getElementById('workersGrid');
  if (!grid) return;
  grid.innerHTML = workers.map(w => {
    const pct  = Math.min(100, Math.round((w.workload / w.max_capacity) * 100));
    const avG  = `linear-gradient(135deg,hsl(${w.avatar_hue},70%,55%),hsl(${(w.avatar_hue+40)%360},60%,40%))`;
    const hide = (activeZoneFilter !== 'all' && w.zone !== activeZoneFilter) ? ' hidden-by-filter' : '';
  const fatiguePct = normFatigue(w.fatigue);
  const fc   = fatiguePct > 75 ? '#f43f5e' : (fatiguePct > 50 ? '#f59e0b' : '#10b981');
    const eff  = (w.shift_efficiency || 0).toFixed(1);
  return `
    <div class="worker-card${w.status==='break'?' on-break':''}${hide}" data-zone="${w.zone}">
      <div class="wc-top">
        <div class="wc-avatar" style="background:${avG}">
          ${w.name[0]}
          <div class="online-dot" style="background:${dotColor(w.status)}"></div>
        </div>
        <div class="wc-info">
          <div class="wc-name">${w.name}</div>
          <div class="wc-role">${w.zone} · ${w.role||''}</div>
        </div>
        <div style="font-size:.7rem;font-weight:700;color:#a78bfa;text-align:right">${eff}×<br><span style="color:var(--txt3);font-weight:500">eff</span></div>
      </div>
      <div class="wc-meta">
        <span class="badge badge-violet">LVL ${w.level}</span>
        <span class="badge badge-cyan">QA ${w.qa_score}</span>
        <span class="badge badge-slate">${w.tasks_completed||0} done</span>
        ${statusBadge(w.status)}
      </div>
      <div style="padding:.5rem 0;display:flex;gap:1rem;color:var(--txt3);font-size:.85rem">
        <div>Today: <strong style="color:var(--txt)">${formatHoursMinutes(w.hours_today)}</strong></div>
        <div>Break: <strong style="color:var(--txt)">${w.break_time_total_minutes||0}min</strong></div>
      </div>
      <div class="prog-group">
        <div class="prog-label">
          <span>Queue</span>
          <span class="mono" style="color:${loadColor(pct)}">${w.workload}/${w.max_capacity}</span>
        </div>
        <div class="prog-track"><div class="prog-fill" style="width:${pct}%;background:${loadColor(pct)}"></div></div>
      </div>
      <div class="prog-group">
          <div class="prog-label">
          <span>Fatigue</span>
          <span class="mono" style="color:${fc}">${fatiguePct}%</span>
        </div>
        <div class="prog-track"><div class="prog-fill" style="width:${fatiguePct}%;background:${fc}"></div></div>
      </div>
    </div>`;
  }).join('');
}

// ─── TERMINAL LOGS ────────────────────────────────────────────────────────────
function renderAdminLogs(logs) {
  const el = document.getElementById('terminalLogs');
  if (!el || !logs) return;
  const c = { WARNING:'#f59e0b', ERROR:'#f43f5e', ROUTING:'#a78bfa', SYSTEM:'#94a3b8', INFO:'#6ee7b7' };
  el.innerHTML = logs.map(lg => `
    <div style="margin-bottom:.3rem">
      <span style="color:#475569">[${lg.time}]</span>
      <span style="color:${c[lg.type]||'#94a3b8'};font-weight:700"> [${lg.type}]</span>
      <span style="color:#94a3b8"> ${lg.message}</span>
    </div>`).join('');
}

// ─── ORDERS / WORKLOGS ───────────────────────────────────────────────────────
async function refreshOrderQueue() {
  try {
    const res = await fetch(`${API_BASE}/admin/orders`);
    const data = await res.json();
    const tbody = document.getElementById('orderQueueTable');
    const pendingEl = document.getElementById('oq-pending');
    const unassignedEl = document.getElementById('oq-unassigned');
    const highEl = document.getElementById('oq-high');
    if (!tbody) return;
    const orders = data.orders || [];
    if (pendingEl) pendingEl.textContent = orders.filter(o=>o.status==='pending').length;
    if (unassignedEl) unassignedEl.textContent = orders.filter(o=>o.status==='unassigned').length;
    if (highEl) highEl.textContent = orders.filter(o=>o.priority==='High').length;

    if (orders.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--txt3)">No orders</td></tr>';
      return;
    }
    tbody.innerHTML = orders.map(o => `
      <tr>
        <td>${o.id}</td>
        <td>${o.title||'—'}</td>
        <td>${o.priority||'—'}</td>
        <td>${o.status||'—'}</td>
        <td>${o.worker_name|| (o.assigned_worker_id||'—')}</td>
        <td>${o.zone||'—'}</td>
        <td>${formatTime(o.created_at)}</td>
        <td><button class="btn btn-ghost" onclick="reassignOrder(${o.id})">Reassign</button></td>
      </tr>`).join('');
  } catch (e) {
    console.warn('refreshOrderQueue', e);
  }
}

async function reassignOrder(orderId) {
  try {
    await postJSON(`${API_BASE}/admin/orders/${orderId}/reassign`, {});
    showToast('Order reassign requested', 'success');
  } catch { showToast('Failed to reassign', 'danger'); }
}

async function refreshWorkLogs() {
  try {
    const res = await fetch(`${API_BASE}/work_logs`);
    const d = await res.json();
    const rows = d.logs || [];
    const t = document.getElementById('workLogTable');
    if (!t) return;
    if (rows.length === 0) {
      t.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--txt3)">No logs</td></tr>';
      return;
    }
    t.innerHTML = rows.map(r => `
      <tr>
        <td>${formatTime(r.timestamp)}</td>
        <td>${r.employee_name}</td>
        <td>${r.action}</td>
        <td>${r.detail||''}</td>
      </tr>`).join('');
  } catch (e) { console.warn('refreshWorkLogs', e); }
}

// ─── LEADERBOARD & ANALYTICS ─────────────────────────────────────────────────
function renderLeaderboard(workers) {
  const el = document.getElementById('leaderboardTable');
  if (!el) return;
  if (!workers || workers.length === 0) { el.innerHTML = '<div style="padding:1rem;color:var(--txt3)">No data</div>'; return; }
  // sort by level then QA
  const sorted = workers.slice().sort((a,b) => (b.level - a.level) || (b.qa_score - a.qa_score));
  el.innerHTML = sorted.map((w,i) => `
      <div class="lb-card">
      <div style="display:flex;align-items:center;gap:1rem">
        <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,hsl(${w.avatar_hue||200},70%,55%),hsl(${(w.avatar_hue||200)+30},60%,40%));display:flex;align-items:center;justify-content:center;font-weight:800">${i+1}</div>
        <div>
          <div style="font-weight:800">${w.name}</div>
          <div style="font-size:.8rem;color:var(--txt3)">Lvl ${w.level} · QA ${w.qa_score} · ${w.tasks_completed||0} done</div>
        </div>
      </div>
    </div>`).join('');
}

function renderAnalytics(data) {
  // data may be full system state
  if (!data) return;
  initTimelineChart();
  // ML stats
  if (data.ml_stats) {
    const ml = data.ml_stats;
    const el = document.getElementById('an-ml');
    if (el) el.textContent = (ml.training_steps !== undefined && ml.training_steps !== null) ? ml.training_steps : '—';
  }

  // bar chart: tasks completed by worker
  try {
    const workers = data.workers || [];
    const labels = workers.map(w => w.name || `#${w.id}`);
    const vals = workers.map(w => w.tasks_completed || 0);

    // Bar chart
    const barCanvas = document.getElementById('barChart');
    if (barCanvas) {
      const ctx = barCanvas.getContext('2d');
      if (!window.barChart) {
        window.barChart = new Chart(ctx, {
          type: 'bar',
          data: { labels, datasets: [{ label: 'Tasks', data: vals, backgroundColor: '#7c3aed' }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
        });
      } else {
        window.barChart.data.labels = labels;
        window.barChart.data.datasets[0].data = vals;
        window.barChart.update();
      }
    }

    // doughnut: workforce stress distribution (buckets)
    const fat = workers.map(w => Math.round(w.fatigue || 0));
    // generate heatmap list
    const heatWrap = document.getElementById('fatigueRows');
    if (heatWrap) {
      heatWrap.innerHTML = workers.map(w => {
        const pct = Math.round(w.fatigue || 0);
        const col = pct > 75 ? '#f43f5e' : (pct > 50 ? '#f59e0b' : '#10b981');
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:.5rem .6rem;border-bottom:1px solid rgba(255,255,255,.03)">
          <div style="font-weight:700">${w.name}</div>
          <div style="display:flex;align-items:center;gap:.6rem">
            <div style="width:120px;height:8px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:${col}"></div>
            </div>
            <div style="font-weight:700;color:${col}">${pct}%</div>
          </div>
        </div>`;
      }).join('');
    }
    const doughCanvas = document.getElementById('doughnutChart');
    if (doughCanvas) {
      const ctx2 = doughCanvas.getContext('2d');
      const low = workers.filter(w => (w.fatigue||0) < 50).length;
      const med = workers.filter(w => (w.fatigue||0) >= 50 && (w.fatigue||0) < 75).length;
      const high = workers.filter(w => (w.fatigue||0) >= 75).length;
      const dlabels = ['Low (<50%)','Medium (50-74%)','High (75%+)'];
      const ddata = [low, med, high];
      const dcolors = ['#10b981','#f59e0b','#f43f5e'];
      if (!window.doughnutChart) {
        window.doughnutChart = new Chart(ctx2, {
          type: 'doughnut',
          data: { labels: dlabels, datasets: [{ data: ddata, backgroundColor: dcolors }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
        });
      } else {
        window.doughnutChart.data.labels = dlabels;
        window.doughnutChart.data.datasets[0].data = ddata;
        window.doughnutChart.data.datasets[0].backgroundColor = dcolors;
        window.doughnutChart.update();
      }
    }
  } catch (e) { console.warn('renderAnalytics', e); }
}

// ─── EMPLOYEE VIEW ──────────────────────────────────────────────────────────
async function renderEmployeeDashboard() {
  if (!currentUser) return;
  const id = currentUser.employee_id;
  if (!id) return;
  try {
    const res = await fetch(`${API_BASE}/employee/orders?employee_id=${id}`);
    const d = await res.json();
    const wrap = document.getElementById('employeeOrdersList');
    const nameEl = document.getElementById('empNameBanner');
    const statusPill = document.getElementById('statusIndicatorBanner');
    const qaDisplay = document.getElementById('qaDisplay');
    const qaBar = document.getElementById('qaBar');
    // use systemState to fill meta
    const me = (systemState && systemState.workers) ? systemState.workers.find(w=>w.id==id) : null;
    if (me) {
      if (nameEl) nameEl.textContent = me.name;
      if (statusPill) statusPill.textContent = `${me.status || 'idle'} — ${me.zone || ''}`;
      if (qaDisplay) qaDisplay.textContent = `${me.qa_score||0}/100`;
      if (qaBar) qaBar.style.width = `${Math.min(100,me.qa_score||0)}%`;
      const lvl = document.getElementById('empLevelBig'); if (lvl) lvl.textContent = me.level||1;
      const done = document.getElementById('empDoneBig'); if (done) done.textContent = me.tasks_completed||0;
      const eff = document.getElementById('empEfficiency'); if (eff) eff.textContent = (me.shift_efficiency||0).toFixed(2);
    }

    const orders = d.orders || [];
    if (!wrap) return;
    if (orders.length === 0) { wrap.innerHTML = '<div style="padding:1rem;color:var(--txt3)">No assigned tasks</div>'; return; }
    wrap.innerHTML = orders.map(o => `
      <div class="glass" style="padding:.8rem;display:flex;justify-content:space-between;align-items:center;margin-bottom:.6rem">
        <div>
          <div style="font-weight:700">${o.title||'Order #' + o.id}</div>
          <div style="font-size:.82rem;color:var(--txt3)">Priority: ${o.priority} · Zone: ${o.zone||'—'}</div>
        </div>
        <div style="display:flex;gap:.6rem;align-items:center">
          <button class="btn btn-emerald" onclick="completeOrder(${o.id})">Mark Complete</button>
        </div>
      </div>`).join('');
  } catch (e) { console.warn('renderEmployeeDashboard', e); }
}

async function completeOrder(orderId) {
  try {
    await postJSON(`${API_BASE}/employee/complete`, { order_id: orderId, ticks: 3 });
    showToast('Marked complete', 'success');
  } catch { showToast('Failed to mark complete', 'danger'); }
}

async function loadEmployeeOrders() { await renderEmployeeDashboard(); }

// ─── FLOORPLAN / ANIMATION ──────────────────────────────────────────────────
function parseWorkersIntoAnimation(workers) {
  animW = {};
  (workers||[]).forEach(w => {
    const pos = ZONES[w.zone] || ZONES['Break Room'];
    animW[w.id] = { x: pos.x + (Math.random()*20-10), y: pos.y + (Math.random()*20-10), name: w.name[0], hue: w.avatar_hue };
  });
}

function drawFloorplan() {
  const c = document.getElementById('warehouseFloorplan');
  if (!c) return; const ctx = c.getContext('2d');
  c.width = c.clientWidth; c.height = c.clientHeight;
  ctx.clearRect(0,0,c.width,c.height);
  // draw zones
  Object.keys(ZONES).forEach(k => {
    const z = ZONES[k]; ctx.fillStyle = 'rgba(255,255,255,0.02)'; ctx.fillRect(z.x-30,z.y-20,80,45);
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.font='10px Inter'; ctx.fillText(k, z.x-20, z.y-8);
  });
  // draw workers
  Object.values(animW).forEach(a => {
    ctx.beginPath(); ctx.fillStyle = `hsl(${a.hue||210} 70% 50%)`;
    ctx.arc(a.x, a.y, 8, 0, Math.PI*2); ctx.fill(); ctx.fillStyle='white'; ctx.font='10px Inter'; ctx.fillText(a.name, a.x-4, a.y+4);
  });
  requestAnimationFrame(drawFloorplan);
}

// ─── UTILITIES ──────────────────────────────────────────────────────────────
function formatTime(t) { if (!t) return '—'; const d = new Date(Math.round(t*1000)); return d.toLocaleString(); }

function startShiftTimer() {
  const el = document.getElementById('shiftTimer');
  if (!el) return;
  if (shiftTimerInterval) clearInterval(shiftTimerInterval);
  shiftTimerInterval = setInterval(()=>{
    if (!shiftStartTime) return; const diff = Date.now() - shiftStartTime; const s = Math.floor(diff/1000)%60; const m = Math.floor(diff/60000)%60; const h = Math.floor(diff/3600000);
    el.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

function checkFatigueAlerts(workers) {
  (workers||[]).forEach(w => {
    if ((w.fatigue||0) > 85 && !alertedHighFatigue.has(w.id)) { alertedHighFatigue.add(w.id); showToast(`${w.name} high fatigue: ${Math.round(w.fatigue)}%`, 'warn'); }
  });
}

function checkLevelUps(workers) {
  (workers||[]).forEach(w => {
    const prev = prevWorkerLevels[w.id] || 0;
    if (w.level > prev) { showToast(`${w.name} leveled up to ${w.level}!`, 'success'); }
    prevWorkerLevels[w.id] = w.level;
  });
}

// ─── ZONE FILTER ──────────────────────────────────────────────────────────────
function applyZoneFilter(zone) {
  activeZoneFilter = zone;
  document.querySelectorAll('.zone-pill').forEach(b => b.classList.remove('active'));
  const id = zone === 'all' ? 'zf-all' : `zf-s${zone.replace('Sector ','')}`;
  const b  = document.getElementById(id);
  if (b) b.classList.add('active');
  document.querySelectorAll('#workersGrid [data-zone]').forEach(card => {
    card.classList.toggle('hidden-by-filter', zone !== 'all' && card.dataset.zone !== zone);
  });
}

// -------------------------
// Admin: Staff table & actions
// -------------------------
function renderStaffTable(workers) {
  const el = document.getElementById('staffTable');
  if (!el) return;
  if (!workers || workers.length === 0) {
    el.innerHTML = '<div style="padding:1rem;color:var(--txt3)">No staff found.</div>';
    return;
  }

  el.innerHTML = workers.map(w => {
    const pct  = Math.min(100, Math.round((w.workload / (w.max_capacity||10)) * 100));
  const fatiguePct = normFatigue(w.fatigue);
  const fc   = fatiguePct > 75 ? '#f43f5e' : (fatiguePct > 50 ? '#f59e0b' : '#10b981');
    const status = (w.status||'idle');
    return `
      <div class="lb-card">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:1rem">
            <div style="width:44px;height:44px;border-radius:10px;background:linear-gradient(135deg,hsl(${w.avatar_hue||210},70%,55%),hsl(${(w.avatar_hue||210)+30},60%,40%));display:flex;align-items:center;justify-content:center;font-weight:800">${w.name[0]}</div>
            <div>
              <div style="font-weight:800">${w.name} <span style="color:var(--txt3);font-weight:600;font-size:.85rem">· ${w.role||''}</span></div>
              <div style="font-size:.8rem;color:var(--txt2)">${w.zone} · Level ${w.level} · QA ${w.qa_score}</div>
            </div>
          </div>
          <div style="display:flex;gap:1rem;margin-top:.6rem;align-items:center">
            <div style="font-size:.78rem;color:var(--txt3)">Queue: <strong style="color:var(--txt)">${w.workload}/${w.max_capacity}</strong></div>
            <div style="font-size:.78rem;color:var(--txt3)">Fatigue: <strong style="color:${fc}">${fatiguePct}%</strong></div>
      <div style="font-size:.78rem;color:var(--txt3)">Status: <strong style="color:var(--txt)">${status}</strong></div>
            <div style="font-size:.78rem;color:var(--txt3)">Today: <strong style="color:var(--txt)">${formatHoursMinutes(w.hours_today)}</strong> · Break: <strong style="color:var(--txt)">${w.break_time_total_minutes||0}min</strong></div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:.5rem;align-items:flex-end">
          ${status === 'break' ? `<button class="btn btn-emerald" onclick="adminEndBreak(${w.id})">Resume</button>` : `<button class="btn btn-amber" onclick="adminGrantBreak(${w.id})">Grant Break</button>`}
          <button class="btn btn-ghost" onclick="reassignWorkerTasks(${w.id})">Rescue Tasks</button>
          <button class="btn btn-rose" onclick="deleteEmployee(${w.id})">Remove</button>
        </div>
      </div>`;
  }).join('');
}

// Admin action helpers
async function adminGrantBreak(empId) {
  try {
    let minutes = prompt('Enter break minutes (e.g. 10):', '10');
    if (minutes === null) return;
    minutes = parseFloat(minutes) || 0;
    await postJSON(`${API_BASE}/admin/employees/${empId}/break`, { minutes });
    showToast('Break assigned', 'success');
  } catch (e) { showToast('Failed to assign break', 'danger'); }
}
async function adminEndBreak(empId) {
  try {
    await postJSON(`${API_BASE}/admin/employees/${empId}/resume`, {});
    showToast('Employee resumed', 'success');
  } catch (e) { showToast('Failed to resume', 'danger'); }
}
async function deleteEmployee(empId) {
  if (!confirm('Remove employee and reassign their tasks?')) return;
  try {
    await fetch(`${API_BASE}/admin/employees/${empId}`, { method: 'DELETE' });
    showToast('Employee removed', 'success');
  } catch { showToast('Failed to remove employee', 'danger'); }
}
async function reassignWorkerTasks(empId) {
  try {
    await postJSON(`${API_BASE}/admin/orders/bulk`, { count:0 });
  } catch {}
  try { showToast('Rescued tasks and redistributed', 'success'); } catch {}
}

// -------------------------
// Modal helpers & form handlers (orders, bulk, add employee)
// -------------------------
function openAddModal(){ document.getElementById('addModal').classList.remove('hidden'); }
function closeAddModal(){ document.getElementById('addModal').classList.add('hidden'); }
function openOrderModal(){ document.getElementById('orderModal').classList.remove('hidden'); }
function closeOrderModal(){ document.getElementById('orderModal').classList.add('hidden'); }
function openBulkModal(){ document.getElementById('bulkModal').classList.remove('hidden'); }
function closeBulkModal(){ document.getElementById('bulkModal').classList.add('hidden'); }

document.addEventListener('submit', async (e) => {
  if (e.target && e.target.id === 'addEmpForm') {
    e.preventDefault();
    const name = document.getElementById('newEmpName').value.trim();
    const role = document.getElementById('newEmpRole').value.trim();
    const zone = document.getElementById('newEmpZone').value;
    const equip= document.getElementById('newEmpEquip').value.trim();
    try {
      const res = await postJSON(`${API_BASE}/admin/employees`, { name, role, zone, equipment: equip });
      document.getElementById('addResult').classList.remove('hidden');
      document.getElementById('addResult').textContent = `Created: ${res.employee.username} / ${res.employee.password}`;
      setTimeout(()=>{ closeAddModal(); }, 900);
      showToast('Employee created', 'success');
    } catch (err) { showToast('Failed to create employee', 'danger'); }
  }
  if (e.target && e.target.id === 'orderForm') {
    e.preventDefault();
    const title = document.getElementById('orderTitle').value.trim();
    const priority = document.getElementById('orderPriority').value;
    const zone = document.getElementById('orderZone').value || null;
    try {
      await postJSON(`${API_BASE}/add_order`, { title, priority, zone });
      closeOrderModal(); showToast('Order dispatched', 'success');
    } catch { showToast('Failed to dispatch order', 'danger'); }
  }
  if (e.target && e.target.id === 'bulkForm') {
    e.preventDefault();
    const count = parseInt(document.getElementById('bulkCount').value,10)||5;
    const priority = document.getElementById('bulkPriority').value;
    try {
      await postJSON(`${API_BASE}/admin/orders/bulk`, { count, priority });
      closeBulkModal(); showToast('Bulk injection queued', 'success');
    } catch { showToast('Failed to inject bulk orders', 'danger'); }
  }
});

// small helper to POST JSON
async function postJSON(url, body) {
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) });
  if (!res.ok) throw new Error('Request failed');
  return res.json();
}

function showToast(msg, type='info'){
  const c = document.getElementById('toastContainer');
  if (!c) return;
  const div = document.createElement('div'); div.className = 'toast toast-'+(type==='danger'?'danger':type==='success'?'success':'info');
  div.innerHTML = `<div class="toast-icon">🔔</div><div class="toast-msg">${msg}</div><button class="toast-dismiss">×</button>`;
  c.appendChild(div);
  div.querySelector('.toast-dismiss').addEventListener('click', ()=>{ div.remove(); });
  setTimeout(()=>{ if (div.parentElement) div.remove(); }, 4000);
}
