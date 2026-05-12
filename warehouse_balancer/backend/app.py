import time
import random
import csv
import io
import threading
import os
import sys
from flask import Flask, jsonify, send_from_directory, request, Response
from flask_cors import CORS
from flask_socketio import SocketIO
from models import WorkloadBalancer

app = Flask(__name__, static_folder='../frontend', static_url_path='')
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')
balancer = WorkloadBalancer()
db_lock  = threading.Lock()
_server_start = time.time()

# ─── background simulation ─────────────────────────────────────────────────
def simulation_loop():
    while True:
        try:
            with db_lock:
                # auto-generate orders
                if random.random() < 0.2:
                    balancer.receive_order(priority=random.choice(["Low", "Medium", "High"]))

                # virtual employee task completions
                emps = balancer.conn.execute("SELECT * FROM employees WHERE status='active'").fetchall()
                for emp in emps:
                    if random.random() < 0.25:
                        order = balancer.conn.execute(
                            "SELECT * FROM orders WHERE assigned_worker_id=? AND status='pending' LIMIT 1",
                            (emp['id'],)
                        ).fetchone()
                        if order:
                            ticks = random.uniform(1.0, 5.0)
                            balancer.complete_task(order['id'], actual_ticks_spent=ticks)
                            balancer.log_event(f"Virtual [{emp['name']}] completed Order #{order['id']}.", "INFO")

                # NOTE: Auto-break and auto-resume removed.
                # Breaks are now exclusively admin-controlled.

                payload = balancer.get_system_status()

            socketio.emit('state_update', payload)
        except Exception:
            import traceback; traceback.print_exc()
        finally:
            time.sleep(2)

# ─── auth ─────────────────────────────────────────────────────────────────
@app.route('/api/login', methods=['POST'])
def login():
    with db_lock:
        d    = request.json
        user = balancer.authenticate(d.get('username'), d.get('password'))
    if user:
        return jsonify({"success": True,
                        "user": {"username": user['username'], "role": user['role'],
                                 "employee_id": user['employee_id']}})
    return jsonify({"success": False, "message": "Invalid Credentials"}), 401

# ─── employee portal ────────────────────────────────────────────────────────
@app.route('/api/employee/orders', methods=['GET'])
def get_employee_orders():
    with db_lock:
        eid    = request.args.get('employee_id')
        orders = balancer.conn.execute(
            "SELECT * FROM orders WHERE assigned_worker_id=? AND status='pending'", (eid,)
        ).fetchall()
    return jsonify({"orders": [dict(o) for o in orders]})

# NOTE: /api/employee/status route removed — employees can no longer self-manage breaks.

@app.route('/api/employee/complete', methods=['POST'])
def mark_completed():
    with db_lock:
        d = request.json
        balancer.complete_task(d.get('order_id'), actual_ticks_spent=d.get('ticks', 5))
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": True})

# ─── admin orders ─────────────────────────────────────────────────────────────
@app.route('/api/add_order', methods=['POST'])
def manual_add_order():
    with db_lock:
        d = request.json or {}
        balancer.receive_order(
            priority=d.get('priority', 'High'),
            title=d.get('title'),
            zone=d.get('zone')
        )
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": True})

@app.route('/api/admin/orders/bulk', methods=['POST'])
def bulk_add_orders():
    with db_lock:
        d        = request.json or {}
        count    = min(int(d.get('count', 5)), 50)
        priority = d.get('priority', 'Medium')
        created  = balancer.bulk_receive_orders(count, priority)
        st       = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": True, "created": created})

@app.route('/api/admin/orders/<int:order_id>/reassign', methods=['POST'])
def reassign_order(order_id):
    with db_lock:
        ok = balancer.reassign_order(order_id)
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": ok})

# ─── admin employee CRUD ──────────────────────────────────────────────────────
@app.route('/api/admin/employees', methods=['POST'])
def add_employee():
    with db_lock:
        d      = request.json
        result = balancer.add_employee(
            name      = d.get('name', 'New Employee'),
            role      = d.get('role', 'General Operator'),
            zone      = d.get('zone', 'Sector 1'),
            equipment = d.get('equipment', 'General Tools'),
        )
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": True, "employee": result})

@app.route('/api/admin/employees/<int:emp_id>', methods=['DELETE'])
def remove_employee(emp_id):
    with db_lock:
        ok = balancer.remove_employee(emp_id)
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": ok})

# ─── admin break management (ADMIN ONLY) ──────────────────────────────────────
@app.route('/api/admin/employees/<int:emp_id>/break', methods=['POST'])
def admin_grant_break(emp_id):
    """Admin grants a break to a specific employee."""
    with db_lock:
        d = request.json or {}
        try:
            minutes = float(d.get('minutes') or d.get('duration') or 0)
        except Exception:
            minutes = 0.0
        balancer.set_employee_status(emp_id, 'break')
        balancer.log_event(f"Admin granted break to Employee #{emp_id}.", "SYSTEM")
        st = balancer.get_system_status()
    socketio.emit('state_update', st)

    # If admin requested an auto-resume after X minutes, schedule it in background
    if minutes and minutes > 0:
        def _auto_resume(eid, mins):
            try:
                with db_lock:
                    balancer.set_employee_status(eid, 'resume')
                    balancer.log_event(f"Auto-resume after {mins}min for Employee #{eid}.", "SYSTEM")
                    st2 = balancer.get_system_status()
                socketio.emit('state_update', st2)
            except Exception:
                import traceback; traceback.print_exc()
        t = threading.Timer(minutes * 60, _auto_resume, args=(emp_id, minutes))
        t.daemon = True
        t.start()

    return jsonify({"success": True})

@app.route('/api/admin/employees/<int:emp_id>/resume', methods=['POST'])
def admin_end_break(emp_id):
    """Admin ends the break for a specific employee."""
    with db_lock:
        balancer.set_employee_status(emp_id, 'resume')
        balancer.log_event(f"Admin ended break for Employee #{emp_id}.", "SYSTEM")
        st = balancer.get_system_status()
    socketio.emit('state_update', st)
    return jsonify({"success": True})

# ─── leaderboard & work logs ──────────────────────────────────────────────────
@app.route('/api/leaderboard', methods=['GET'])
def leaderboard():
    with db_lock:
        data = balancer.get_leaderboard()
    return jsonify({"leaderboard": data})

@app.route('/api/admin/orders', methods=['GET'])
def get_active_orders():
    with db_lock:
        data = balancer.get_active_orders()
    return jsonify({"orders": data})

@app.route('/api/work_logs', methods=['GET'])
def work_logs():
    with db_lock:
        data = balancer.get_work_logs(limit=60)
    return jsonify({"logs": data})

# ─── analytics & system health ────────────────────────────────────────────────
@app.route('/api/admin/analytics/summary', methods=['GET'])
def analytics_summary():
    with db_lock:
        data = balancer.get_analytics_summary()
    return jsonify(data)

@app.route('/api/admin/system/health', methods=['GET'])
def system_health():
    uptime = round(time.time() - _server_start)
    mem_mb = 0.0
    try:
        import psutil
        proc   = psutil.Process(os.getpid())
        mem_mb = round(proc.memory_info().rss / 1024 / 1024, 1)
    except Exception:
        pass
    return jsonify({
        "uptime_seconds": uptime,
        "memory_mb":      mem_mb,
        "python_version": sys.version.split()[0],
    })

# ─── general ──────────────────────────────────────────────────────────────────
@app.route('/api/status', methods=['GET'])
def get_status():
    with db_lock:
        st = balancer.get_system_status()
    return jsonify(st)

@app.route('/api/admin/export', methods=['GET'])
def export_csv():
    with db_lock:
        orders = balancer.conn.execute(
            "SELECT id, title, priority, status, assigned_worker_id, created_at, completed_at FROM orders"
        ).fetchall()
        logs = balancer.get_work_logs(limit=500)

    out = io.StringIO()
    w   = csv.writer(out)
    w.writerow(["=== ORDERS REPORT ==="])
    w.writerow(['Order ID','Title','Priority','Status','Assigned Worker','Created At','Completed At'])
    for o in orders:
        comp = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(o['completed_at'])) if o['completed_at'] else '—'
        w.writerow([o['id'], o['title'], o['priority'], o['status'], o['assigned_worker_id'],
                    time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(o['created_at'])), comp])
    w.writerow([])
    w.writerow(["=== WORK ACTIVITY LOG ==="])
    w.writerow(['Log ID','Employee','Action','Detail','Timestamp'])
    for l in logs:
        w.writerow([l['id'], l['employee_name'], l['action'], l['detail'],
                    time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(l['timestamp']))])

    resp = Response(out.getvalue(), mimetype='text/csv')
    resp.headers["Content-Disposition"] = "attachment; filename=nexus_full_report.csv"
    return resp

@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

if __name__ == '__main__':
    print("Starting NexusWork Platform v3.0 — Admin-Controlled Breaks Edition...")
    socketio.start_background_task(simulation_loop)
    socketio.run(app, debug=True, port=5050, use_reloader=False)
