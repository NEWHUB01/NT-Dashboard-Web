/* NT CCTV Dashboard — Service Worker (แบบเรียบง่าย)
 * - cache ไฟล์หน้าเว็บ (shell) ไว้ให้เปิดเร็ว/เปิด offline ได้
 * - /api/* ไม่ cache เด็ดขาด (ข้อมูลสด + เรื่อง auth)
 * - อัปเดตเวอร์ชัน CACHE_NAME ทุกครั้งที่แก้ไฟล์หน้าเว็บ เพื่อล้าง cache เก่า
 */
const CACHE_NAME = "ntcctv-shell-v4";

const SHELL = [
  "/",
  "/index.html",
  "/dashboard.html",
  "/devices.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // API และ request ข้ามโดเมน (ฟอนต์/ไอคอน CDN) → วิ่งตรงเน็ตเวิร์กเสมอ
  if (url.pathname.startsWith("/api/") || url.origin !== self.location.origin || event.request.method !== "GET") {
    return; // ปล่อยให้เบราว์เซอร์จัดการเอง
  }

  // ไฟล์หน้าเว็บ: network-first (ได้ของใหม่เสมอ) ถ้าออฟไลน์ค่อยใช้ cache
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
