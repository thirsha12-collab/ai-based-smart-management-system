import random
import sqlite3
import os
import time

db_path = os.path.join(os.path.dirname(__file__), 'warehouse_v2.db')

def get_db():
    conn = sqlite3.connect(db_path, check_same_thread=False, timeout=15.0)
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    conn.execute('PRAGMA foreign_keys = ON;')
    
    conn.execute('''CREATE TABLE IF NOT EXISTS users
                 (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT, employee_id INTEGER)''')
                 
    conn.execute('''CREATE TABLE IF NOT EXISTS employees
                 (id INTEGER PRIMARY KEY, name TEXT, role TEXT, zone TEXT, equipment TEXT, avatar_hue INTEGER, 
                  status TEXT DEFAULT 'idle', workload INTEGER DEFAULT 0, fatigue REAL DEFAULT 0.0, max_capacity INTEGER, 
                  base_efficiency REAL, break_time_taken INTEGER DEFAULT 0, total_work_time INTEGER DEFAULT 0,
                  qa_score INTEGER DEFAULT 0, level INTEGER DEFAULT 1, tasks_completed INTEGER DEFAULT 0,
                  shift_efficiency REAL DEFAULT 0.0)''')
                  
    conn.execute('''CREATE TABLE IF NOT EXISTS orders
                 (id INTEGER PRIMARY KEY, title TEXT, priority TEXT, status TEXT DEFAULT 'pending', 
                  assigned_worker_id INTEGER, created_at REAL, completed_at REAL, zone TEXT)''')
                  
    conn.execute('''CREATE TABLE IF NOT EXISTS work_logs
                 (id INTEGER PRIMARY KEY, employee_id INTEGER, employee_name TEXT, 
                  action TEXT, detail TEXT, timestamp REAL)''')
                 
    conn.execute('''CREATE TABLE IF NOT EXISTS ml_state
                 (id INTEGER PRIMARY KEY, w_workload REAL, w_fatigue REAL, bias REAL, training_steps INTEGER,
                  v_workload REAL DEFAULT 0.0, v_fatigue REAL DEFAULT 0.0, v_bias REAL DEFAULT 0.0)''')

    # Migration-safe additions
    for col, typedef in [
        ('completed_at', 'REAL'),
        ('zone', 'TEXT'),
    ]:
        try:
            conn.execute(f'ALTER TABLE orders ADD COLUMN {col} {typedef}')
        except Exception:
            pass

    for col, typedef in [
        ('shift_efficiency', 'REAL DEFAULT 0.0'),
    ]:
        try:
            conn.execute(f'ALTER TABLE employees ADD COLUMN {col} {typedef}')
        except Exception:
            pass

    for col, typedef in [
        ('v_workload', 'REAL DEFAULT 0.0'),
        ('v_fatigue',  'REAL DEFAULT 0.0'),
        ('v_bias',     'REAL DEFAULT 0.0'),
    ]:
        try:
            conn.execute(f'ALTER TABLE ml_state ADD COLUMN {col} {typedef}')
        except Exception:
            pass

    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM users')
    if cursor.fetchone()[0] == 0:
        cursor.execute("INSERT INTO users (username, password, role) VALUES ('admin', 'admin', 'admin')")
        
        seed_emps = [
            (1, "John Smith",   "Heavy Lifter Operator",  "Sector 4", "Forklift V4",  210, 10, 0.25),
            (2, "Sarah Connor", "Inventory Specialist",   "Sector 1", "Tablet",        340, 12, 0.35),
            (3, "Mike Johnson", "Fulfillment Packer",     "Sector 2", "Panel",         160,  8, 0.20),
            (4, "Emily Davis",  "QC Inspector",           "Sector 2", "Testing Rig",    45, 10, 0.40),
            (5, "David Wilson", "Shipping Coordinator",   "Sector 3", "Hand Truck",    280, 15, 0.15),
        ]
        conn.executemany(
            "INSERT INTO employees (id,name,role,zone,equipment,avatar_hue,max_capacity,base_efficiency) VALUES (?,?,?,?,?,?,?,?)",
            seed_emps
        )
        conn.executemany(
            "INSERT INTO users (username, password, role, employee_id) VALUES (?, '1234', 'employee', ?)",
            [("john",1),("sarah",2),("mike",3),("emily",4),("david",5)]
        )
        cursor.execute('INSERT INTO ml_state (id, w_workload, w_fatigue, bias, training_steps, v_workload, v_fatigue, v_bias) VALUES (1, 0.5, 0.2, 1.0, 0, 0.0, 0.0, 0.0)')
    conn.commit()
    conn.close()

# ─── helpers ──────────────────────────────────────────────────────────────────
def _next_emp_id(conn):
    row = conn.execute('SELECT MAX(id) FROM employees').fetchone()
    return (row[0] or 0) + 1

# ─── ML Model with Momentum ───────────────────────────────────────────────────
class MachineLearningModel:
    def __init__(self, conn):
        self.conn = conn
        self.learning_rate = 0.005
        self.momentum      = 0.9
        self.sync_state()

    def sync_state(self):
        row = self.conn.execute('SELECT * FROM ml_state WHERE id=1').fetchone()
        self.w_workload     = row['w_workload']
        self.w_fatigue      = row['w_fatigue']
        self.bias           = row['bias']
        self.training_steps = row['training_steps']
        self.v_workload     = row['v_workload'] if 'v_workload' in row.keys() else 0.0
        self.v_fatigue      = row['v_fatigue']  if 'v_fatigue'  in row.keys() else 0.0
        self.v_bias         = row['v_bias']     if 'v_bias'     in row.keys() else 0.0

    def predict_completion_ticks(self, workload, fatigue):
        return max(1.0, (self.w_workload * workload) + (self.w_fatigue * fatigue) + self.bias)

    def train(self, workload, fatigue, actual_ticks):
        prediction = self.predict_completion_ticks(workload, fatigue)
        error = prediction - actual_ticks

        # Momentum gradient descent
        self.v_workload = self.momentum * self.v_workload + self.learning_rate * error * workload
        self.v_fatigue  = self.momentum * self.v_fatigue  + self.learning_rate * error * fatigue
        self.v_bias     = self.momentum * self.v_bias     + self.learning_rate * error

        self.w_workload  -= self.v_workload
        self.w_fatigue   -= self.v_fatigue
        self.bias        -= self.v_bias
        self.training_steps += 1

        self.conn.execute(
            '''UPDATE ml_state SET w_workload=?, w_fatigue=?, bias=?, training_steps=?,
               v_workload=?, v_fatigue=?, v_bias=? WHERE id=1''',
            (self.w_workload, self.w_fatigue, self.bias, self.training_steps,
             self.v_workload, self.v_fatigue, self.v_bias)
        )
        self.conn.commit()

# ─── Workload Balancer ────────────────────────────────────────────────────────
class WorkloadBalancer:
    def __init__(self):
        init_db()
        self.conn = get_db()
        self.ml_model   = MachineLearningModel(self.conn)
        self.event_logs = []
        self._start_time = time.time()
        self.log_event("SaaS Module Init. Database schemas loaded.", "SYSTEM")

    # ── logging ──────────────────────────────────────────────────────────────
    def log_event(self, message, event_type="INFO"):
        ts = time.strftime('%H:%M:%S')
        self.event_logs.insert(0, {"time": ts, "message": message, "type": event_type})
        if len(self.event_logs) > 60:
            self.event_logs.pop()

    def _log_work(self, employee_id, employee_name, action, detail=""):
        """Persist action to work_logs table."""
        self.conn.execute(
            'INSERT INTO work_logs (employee_id, employee_name, action, detail, timestamp) VALUES (?,?,?,?,?)',
            (employee_id, employee_name, action, detail, time.time())
        )
        self.conn.commit()

    # ── fatigue sync ──────────────────────────────────────────────────────────
    def sync_fatigue_and_workloads(self):
        emps = self.conn.execute('SELECT * FROM employees').fetchall()
        for emp in emps:
            workload = self.conn.execute(
                "SELECT COUNT(*) as c FROM orders WHERE assigned_worker_id=? AND status='pending'",
                (emp['id'],)
            ).fetchone()['c']

            fatigue = emp['fatigue']
            if emp['status'] == 'break':
                fatigue -= 10.0
            elif workload > 0:
                fatigue += (workload / emp['max_capacity']) * 2.5
            else:
                fatigue -= 2.0
            fatigue = max(0.0, min(100.0, fatigue))

            new_status = emp['status']
            if emp['status'] != 'break':
                if workload >= emp['max_capacity']:
                    new_status = 'overloaded'
                elif workload > 0:
                    new_status = 'active'
                else:
                    new_status = 'idle'

            self.conn.execute(
                'UPDATE employees SET workload=?, fatigue=?, status=? WHERE id=?',
                (workload, fatigue, new_status, emp['id'])
            )
        self.conn.commit()

    # ── auth ──────────────────────────────────────────────────────────────────
    def authenticate(self, username, password):
        user = self.conn.execute(
            'SELECT * FROM users WHERE username=? AND password=?', (username, password)
        ).fetchone()
        return dict(user) if user else None

    # ── orders ────────────────────────────────────────────────────────────────
    def receive_order(self, priority="Medium", title=None, zone=None):
        if not title:
            title = f"Task Order #{random.randint(1000, 9999)}"
        cursor = self.conn.execute(
            'INSERT INTO orders (title, priority, status, created_at, zone) VALUES (?, ?, ?, ?, ?)',
            (title, priority, 'unassigned', time.time(), zone)
        )
        order_id = cursor.lastrowid
        self.conn.commit()
        return self.assign_order(order_id, preferred_zone=zone)

    def bulk_receive_orders(self, count, priority="Medium"):
        """Inject multiple orders at once."""
        zones = ['Sector 1', 'Sector 2', 'Sector 3', 'Sector 4']
        created = 0
        for i in range(count):
            zone = random.choice(zones)
            title = f"Bulk Task #{random.randint(1000, 9999)}"
            cursor = self.conn.execute(
                'INSERT INTO orders (title, priority, status, created_at, zone) VALUES (?, ?, ?, ?, ?)',
                (title, priority, 'unassigned', time.time(), zone)
            )
            self.assign_order(cursor.lastrowid, preferred_zone=zone)
            created += 1
        self.log_event(f"Bulk injection: {created} × {priority} orders queued.", "SYSTEM")
        return created

    def assign_order(self, order_id, preferred_zone=None):
        # Prefer workers in the same zone if a zone hint is given
        if preferred_zone:
            emps = self.conn.execute(
                "SELECT * FROM employees WHERE status != 'break' AND status != 'overloaded' AND fatigue < 90.0 AND zone=?",
                (preferred_zone,)
            ).fetchall()
        else:
            emps = []

        # Fall back to any available worker
        if not emps:
            emps = self.conn.execute(
                "SELECT * FROM employees WHERE status != 'break' AND status != 'overloaded' AND fatigue < 90.0"
            ).fetchall()

        if not emps:
            self.log_event("Gridlock! Order orphaned — all nodes at capacity or resting.", "ERROR")
            return False

        best = min(emps, key=lambda w: self.ml_model.predict_completion_ticks(w['workload'], w['fatigue']))
        self.conn.execute(
            "UPDATE orders SET assigned_worker_id=?, status='pending' WHERE id=?", (best['id'], order_id)
        )
        self.conn.commit()
        self.sync_fatigue_and_workloads()
        self._log_work(best['id'], best['name'], 'TASK_ASSIGNED', f"Order #{order_id}")
        self.log_event(f"[ML Routing] Mapped Task #{order_id} → {best['name']}.", "ROUTING")
        return True

    def reassign_order(self, order_id):
        """Manually unassign and re-assign a specific order."""
        order = self.conn.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
        if not order or order['status'] not in ('pending', 'unassigned'):
            return False
        self.conn.execute(
            "UPDATE orders SET assigned_worker_id=NULL, status='unassigned' WHERE id=?", (order_id,)
        )
        self.conn.commit()
        self.log_event(f"Admin manually reassigning Order #{order_id}.", "SYSTEM")
        return self.assign_order(order_id)

    def redistribute_tasks(self, employee_id):
        orders = self.conn.execute(
            "SELECT id FROM orders WHERE assigned_worker_id=? AND status='pending'", (employee_id,)
        ).fetchall()
        if orders:
            self.conn.execute(
                "UPDATE orders SET assigned_worker_id=NULL, status='unassigned' WHERE assigned_worker_id=? AND status='pending'",
                (employee_id,)
            )
            self.conn.commit()
            self.log_event(f"Rescued {len(orders)} tasks from worker #{employee_id}.", "SYSTEM")
            for o in orders:
                self.assign_order(o['id'])

    # ── employee status ───────────────────────────────────────────────────────
    def set_employee_status(self, employee_id, status_command):
        emp = self.conn.execute('SELECT * FROM employees WHERE id=?', (employee_id,)).fetchone()
        if not emp:
            return
        if status_command == 'break':
            self.conn.execute("UPDATE employees SET status='break' WHERE id=?", (employee_id,))
            self._log_work(employee_id, emp['name'], 'BREAK_START', "Employee started break")
            self.log_event(f"Employee {emp['name']} initiated Break State.", "WARNING")
            self.redistribute_tasks(employee_id)
        elif status_command == 'resume':
            # compute break duration from last BREAK_START in work_logs (if any)
            # Find the most recent BREAK_START and BREAK_END. Only count if there is an unmatched BREAK_START
            last_start_row = self.conn.execute(
                "SELECT timestamp FROM work_logs WHERE employee_id=? AND action='BREAK_START' ORDER BY timestamp DESC LIMIT 1",
                (employee_id,)
            ).fetchone()
            last_end_row = self.conn.execute(
                "SELECT timestamp FROM work_logs WHERE employee_id=? AND action='BREAK_END' ORDER BY timestamp DESC LIMIT 1",
                (employee_id,)
            ).fetchone()
            added_seconds = 0.0
            if last_start_row:
                start_ts = last_start_row['timestamp']
                end_ts = last_end_row['timestamp'] if last_end_row else None
                # Only count if start exists and is after the last end (i.e., open break)
                if start_ts and (not end_ts or start_ts > end_ts):
                    now_ts = time.time()
                    if start_ts < now_ts:
                        added_seconds = now_ts - start_ts
                        # update cumulative break_time_taken (stored in seconds)
                        cur = self.conn.execute('SELECT break_time_taken FROM employees WHERE id=?', (employee_id,)).fetchone()
                        prev = cur['break_time_taken'] or 0
                        self.conn.execute('UPDATE employees SET break_time_taken=? WHERE id=?', (int(prev + added_seconds), employee_id))

            self.conn.execute("UPDATE employees SET status='idle' WHERE id=?", (employee_id,))
            self._log_work(employee_id, emp['name'], 'BREAK_END', "Employee resumed work")
            self.log_event(f"Employee {emp['name']} resumed active rotation. Break added {int(added_seconds/60)} min.", "INFO")
        self.conn.commit()
        self.sync_fatigue_and_workloads()

    # ── task completion ───────────────────────────────────────────────────────
    def complete_task(self, order_id, actual_ticks_spent=5):
        order = self.conn.execute('SELECT * FROM orders WHERE id=?', (order_id,)).fetchone()
        if not order or order['status'] != 'pending':
            return
        now = time.time()
        self.conn.execute("UPDATE orders SET status='completed', completed_at=? WHERE id=?", (now, order_id))
        emp = self.conn.execute('SELECT * FROM employees WHERE id=?', (order['assigned_worker_id'],)).fetchone()
        if not emp:
            self.conn.commit()
            return

        wl, ft = emp['workload'], emp['fatigue']
        self.ml_model.train(wl, ft, actual_ticks_spent)
        predicted = self.ml_model.predict_completion_ticks(wl, ft)

        # QA Gamification
        qa    = emp['qa_score']
        level = emp['level']
        tasks = emp['tasks_completed'] + 1

        if actual_ticks_spent < predicted - 1.0:
            qa += 15
        elif actual_ticks_spent > predicted + 2.0:
            qa -= 5
        else:
            qa += 5

        if qa >= 100:
            level += 1
            qa = qa % 100
            self.log_event(f"🏆 Level Up! {emp['name']} reached Level {level}!", "INFO")

        qa = max(0, qa)

        # Compute rolling efficiency: ratio of fast completions vs predicted
        ratio = predicted / max(actual_ticks_spent, 0.1)
        old_eff = emp['shift_efficiency'] if emp['shift_efficiency'] else 0.0
        new_eff = round(old_eff * 0.8 + min(ratio, 2.0) * 0.2, 3)   # EMA

        self.conn.execute(
            "UPDATE employees SET qa_score=?, level=?, tasks_completed=?, shift_efficiency=? WHERE id=?",
            (qa, level, tasks, new_eff, emp['id'])
        )

        # Work log entry
        self._log_work(emp['id'], emp['name'], 'TASK_COMPLETED',
                       f"Order #{order_id} | Actual: {actual_ticks_spent:.1f}t | Predicted: {predicted:.1f}t")

        self.conn.commit()
        self.sync_fatigue_and_workloads()

    # ── employee CRUD ─────────────────────────────────────────────────────────
    def add_employee(self, name, role, zone, equipment):
        new_id = _next_emp_id(self.conn)
        hue = random.randint(0, 359)
        self.conn.execute(
            "INSERT INTO employees (id,name,role,zone,equipment,avatar_hue,max_capacity,base_efficiency) VALUES (?,?,?,?,?,?,?,?)",
            (new_id, name, role, zone, equipment, hue, 10, 0.3)
        )
        username = name.split()[0].lower() + str(new_id)
        password = "1234"
        self.conn.execute(
            "INSERT INTO users (username, password, role, employee_id) VALUES (?,?,?,?)",
            (username, password, 'employee', new_id)
        )
        self.conn.commit()
        self._log_work(new_id, name, 'EMPLOYEE_ADDED', f"Zone: {zone} | Role: {role}")
        self.log_event(f"Admin added new employee: {name} (ID #{new_id})", "SYSTEM")
        return {"id": new_id, "username": username, "password": password}

    def remove_employee(self, employee_id):
        emp = self.conn.execute('SELECT * FROM employees WHERE id=?', (employee_id,)).fetchone()
        if not emp:
            return False
        self.redistribute_tasks(employee_id)
        self.conn.execute("DELETE FROM users WHERE employee_id=?", (employee_id,))
        self.conn.execute("DELETE FROM employees WHERE id=?", (employee_id,))
        self.conn.commit()
        self.log_event(f"Admin removed employee: {emp['name']} (ID #{employee_id})", "WARNING")
        return True

    # ── active orders ──────────────────────────────────────────────────────────
    def get_active_orders(self):
        rows = self.conn.execute(
            '''SELECT o.id, o.title, o.priority, o.status, o.created_at, o.zone,
                      o.assigned_worker_id, e.name as worker_name
               FROM orders o
               LEFT JOIN employees e ON o.assigned_worker_id = e.id
               WHERE o.status IN ('pending','unassigned')
               ORDER BY o.created_at DESC'''
        ).fetchall()
        return [dict(r) for r in rows]

    # ── work logs ─────────────────────────────────────────────────────────────
    def get_work_logs(self, limit=50):
        rows = self.conn.execute(
            'SELECT * FROM work_logs ORDER BY timestamp DESC LIMIT ?', (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_leaderboard(self):
        rows = self.conn.execute(
            'SELECT id, name, role, level, qa_score, tasks_completed, status, avatar_hue, shift_efficiency FROM employees ORDER BY level DESC, qa_score DESC'
        ).fetchall()
        return [dict(r) for r in rows]

    # ── analytics summary ─────────────────────────────────────────────────────
    def get_analytics_summary(self):
        """Returns throughput, avg completion time, per-worker efficiency."""
        now = time.time()
        window_60 = now - 60
        window_3600 = now - 3600

        # Orders completed in last 60 seconds
        recent_60 = self.conn.execute(
            "SELECT COUNT(*) as c FROM orders WHERE status='completed' AND completed_at >= ?",
            (window_60,)
        ).fetchone()['c']

        # Orders completed in last hour
        recent_hr = self.conn.execute(
            "SELECT COUNT(*) as c FROM orders WHERE status='completed' AND completed_at >= ?",
            (window_3600,)
        ).fetchone()['c']

        # Average time-to-complete (seconds) across all completed orders that have completed_at
        avg_row = self.conn.execute(
            "SELECT AVG(completed_at - created_at) as avg_t FROM orders WHERE status='completed' AND completed_at IS NOT NULL"
        ).fetchone()
        avg_time = round(avg_row['avg_t'] or 0, 1)

        # Per-worker compact stats
        workers = self.conn.execute(
            'SELECT id, name, tasks_completed, shift_efficiency, level FROM employees'
        ).fetchall()

        # Priority breakdown of completed orders
        high_done = self.conn.execute(
            "SELECT COUNT(*) as c FROM orders WHERE status='completed' AND priority='High'"
        ).fetchone()['c']
        med_done = self.conn.execute(
            "SELECT COUNT(*) as c FROM orders WHERE status='completed' AND priority='Medium'"
        ).fetchone()['c']
        low_done = self.conn.execute(
            "SELECT COUNT(*) as c FROM orders WHERE status='completed' AND priority='Low'"
        ).fetchone()['c']

        return {
            "throughput_60s":    recent_60,
            "throughput_hr":     recent_hr,
            "avg_completion_s":  avg_time,
            "priority_breakdown": {"High": high_done, "Medium": med_done, "Low": low_done},
            "worker_efficiency": [
                {
                    "id":   w['id'],
                    "name": w['name'],
                    "tasks_completed": w['tasks_completed'],
                    "efficiency": round(w['shift_efficiency'] or 0.0, 2),
                    "level": w['level'],
                }
                for w in workers
            ],
        }

    # ── system status ─────────────────────────────────────────────────────────
    def get_system_status(self):
        self.sync_fatigue_and_workloads()
        emps = self.conn.execute('SELECT * FROM employees').fetchall()
        total_orders    = self.conn.execute("SELECT COUNT(*) as c FROM orders WHERE status='completed'").fetchone()['c']
        unassigned      = self.conn.execute("SELECT COUNT(*) as c FROM orders WHERE status='unassigned'").fetchone()['c']
        system_workload = sum(w['workload'] for w in emps)
        max_capacity    = sum(w['max_capacity'] for w in emps)
        load_pct        = (system_workload / max_capacity * 100) if max_capacity > 0 else 0

        self.ml_model.sync_state()
        confidence = min(99.9, (self.ml_model.training_steps / 200.0) * 100)

        recent_routing = len([x for x in self.event_logs if x['type'] == 'ROUTING'])
        forecast = "Stable"
        if recent_routing > 6:
            forecast = "⚠️ Projected 95% Queue Peak in ~12 mins. Recommend extra nodes."

        # Compute per-day metrics (since local midnight) for each employee:
        now = time.time()
        lt = time.localtime(now)
        start_of_day = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, lt.tm_wday, lt.tm_yday, lt.tm_isdst))

        workers_list = []
        for w in emps:
            wid = w['id']
            # Total work seconds today: sum of (completed_at - created_at) for orders completed today by this worker
            row = self.conn.execute(
                "SELECT SUM(completed_at - created_at) as s FROM orders WHERE status='completed' AND completed_at >= ? AND assigned_worker_id=?",
                (start_of_day, wid)
            ).fetchone()
            work_seconds = row['s'] or 0.0

            # Break minutes today: pair BREAK_START / BREAK_END events from work_logs since start_of_day
            logs = self.conn.execute(
                "SELECT action, timestamp FROM work_logs WHERE employee_id=? AND timestamp >= ? AND (action='BREAK_START' OR action='BREAK_END') ORDER BY timestamp ASC",
                (wid, start_of_day)
            ).fetchall()
            break_seconds = 0.0
            start_ts = None
            for lg in logs:
                if lg['action'] == 'BREAK_START':
                    start_ts = lg['timestamp']
                elif lg['action'] == 'BREAK_END':
                    if start_ts:
                        break_seconds += (lg['timestamp'] - start_ts)
                        start_ts = None
            # If a break was started but not ended yet, count until now
            if start_ts:
                break_seconds += (now - start_ts)

            workers_list.append({**dict(w),
                                 'hours_today': round(work_seconds / 3600.0, 2),
                                 'break_minutes_today': int(round(break_seconds / 60.0)),
                                 'break_time_total_minutes': int(round((w['break_time_taken'] or 0) / 60.0))
                                 })

        return {
            "workers":               workers_list,
            "total_orders_completed": total_orders,
            "unassigned_orders":      unassigned,
            "system_load_percentage": round(load_pct, 1),
            "ai_forecast":            forecast,
            "logs":                   self.event_logs,
            "uptime_seconds":         round(time.time() - self._start_time),
            "ml_stats": {
                "w_workload":    round(self.ml_model.w_workload, 4),
                "w_fatigue":     round(self.ml_model.w_fatigue, 4),
                "bias":          round(self.ml_model.bias, 4),
                "training_steps": self.ml_model.training_steps,
                "confidence":    f"{round(confidence, 1)}%",
            },
        }
