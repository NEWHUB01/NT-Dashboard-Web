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
import re
import secrets
import socket
import sys

# คอนโซล Windows บางเครื่องเป็น cp1252 — พิมพ์ข้อความไทยแล้วพัง
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from datetime import datetime, timedelta, timezone
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

# ไม่มีรายงานเข้ามานานเกินกี่นาที = ถือว่าไม่รู้สถานะจริงแล้ว (0 = ปิดการตรวจ)
# ค่าเริ่มต้น 3 = พลาดได้ 3 รอบ เมื่อตั้ง Scheduler ใน MikroTik ไว้ที่ 1 นาที
DEFAULT_STALE_MINUTES = 3

# หมายเลขไอดีอุปกรณ์ที่ผู้ใช้ตั้งเอง — บังคับเป็นตัวเลขล้วน เพราะต้องไปอยู่ใน URL
# ที่ MikroTik ยิงเข้ามา (?id=359) และตารางหน้าเว็บเรียงลำดับด้วยค่าตัวเลข
# ห้ามขึ้นต้นด้วย 0 ไม่งั้น "007" กับ "7" จะกลายเป็นคนละอุปกรณ์ทั้งที่ยิงมาเลขเดียวกัน
DEVICE_ID_RE = re.compile(r"^[1-9][0-9]{0,8}$")

# คำที่ยอมรับได้ในพารามิเตอร์ status ของ Netwatch (MikroTik ส่ง up/down/unknown)
STATUS_ALIASES = {
    "up": "up", "online": "up", "ok": "up", "1": "up", "true": "up",
    "down": "down", "offline": "down", "0": "down", "false": "down",
    "unknown": "unknown",
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


class StorageError(RuntimeError):
    """เก็บ/อ่านข้อมูลไม่สำเร็จ — แยกจาก error อื่นเพื่อตอบข้อความที่บอกวิธีแก้ได้"""


NO_STORE_HINT = (
    "บันทึกข้อมูลไม่ได้ เพราะโฮสต์นี้เขียนไฟล์ไม่ได้ และยังไม่ได้เชื่อมฐานข้อมูล — "
    "ไปที่ Vercel → แท็บ Storage → Upstash for Redis → Connect "
    "แล้วสั่ง Redeploy อีกครั้ง"
)


def store_load(key, path, default):
    if kv_conn():
        try:
            raw = kv_get(key)
        except requests.RequestException as exc:
            raise StorageError(f"อ่านข้อมูลจาก Redis ไม่ได้: {exc}") from exc
        if not raw:
            return default
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return default
    return load_json(path, default)


def store_save(key, path, data):
    if kv_conn():
        try:
            kv_set(key, json.dumps(data, ensure_ascii=False))
        except requests.RequestException as exc:
            raise StorageError(f"บันทึกข้อมูลลง Redis ไม่ได้: {exc}") from exc
        return
    try:
        save_json(path, data)
    except OSError as exc:
        # เคสหลักบน serverless: ระบบไฟล์ read-only และไม่ได้ตั้ง env var ของ Redis ไว้
        raise StorageError(NO_STORE_HINT) from exc


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


@app.errorhandler(StorageError)
def handle_storage_error(exc):
    # เดิมจะกลายเป็น 500 เปล่าๆ ทำให้หน้าเว็บบอกได้แค่ "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้"
    print(f"* storage error: {exc}", flush=True)
    return jsonify(error=str(exc)), 503


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


# ---------------- สรุปยอดรายหมวด ----------------
@app.get("/api/status")
@login_required
def api_status():
    """ยอดรวมรายหมวด นับจากทะเบียนอุปกรณ์ที่ MikroTik รายงานเข้ามา"""
    limit = stale_limit(load_config())
    now = datetime.now(timezone.utc)
    counts = {k: {"up": 0, "down": 0, "unknown": 0} for k in CATEGORY_KEYS}
    for dev in load_devices()["devices"].values():
        cat = dev.get("category")
        if cat in counts:
            counts[cat][effective_status(dev, limit, now)] += 1
    return jsonify(data=counts, stale_minutes=limit)


# ---------------- device registry + MikroTik Netwatch ----------------
def load_devices():
    store = store_load(DEVICES_KEY, DEVICES_FILE, {"next_id": 1, "devices": {}})
    store.setdefault("next_id", 1)
    store.setdefault("devices", {})
    return store


def save_devices(store):
    store_save(DEVICES_KEY, DEVICES_FILE, store)


def stale_limit(cfg):
    """เพดานเวลาที่ยอมให้เงียบได้ (นาที) — 0 คือปิดการตรวจ"""
    try:
        return max(0, int(cfg.get("stale_minutes", DEFAULT_STALE_MINUTES)))
    except (TypeError, ValueError):
        return DEFAULT_STALE_MINUTES


def quiet_minutes(dev, now):
    """เงียบมานานกี่นาทีแล้วนับจากรายงานครั้งล่าสุด — คิดฝั่งเซิร์ฟเวอร์ที่เดียว
    เพื่อให้ตัวเลขบนการ์ดกับที่แสดงในตารางมาจากการคำนวณชุดเดียวกันเสมอ
    และไม่พึ่งนาฬิกาของเครื่องที่เปิดดูซึ่งอาจตั้งเวลาไว้ไม่ตรง"""
    if not dev.get("last_seen"):
        return None
    try:
        seen = datetime.fromisoformat(dev["last_seen"])
    except ValueError:
        return None
    if seen.tzinfo is None:
        # ข้อมูลที่บันทึกไว้ก่อนเปลี่ยนมาเก็บพร้อม offset — ตอนนั้นเป็นเวลาท้องถิ่นของเซิร์ฟเวอร์
        seen = seen.astimezone()
    return max(0, int((now - seen).total_seconds() // 60))


def is_stale(dev, limit_min, now):
    """เงียบเกินเพดาน = MikroTik ดับ / เน็ตขาด / สคริปต์หาย — ไม่ใช่ว่าอุปกรณ์ยังปกติดี
    ใช้ได้ต่อเมื่อมีสคริปต์ Scheduler คอยยิงสถานะซ้ำเป็นระยะ ไม่งั้นอุปกรณ์ที่ปกติดี
    จะไม่มีรายงานเข้ามาเลยหลังครั้งแรก แล้วโดนตีเป็นขาดการติดต่อทั้งที่ไม่มีอะไรผิด"""
    if not limit_min:
        return False
    quiet = quiet_minutes(dev, now)
    return quiet is not None and quiet >= limit_min


def effective_status(dev, limit_min, now):
    """สถานะที่ใช้นับจริง — เงียบนานเกินไปให้ตกไปเป็น unknown ไม่ว่าค่าล่าสุดจะเป็นอะไร"""
    status = dev.get("status")
    if status not in ("up", "down"):
        return "unknown"
    return "unknown" if is_stale(dev, limit_min, now) else status


def parse_coord(raw_lat, raw_lng):
    """จุดพิกัดที่ปักหมุดจากหน้าเว็บ — ต้องมาเป็นคู่เสมอ ถ้าเว้นว่างทั้งคู่คือไม่ระบุ"""
    s_lat = ("" if raw_lat is None else str(raw_lat)).strip()
    s_lng = ("" if raw_lng is None else str(raw_lng)).strip()
    if not s_lat and not s_lng:
        return None, None
    try:
        lat, lng = float(s_lat), float(s_lng)
    except ValueError:
        raise ValueError("จุดพิกัดต้องเป็นตัวเลข เช่น 13.736717, 100.523186")
    if not -90 <= lat <= 90 or not -180 <= lng <= 180:
        raise ValueError("จุดพิกัดอยู่นอกช่วงที่เป็นไปได้")
    # 6 ตำแหน่ง = ละเอียดระดับ 0.1 เมตร พอเกินพอสำหรับปักหมุดอุปกรณ์
    return round(lat, 6), round(lng, 6)


def device_fields(data):
    """ฟิลด์ที่หน้าเว็บแก้ได้ — ใช้ร่วมกันทั้งตอนเพิ่มและตอนแก้ไข
    คืน (ค่าที่ตรวจแล้ว, ข้อความ error) โดย error เป็น None ถ้าผ่าน"""
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "").strip()
    if not name or category not in CATEGORY_KEYS:
        return None, "กรุณากรอกชื่อและเลือกหมวดอุปกรณ์"
    try:
        lat, lng = parse_coord(data.get("lat"), data.get("lng"))
    except ValueError as exc:
        return None, str(exc)
    return {
        "name": name,
        "category": category,
        "ip": (data.get("ip") or "").strip(),
        "circuit": (data.get("circuit") or "").strip(),
        "lat": lat,
        "lng": lng,
    }, None


def check_new_id(raw, store):
    """ตรวจหมายเลขไอดีที่ผู้ใช้ตั้งเอง คืน (id, error)"""
    dev_id = (raw or "").strip()
    if not DEVICE_ID_RE.match(dev_id):
        return None, "หมายเลขไอดีต้องเป็นตัวเลขล้วน 1-999999999 (ห้ามขึ้นต้นด้วย 0)"
    if dev_id in store["devices"]:
        return None, f"หมายเลขไอดี {dev_id} ถูกใช้กับอุปกรณ์อื่นแล้ว"
    return dev_id, None


def bump_next_id(store, dev_id):
    """กัน id ที่ระบบแจกอัตโนมัติไปชนกับ id ที่ผู้ใช้ตั้งเองไว้ล่วงหน้า"""
    store["next_id"] = max(store.get("next_id", 1), int(dev_id) + 1)


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
    # เก็บเป็น UTC พร้อม offset ติดไปด้วย — โฮสต์จริงมักรันเป็น UTC (Vercel ก็ใช่)
    # ถ้าเก็บแบบไม่มี timezone หน้าเว็บจะเอาไปโชว์ดิบๆ แล้วคนดูที่ไทยเห็นเวลาย้อนไป 7 ชั่วโมง
    dev["last_seen"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
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
    storage = "redis" if kv_conn() else "file"
    if hostname not in ("127.0.0.1", "localhost", "::1"):
        proto = request.headers.get("X-Forwarded-Proto", request.scheme)
        return jsonify(base_url=f"{proto}://{host}", lan_ip=None,
                       push_token=push_token(), storage=storage)
    port = host.rsplit(":", 1)[1] if ":" in host else os.environ.get("PORT", "8000")
    ip = lan_ip()
    return jsonify(base_url=f"http://{ip}:{port}", lan_ip=ip,
                   push_token=push_token(), storage=storage)


@app.get("/api/devices")
@login_required
def api_devices():
    store = load_devices()
    def order(kv):
        # id ปกติเป็นตัวเลข แต่กันข้อมูลเก่าที่อาจไม่ใช่ ไม่ให้ทั้งหน้าพังเพราะ int() ระเบิด
        return (0, int(kv[0]), "") if kv[0].isdigit() else (1, 0, kv[0])

    limit = stale_limit(load_config())
    now = datetime.now(timezone.utc)
    devices = [
        {"id": k, **v, "quiet_min": quiet_minutes(v, now), "stale": is_stale(v, limit, now)}
        for k, v in sorted(store["devices"].items(), key=order)
    ]
    return jsonify(devices=devices, stale_minutes=limit)


@app.post("/api/devices")
@login_required
def api_add_device():
    data = request.get_json(silent=True) or {}
    fields, err = device_fields(data)
    if err:
        return jsonify(error=err), 400
    store = load_devices()

    raw_id = (data.get("id") or "").strip()
    if raw_id:                       # ผู้ใช้ตั้งหมายเลขไอดีเอง (ให้ตรงกับทะเบียนที่มีอยู่แล้ว)
        dev_id, err = check_new_id(raw_id, store)
        if err:
            return jsonify(error=err), 400
    else:                            # เว้นว่าง = ให้ระบบแจกให้
        dev_id = str(store["next_id"])
        while dev_id in store["devices"]:
            store["next_id"] += 1
            dev_id = str(store["next_id"])

    bump_next_id(store, dev_id)
    store["devices"][dev_id] = {**fields, "status": None, "last_seen": None}
    save_devices(store)
    return jsonify(ok=True, id=dev_id)


@app.put("/api/devices/<dev_id>")
@login_required
def api_edit_device(dev_id):
    """แก้ข้อมูลอุปกรณ์ — สถานะกับเวลารายงานล่าสุดไม่แตะ เพราะเป็นของที่ MikroTik ยิงเข้ามา
    เปลี่ยนหมายเลขไอดีได้ด้วย แต่ต้องไปแก้สคริปต์ใน MikroTik ตามให้ตรงกัน"""
    data = request.get_json(silent=True) or {}
    fields, err = device_fields(data)
    if err:
        return jsonify(error=err), 400
    store = load_devices()
    dev = store["devices"].get(dev_id)
    if not dev:
        return jsonify(error="not found"), 404

    new_id = (data.get("id") or dev_id).strip()
    if new_id != dev_id:
        new_id, err = check_new_id(new_id, store)
        if err:
            return jsonify(error=err), 400

    dev.update(fields)
    if new_id != dev_id:
        del store["devices"][dev_id]
        store["devices"][new_id] = dev
        bump_next_id(store, new_id)
    save_devices(store)
    return jsonify(ok=True, id=new_id)


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
    return jsonify(staleMinutes=stale_limit(load_config()))


@app.post("/api/config")
@login_required
def api_set_config():
    data = request.get_json(silent=True) or {}
    cfg = load_config()
    # แก้เฉพาะตอนที่ส่งมาจริง ไม่งั้นหน้าที่ไม่รู้จักฟิลด์นี้จะเผลอล้างค่าทิ้ง
    if "staleMinutes" in data:
        try:
            cfg["stale_minutes"] = max(0, min(1440, int(data.get("staleMinutes") or 0)))
        except (TypeError, ValueError):
            return jsonify(error="เวลาที่ยอมให้ขาดการติดต่อต้องเป็นตัวเลข (นาที)"), 400
    # เก็บตกค่าของโหมดดึงจาก API ภายนอกที่เลิกใช้แล้ว — api_key เป็นความลับ ไม่ควรค้างไว้
    cfg.pop("api_url", None)
    cfg.pop("api_key", None)
    save_config(cfg)
    return jsonify(ok=True)


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
