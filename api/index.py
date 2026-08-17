"""จุดเข้าสำหรับ Vercel (Python serverless function)

Vercel จะมองหาตัวแปรชื่อ `app` ที่เป็น WSGI application ในไฟล์นี้
ตัวแอปจริงอยู่ที่ server.py ที่ root ของโปรเจกต์ — ไฟล์นี้แค่ดึงมาใช้ต่อ

ต้องตั้ง environment variable บน Vercel ก่อน ไม่งั้นใช้งานไม่ได้:
  SECRET_KEY          คีย์เซ็น session cookie (สุ่มมาสักชุด)
  USERS_JSON          {"admin": "<hash>"}  สร้าง hash: python manage.py hash <รหัสผ่าน>
  KV_REST_API_URL     จาก Upstash Redis / Vercel KV (ได้มาอัตโนมัติถ้าเชื่อม store ในหน้า Vercel)
  KV_REST_API_TOKEN   เช่นกัน
  PUSH_TOKEN          รหัสลับใน URL ที่ MikroTik ต้องแนบมา (จำเป็นเมื่ออยู่บนอินเทอร์เน็ต)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import app  # noqa: E402,F401
