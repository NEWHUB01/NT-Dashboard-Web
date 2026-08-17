# NT CCTV Dashboard

แดชบอร์ดแสดงสถานะอุปกรณ์ CCTV (เครื่องบันทึก / กล้อง / เครื่องส่ง / เครื่องรับ / Router / Access Point)
โดยรับสถานะ up/down ที่ MikroTik Netwatch ยิงเข้ามา

## ติดตั้งและรัน

```bash
pip install -r requirements.txt
python server.py
```

ค่าเริ่มต้นเปิดที่พอร์ต 8000 และ bind `0.0.0.0` เพื่อให้ MikroTik ในวง LAN ยิงสถานะเข้ามาได้
ตอนเปิดจะพิมพ์ IP ของเครื่องในวง LAN และ URL ที่ต้องใช้กับ MikroTik ออกมาให้

| ตัวแปร | ค่าเริ่มต้น | ใช้ทำอะไร |
|---|---|---|
| `PORT` | `8000` | พอร์ตที่เปิด |
| `HOST` | `0.0.0.0` | ใส่ `127.0.0.1` ถ้าต้องการรับเฉพาะในเครื่อง (MikroTik จะยิงเข้าไม่ได้) |
| `SECRET_KEY` | สร้างอัตโนมัติลง `config.json` | คีย์เซ็น session cookie — ใช้บนโฮสต์ที่เขียนไฟล์ไม่ได้ |

ผู้ใช้เริ่มต้นคือ `admin` / `admin` — เปลี่ยนทันทีด้วย `python manage.py passwd admin`

## ตั้งค่า MikroTik Netwatch

1. เพิ่มอุปกรณ์ในหน้า **อุปกรณ์** แล้วกดปุ่ม **โค้ด** จะได้สคริปต์ที่ใส่ IP เซิร์ฟเวอร์ให้เรียบร้อย
2. MikroTik → Tools → Netwatch → Host = IP อุปกรณ์ แล้ววางสคริปต์ในแท็บ **Up** และ **Down**
3. เพิ่มสคริปต์ **Scheduler** (System → Scheduler, interval 1m) ด้วย — สคริปต์ Up/Down ทำงาน
   เฉพาะตอนสถานะ*เปลี่ยน* ถ้าอุปกรณ์ up อยู่ก่อนแล้วจะไม่มีการรายงานเข้ามาเลย
4. เปิดไฟร์วอลล์ขาเข้า TCP พอร์ต 8000 บนเครื่องเซิร์ฟเวอร์

ตรวจว่าใช้ได้จริงโดยดูคอนโซลที่รัน `server.py` — ทุกครั้งที่ MikroTik ยิงเข้ามาจะขึ้นบรรทัด
`* netwatch <IP>: id=3 (NVR) -> up` ถ้าไม่ขึ้นเลยแปลว่าติดที่เน็ตเวิร์ก/ไฟร์วอลล์

## ไฟล์ที่ไม่ถูก commit

`config.json` (secret key + api key), `users.json` (hash รหัสผ่าน) และ `devices.json`
(ชื่อสถานที่ + IP ภายใน) อยู่ใน `.gitignore` — เซิร์ฟเวอร์สร้างให้เองตอนรันครั้งแรก

## ที่เก็บข้อมูล

แอปเลือกที่เก็บข้อมูลเองอัตโนมัติ:

- **ไม่ตั้ง env var ของ Redis** → เก็บลงไฟล์ `devices.json` / `config.json` (โหมดรันเองในวง LAN)
- **ตั้ง `KV_REST_API_URL` + `KV_REST_API_TOKEN`** → เก็บลง Redis ผ่าน REST API
  (จำเป็นบน serverless เพราะระบบไฟล์เขียนไม่ได้ และแต่ละ request อาจอยู่คนละ instance)

## deploy ขึ้น Vercel

1. สร้าง Redis store: หน้าโปรเจกต์บน Vercel → **Storage** → **Upstash for Redis** → Connect
   Vercel จะใส่ `KV_REST_API_URL` และ `KV_REST_API_TOKEN` ให้เอง
2. ตั้ง environment variable ที่เหลือใน **Settings → Environment Variables**

   | ตัวแปร | ค่า |
   |---|---|
   | `SECRET_KEY` | สุ่มมา เช่น `python -c "import secrets;print(secrets.token_hex(32))"` |
   | `USERS_JSON` | ผลลัพธ์จาก `python manage.py hash admin <รหัสผ่าน>` |
   | `PUSH_TOKEN` | รหัสลับสำหรับ MikroTik เช่น `python -c "import secrets;print(secrets.token_urlsafe(24))"` |

3. Deploy แล้วเข้าหน้า **อุปกรณ์** กดปุ่ม **โค้ด** — สคริปต์ที่ได้จะใส่โดเมน Vercel
   และ `&token=...` ให้เรียบร้อย เอาไปวางใน MikroTik ได้เลย

MikroTik ต้องออกอินเทอร์เน็ตได้เพื่อยิงสถานะขึ้นโดเมน Vercel

**สำคัญ:** ถ้าไม่ตั้ง `PUSH_TOKEN` ใครที่รู้ URL ก็ตั้งสถานะอุปกรณ์ได้ เพราะ `/status/mikrotik.php`
ไม่มีการล็อกอิน (MikroTik ล็อกอินไม่ได้) — ในวง LAN ปิดพอรับได้ แต่บนอินเทอร์เน็ต **ต้องตั้ง**

โฮสต์แบบรัน process ค้างได้ (Railway / Render / Fly.io / VPS) ก็ใช้ได้เหมือนกัน
และไม่ต้องมี Redis ถ้าดิสก์เขียนได้
