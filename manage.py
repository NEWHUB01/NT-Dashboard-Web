"""จัดการบัญชีผู้ใช้ NT CCTV Dashboard

วิธีใช้:
  python manage.py list                     แสดงรายชื่อผู้ใช้
  python manage.py add <ชื่อ> [รหัสผ่าน]     เพิ่มผู้ใช้ (ไม่ใส่รหัสจะถามแบบซ่อน)
  python manage.py passwd <ชื่อ> [รหัสผ่าน]  เปลี่ยนรหัสผ่าน
  python manage.py del <ชื่อ>               ลบผู้ใช้
  python manage.py hash <ชื่อ> [รหัสผ่าน]    พิมพ์ค่าสำหรับ env var USERS_JSON (ใช้ตอน deploy)
"""
import getpass
import json
import sys
from pathlib import Path

# คอนโซล Windows บางเครื่องเป็น cp1252 — พิมพ์ข้อความไทยแล้วพัง
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from werkzeug.security import generate_password_hash

USERS_FILE = Path(__file__).resolve().parent / "users.json"


def load_users():
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_users(users):
    USERS_FILE.write_text(json.dumps(users, indent=2, ensure_ascii=False), encoding="utf-8")


def ask_password():
    pw = getpass.getpass("รหัสผ่าน: ")
    if not pw:
        sys.exit("ยกเลิก: รหัสผ่านว่าง")
    if pw != getpass.getpass("ยืนยันรหัสผ่าน: "):
        sys.exit("ยกเลิก: รหัสผ่านไม่ตรงกัน")
    return pw


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return

    cmd = args[0]
    users = load_users()

    if cmd == "list":
        if not users:
            print("(ยังไม่มีผู้ใช้)")
        for name in users:
            print("-", name)

    elif cmd == "add" and len(args) >= 2:
        name = args[1]
        if name in users:
            sys.exit(f"มีผู้ใช้ '{name}' อยู่แล้ว (ใช้ passwd เพื่อเปลี่ยนรหัส)")
        pw = args[2] if len(args) >= 3 else ask_password()
        users[name] = generate_password_hash(pw)
        save_users(users)
        print(f"เพิ่มผู้ใช้ '{name}' แล้ว")

    elif cmd == "passwd" and len(args) >= 2:
        name = args[1]
        if name not in users:
            sys.exit(f"ไม่พบผู้ใช้ '{name}'")
        pw = args[2] if len(args) >= 3 else ask_password()
        users[name] = generate_password_hash(pw)
        save_users(users)
        print(f"เปลี่ยนรหัสผ่านของ '{name}' แล้ว")

    elif cmd == "hash" and len(args) >= 2:
        # ไม่แตะ users.json — แค่พิมพ์ JSON ไว้ก๊อปไปใส่ env var บนโฮสต์ที่เขียนไฟล์ไม่ได้
        name = args[1]
        pw = args[2] if len(args) >= 3 else ask_password()
        print("ใส่ค่านี้ใน environment variable ชื่อ USERS_JSON:")
        print(json.dumps({name: generate_password_hash(pw)}, ensure_ascii=False))

    elif cmd == "del" and len(args) >= 2:
        name = args[1]
        if name not in users:
            sys.exit(f"ไม่พบผู้ใช้ '{name}'")
        del users[name]
        save_users(users)
        print(f"ลบผู้ใช้ '{name}' แล้ว")

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
