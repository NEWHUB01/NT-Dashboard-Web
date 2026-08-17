"""NT CCTV Dashboard — Backend server

รัน:  python server.py   (ค่าเริ่มต้น http://127.0.0.1:8000)

- ล็อกอินจริง: ตรวจรหัสผ่านแบบ hash จาก users.json, ออก session cookie (HttpOnly)
- ซ่อน API: URL/key ของ API จริงเก็บใน config.json ฝั่งเซิร์ฟเวอร์
  เบราว์เซอร์เรียกแค่ /api/status แล้วเซิร์ฟเวอร์ไปเรียก API ปลายทางแทน (proxy)
- จัดการผู้ใช้: python manage.py add/passwd/del/list
"""
import hmac
import json
import os
import secrets
import socket
import sys

# คอนโซล Windows บางเครื่องเป็น cp1252 — พิมพ์ข้อความไทยแล้วพัง
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

BASE = Path(__file__).resolve().parent
USERS_FILE = BASE / "users.json"
CONFIG_FILE = BASE / "config.json"
DEVICES_FILE = BASE / "devices.json"

# คีย์ที่ใช้เก็บบน Redis เมื่อรันแบบ serverless
DEVICES_KEY = "ntcctv:devices"
CONFIG_KEY = "ntcctv:config"

CATEGORY_KEYS = ["recorder", "camera", "transmitter", "receiver", "router", "accesspoint"]

# คำที่ยอมรับได้ในพารามิเตอร์ status ของ Netwatch (MikroTik ส่ง up/down/unknown)
STATUS_ALIASES = {
    "up": "up", "online": "up", "ok": "up", "1": "up", "true": "up",
    "down": "down", "offline": "down", "0": "down", "false": "down",
    "unknown": "unknown",
}

# แสดงเมื่อยังไม่ได้ตั้งค่า API ปลายทาง
DEMO_DATA = {
    "recorder":    {"up": 33,  "down": 0,  "unknown": 0},
    "camera":      {"up": 707, "down": 12, "unknown": 0},
    "transmitter": {"up": 0,   "down": 0,  "unknown": 0},
    "receiver":    {"up": 0,   "down": 0,  "unknown": 0},
    "router":      {"up": 6,   "down": 0,  "unknown": 0},
    "accesspoint": {"up": 126, "down": 1,  "unknown": 0},
}


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ---------------- ที่เก็บข้อมูล: ไฟล์ (รันเอง) หรือ Redis (serverless) ----------------
# บน Vercel ระบบไฟล์เขียนไม่ได้ และแต่ละ request อาจอยู่คนละ instance
# ถ้าตั้ง env var ของ Upstash/Vercel KV ไว้ จะเก็บลง Redis ผ่าน REST API แทนไฟล์
def kv_conn():
    url = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if not url or not token:
        return None
    return url.rstrip("/"), token


def kv_get(key):
    url, token = kv_conn()
    r = requests.get(f"{url}/get/{key}", headers={"Authorization": f"Bearer {token}"}, timeout=10)
    r.raise_for_status()
    return r.json().get("result")


def kv_set(key, raw):
    url, token = kv_conn()
    r = requests.post(f"{url}/set/{key}", headers={"Authorization": f"Bearer {token}"},
                      data=raw.encode("utf-8"), timeout=10)
    r.raise_for_status()


def store_load(key, path, default):
    if kv_conn():
        raw = kv_get(key)
        if not raw:
            return default
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return default
    return load_json(path, default)


def store_save(key, path, data):
    if kv_conn():
        kv_set(key, json.dumps(data, ensure_ascii=False))
    else:
        save_json(path, data)


def load_users():
    """บนโฮสต์ที่เขียนไฟล์ไม่ได้ ให้ใส่ผู้ใช้ผ่าน env var USERS_JSON
    เช่น {"admin": "scrypt:32768:8:1$..."} (สร้าง hash ด้วย python manage.py hash <รหัสผ่าน>)"""
    raw = os.environ.get("USERS_JSON")
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            print("* USERS_JSON ไม่ใช่ JSON ที่ถูกต้อง — ข้ามไปใช้ users.json แทน", flush=True)
    return load_json(USERS_FILE, {})


def load_config():
    return store_load(CONFIG_KEY, CONFIG_FILE, {})


def save_config(cfg):
    store_save(CONFIG_KEY, CONFIG_FILE, cfg)


def lan_ip():
    """IP ของเครื่องนี้ในวง LAN — ใช้บอก MikroTik ว่าต้องยิงสถานะมาที่ไหน
    (เปิด UDP socket เฉยๆ ให้ OS เลือก interface — ไม่ได้ส่งข้อมูลออกจริง)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


# ---- first-run setup ----
# ห่อ try ไว้เพราะบน serverless ระบบไฟล์เขียนไม่ได้ — ที่นั่นใช้ USERS_JSON แทน
if not USERS_FILE.exists() and not os.environ.get("USERS_JSON"):
    try:
        save_json(USERS_FILE, {"admin": generate_password_hash("admin")})
        print("* สร้าง users.json แล้ว (ผู้ใช้เริ่มต้น admin/admin — ควรเปลี่ยนด้วย: python manage.py passwd admin)")
    except OSError:
        print("* เขียน users.json ไม่ได้ — ต้องตั้ง env var USERS_JSON ไม่งั้นจะล็อกอินไม่ได้", flush=True)

_config = load_json(CONFIG_FILE, {})
# config.json ไม่ถูก commit ขึ้น git (มีความลับอยู่) — บนเครื่องที่ clone มาใหม่
# หรือโฮสต์ที่เขียนไฟล์ไม่ได้ ให้ตั้งค่าผ่าน environment variable SECRET_KEY แทน
_secret = os.environ.get("SECRET_KEY") or _config.get("secret_key")
if not _secret:
    _secret = secrets.token_hex(32)
    try:
        _config["secret_key"] = _secret
        save_json(CONFIG_FILE, _config)
    except OSError:
        # เขียนไม่ได้ = คีย์จะเปลี่ยนทุกครั้งที่ instance เกิดใหม่ ทำให้ session หลุด
        print("* เขียน config.json ไม่ได้ — ต้องตั้ง env var SECRET_KEY ไม่งั้น session จะหลุดเรื่อยๆ", flush=True)

app = Flask(__name__, static_folder=None)
app.secret_key = _secret
app.permanent_session_lifetime = timedelta(days=30)
app.config["SESSION_COOKIE_HTTPONLY"] = True   # JS อ่าน cookie ไม่ได้
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"


@app.after_request
def no_store_api(resp):
    # ข้อมูลสถานะต้องสดเสมอ — กันเบราว์เซอร์เอาคำตอบเก่าใน cache มาแสดง
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            return jsonify(error="unauthorized"), 401
        return fn(*args, **kwargs)
    return wrapper


# ---------------- auth ----------------
@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    users = load_users()
    pw_hash = users.get(username)
    if not pw_hash or not check_password_hash(pw_hash, password):
        return jsonify(error="invalid credentials"), 401
    session.permanent = bool(data.get("remember"))
    session["user"] = username
    return jsonify(ok=True, user=username)


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
def api_me():
    if not session.get("user"):
        return jsonify(error="unauthorized"), 401
    return jsonify(user=session["user"])


# ---------------- upstream API proxy ----------------
def fetch_upstream(url, key, timeout=10):
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    r = requests.get(url, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.json()


@app.get("/api/status")
@login_required
def api_status():
    # โหมด 1: มีอุปกรณ์ในทะเบียน → นับสถานะจากที่ MikroTik รายงานเข้ามา
    store = load_devices()
    if store["devices"]:
        counts = {k: {"up": 0, "down": 0, "unknown": 0} for k in CATEGORY_KEYS}
        for dev in store["devices"].values():
            cat = dev.get("category")
            if cat not in counts:
                continue
            s = dev.get("status")
            bucket = "up" if s == "up" else "down" if s == "down" else "unknown"
            counts[cat][bucket] += 1
        return jsonify(source="devices", data=counts)

    # โหมด 2: ตั้งค่า API ภายนอกไว้ → proxy
    cfg = load_config()
    url = cfg.get("api_url")
    if not url:
        return jsonify(source="demo", data=DEMO_DATA)
    try:
        return jsonify(source="api", data=fetch_upstream(url, cfg.get("api_key")))
    except Exception as exc:  # เชื่อม API ปลายทางไม่ได้
        return jsonify(error=str(exc)), 502


# ---------------- device registry + MikroTik Netwatch ----------------
def load_devices():
    store = store_load(DEVICES_KEY, DEVICES_FILE, {"next_id": 1, "devices": {}})
    store.setdefault("next_id", 1)
    store.setdefault("devices", {})
    return store


def save_devices(store):
    store_save(DEVICES_KEY, DEVICES_FILE, store)


def push_token():
    """รหัสลับใน URL ที่ MikroTik ต้องแนบมาด้วย (ตั้งผ่าน env var PUSH_TOKEN)
    ถ้าไม่ตั้งไว้ = ใครยิงก็ได้ ซึ่งพอรับได้ในวง LAN ปิด แต่ห้ามใช้แบบนั้นบนอินเทอร์เน็ต"""
    return (os.environ.get("PUSH_TOKEN") or "").strip()


@app.route("/status/mikrotik.php", methods=["GET", "POST"])
def mikrotik_push():
    """รับสถานะจาก MikroTik Netwatch — path เดียวกับระบบจริงในคู่มือ
    ตัวอย่าง: /status/mikrotik.php?id=359&status=up
    (ล็อกอินด้วย session ไม่ได้เพราะ MikroTik ทำไม่ได้ — ใช้ PUSH_TOKEN แทนถ้าอยู่บนเน็ต)

    ทุกครั้งที่มีการยิงเข้ามาจะ log ลงคอนโซล เพื่อให้ไล่ปัญหาได้ว่า
    MikroTik ยิงมาถึงเซิร์ฟเวอร์จริงหรือไม่ และ id ตรงกับทะเบียนหรือเปล่า
    """
    dev_id = (request.values.get("id") or "").strip()
    raw = (request.values.get("status") or "").strip().lower()
    src = request.remote_addr
    expected = push_token()
    if expected and not hmac.compare_digest(request.values.get("token") or "", expected):
        print(f"* netwatch {src}: token ไม่ถูกต้อง id={dev_id or '-'}", flush=True)
        return "forbidden", 403
    status = STATUS_ALIASES.get(raw)
    if not status:
        print(f"* netwatch {src}: status ไม่ถูกต้อง ('{raw}') id={dev_id or '-'}", flush=True)
        return "bad status", 400
    store = load_devices()
    dev = store["devices"].get(dev_id)
    if not dev:
        print(f"* netwatch {src}: ไม่พบอุปกรณ์ id={dev_id or '-'} (ตรวจเลข ID ในหน้าอุปกรณ์)", flush=True)
        return "unknown id", 404
    dev["status"] = None if status == "unknown" else status
    dev["last_seen"] = datetime.now().isoformat(timespec="seconds")
    save_devices(store)
    print(f"* netwatch {src}: id={dev_id} ({dev.get('name')}) -> {status}", flush=True)
    return "OK"


@app.get("/api/server-info")
@login_required
def api_server_info():
    """URL ที่ MikroTik ต้องยิงเข้ามา
    - รันเองในวง LAN: ต้องเป็น IP ของเครื่องเซิร์ฟเวอร์ ไม่ใช่ 127.0.0.1 ที่เห็นในแถบ address
    - deploy ขึ้นโฮสต์จริง: ใช้โดเมนที่เปิดเข้ามานั่นเลย
    """
    host = request.host                      # เช่น "127.0.0.1:8000"
    hostname = host.rsplit(":", 1)[0] if ":" in host else host
    if hostname not in ("127.0.0.1", "localhost", "::1"):
        proto = request.headers.get("X-Forwarded-Proto", request.scheme)
        return jsonify(base_url=f"{proto}://{host}", lan_ip=None, push_token=push_token())
    port = host.rsplit(":", 1)[1] if ":" in host else os.environ.get("PORT", "8000")
    ip = lan_ip()
    return jsonify(base_url=f"http://{ip}:{port}", lan_ip=ip, push_token=push_token())


@app.get("/api/devices")
@login_required
def api_devices():
    store = load_devices()
    devices = [{"id": k, **v} for k, v in sorted(store["devices"].items(), key=lambda kv: int(kv[0]))]
    return jsonify(devices=devices)


@app.post("/api/devices")
@login_required
def api_add_device():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "").strip()
    ip = (data.get("ip") or "").strip()
    if not name or category not in CATEGORY_KEYS:
        return jsonify(error="กรุณากรอกชื่อและเลือกหมวดอุปกรณ์"), 400
    store = load_devices()
    dev_id = str(store["next_id"])
    store["next_id"] += 1
    store["devices"][dev_id] = {
        "name": name, "category": category, "ip": ip,
        "status": None, "last_seen": None,
    }
    save_devices(store)
    return jsonify(ok=True, id=dev_id)


@app.delete("/api/devices/<dev_id>")
@login_required
def api_del_device(dev_id):
    store = load_devices()
    if dev_id not in store["devices"]:
        return jsonify(error="not found"), 404
    del store["devices"][dev_id]
    save_devices(store)
    return jsonify(ok=True)


@app.get("/api/config")
@login_required
def api_get_config():
    cfg = load_config()
    # ส่งกลับแค่ URL และ "มี key หรือไม่" — ไม่ส่งตัว key ออกไปเด็ดขาด
    return jsonify(url=cfg.get("api_url", ""), hasKey=bool(cfg.get("api_key")))


@app.post("/api/config")
@login_required
def api_set_config():
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    cfg["api_url"] = (data.get("url") or "").strip()
    key = (data.get("key") or "").strip()
    if key:                      # กรอกใหม่ = เปลี่ยน key
        cfg["api_key"] = key
    elif not cfg["api_url"]:     # ล้าง URL = ล้าง key ด้วย
        cfg.pop("api_key", None)
    save_config(cfg)
    return jsonify(ok=True)


@app.post("/api/config/test")
@login_required
def api_test_config():
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    url = (data.get("url") or "").strip() or cfg.get("api_url")
    key = (data.get("key") or "").strip() or cfg.get("api_key")
    if not url:
        return jsonify(error="ยังไม่ได้กรอก URL"), 400
    try:
        fetch_upstream(url, key)
        return jsonify(ok=True)
    except Exception as exc:
        return jsonify(error=str(exc)), 502


# ---------------- static frontend ----------------
@app.get("/")
def root():
    return send_from_directory(BASE, "index.html")


@app.get("/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE, filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # ต้อง bind ทุก interface ไม่ใช่แค่ 127.0.0.1 ไม่งั้น MikroTik ในวง LAN
    # ยิงสถานะเข้ามาไม่ได้เลย (connection refused) — สถานะบนเว็บจึงไม่เคยเปลี่ยน
    host = os.environ.get("HOST", "0.0.0.0")
    ip = lan_ip()
    print(f"* NT CCTV Dashboard: http://127.0.0.1:{port}")
    if host == "0.0.0.0":
        print(f"* เปิดจากเครื่องอื่น/มือถือในวง LAN: http://{ip}:{port}")
        print(f"* URL ที่ MikroTik ต้องยิงเข้ามา: http://{ip}:{port}/status/mikrotik.php?id=<ID>&status=up")
        print(f"* ถ้า MikroTik ยิงแล้วไม่ขึ้น log ข้างล่างนี้ ให้เปิด Windows Firewall ขาเข้า TCP พอร์ต {port}")
    app.run(host=host, port=port, threaded=True)
