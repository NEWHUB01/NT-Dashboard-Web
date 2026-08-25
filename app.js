(() => {
  "use strict";

  // NOTE: flag นี้เป็นแค่ตัวช่วย UX (redirect เร็วๆ) — การยืนยันตัวตนจริง
  // อยู่ที่ session cookie (HttpOnly) ฝั่งเซิร์ฟเวอร์ ซึ่ง JS อ่าน/ปลอมไม่ได้
  const LS_UI_AUTH = "ntcctv_auth";
  const LS_AUTO_REFRESH = "ntcctv_auto_refresh";

  const $ = (sel) => document.querySelector(sel);

  function uiLoggedIn() {
    return localStorage.getItem(LS_UI_AUTH) === "1" || sessionStorage.getItem(LS_UI_AUTH) === "1";
  }
  function clearUiAuth() {
    localStorage.removeItem(LS_UI_AUTH);
    sessionStorage.removeItem(LS_UI_AUTH);
  }

  // fetch wrapper: แนบ cookie + ถ้า session หมดอายุ (401) เด้งกลับหน้า login
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
    if (res.status === 401) {
      clearUiAuth();
      window.location.href = "index.html";
      throw new Error("unauthorized");
    }
    return res;
  }

  // ---------------------------------------------------------------
  // DEVICE HELPERS (ใช้ร่วมกันทั้งหน้า Dashboard และหน้าอุปกรณ์)
  // ---------------------------------------------------------------
  const CATEGORY_TITLES = {
    recorder: "เครื่องบันทึก",
    camera: "กล้อง CCTV",
    transmitter: "เครื่องส่ง",
    receiver: "เครื่องรับ",
    router: "Router",
    accesspoint: "Access Point",
  };

  const STATUS_LABEL = { up: "UP", down: "DOWN", unknown: "ยังไม่รายงาน" };

  const COORD_ERROR = 'จุดพิกัดต้องเป็น "ละติจูด, ลองจิจูด" เช่น 13.736717, 100.523186';

  // status เป็น null = ยังไม่เคยมีรายงานเข้ามา — นับเป็น unknown เหมือนที่เซิร์ฟเวอร์นับ
  function devStatus(dev) {
    return dev.status === "up" ? "up" : dev.status === "down" ? "down" : "unknown";
  }

  function statusBadge(dev) {
    const s = devStatus(dev);
    return `<span class="dev-status ${s}">${STATUS_LABEL[s]}</span>`;
  }

  function hasCoord(dev) {
    return dev.lat !== null && dev.lat !== undefined && dev.lng !== null && dev.lng !== undefined;
  }

  function coordText(dev) {
    return hasCoord(dev) ? `${dev.lat}, ${dev.lng}` : "";
  }

  // ช่องกรอกพิกัดรับเป็น "lat, lng" ช่องเดียว — คืน null ถ้ารูปแบบไม่ถูก
  function parseCoordInput(text) {
    const raw = (text || "").trim();
    if (!raw) return { lat: "", lng: "" };
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2 || parts.some((n) => n === "" || !isFinite(Number(n)))) return null;
    return { lat: Number(parts[0]), lng: Number(parts[1]) };
  }

  function mapsUrl(dev) {
    return `https://www.google.com/maps?q=${dev.lat},${dev.lng}`;
  }

  // textContent ทุกช่อง เพราะเป็นข้อมูลที่ผู้ใช้กรอกเอง (กัน XSS)
  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text || "-";
    if (className) td.className = className;
    return td;
  }

  // ช่องพิกัดในตาราง: ลิงก์ออก Google Maps เพื่อให้กดนำทางไปหน้างานได้เลย
  function coordCell(dev) {
    if (!hasCoord(dev)) return cell("", "dev-seen");
    const td = document.createElement("td");
    const a = document.createElement("a");
    a.className = "dev-map";
    a.href = mapsUrl(dev);
    a.target = "_blank";
    a.rel = "noopener";
    a.title = coordText(dev);
    a.innerHTML = `<i class="fa-solid fa-location-dot"></i> แผนที่`;
    td.appendChild(a);
    return td;
  }

  function seenText(dev) {
    return dev.last_seen ? dev.last_seen.replace("T", " ") : "-";
  }

  // ---------------------------------------------------------------
  // LOGIN PAGE (index.html)
  // ---------------------------------------------------------------
  const loginForm = $("#loginForm");
  if (loginForm) {
    const loginError = $("#loginError");
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError.textContent = "";
      const username = $("#loginUser").value.trim();
      const password = $("#loginPass").value;
      const remember = $("#loginRemember").checked;

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ username, password, remember }),
        });
        if (res.ok) {
          const store = remember ? localStorage : sessionStorage;
          store.setItem(LS_UI_AUTH, "1");
          window.location.href = "dashboard.html";
        } else if (res.status === 401) {
          loginError.textContent = "ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง";
        } else {
          loginError.textContent = "เซิร์ฟเวอร์ไม่พร้อมใช้งาน (ต้องรันด้วย python server.py)";
        }
      } catch {
        loginError.textContent = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ต้องรันด้วย python server.py)";
      }
    });
  }

  // ---------------------------------------------------------------
  // DASHBOARD PAGE (dashboard.html)
  // ---------------------------------------------------------------
  const appScreen = $("#appScreen");
  if (appScreen) {
    if (!uiLoggedIn()) {
      window.location.href = "index.html";
    } else {
      initDashboard();
    }
  }

  function initDashboard() {
    const CATEGORIES = [
      { key: "recorder",    title: "เครื่องบันทึก", icon: "fa-video",           accent: "blue"  },
      { key: "camera",      title: "กล้อง CCTV",    icon: "fa-camera",          accent: "green" },
      { key: "transmitter", title: "เครื่องส่ง",     icon: "fa-tower-broadcast", accent: "blue"  },
      { key: "receiver",    title: "เครื่องรับ",     icon: "fa-play",            accent: "green" },
      { key: "router",      title: "ROUTER",        icon: "fa-microchip",       accent: "blue"  },
      { key: "accesspoint", title: "ACCESS POINT",  icon: "fa-wifi",            accent: "green" },
    ];

    // alias keys the aggregator will recognize in raw API responses
    const ALIASES = {
      recorder:    ["recorder", "nvr", "dvr", "เครื่องบันทึก"],
      camera:      ["camera", "cctv", "กล้อง", "กล้องcctv"],
      transmitter: ["transmitter", "tx", "เครื่องส่ง"],
      receiver:    ["receiver", "rx", "เครื่องรับ"],
      router:      ["router"],
      accesspoint: ["accesspoint", "access_point", "ap"],
    };

    let dashboardData = {};
    // รายอุปกรณ์จากทะเบียน — ใช้ตอนกดการ์ด/กระดิ่งเพื่อดูว่า down ตัวไหน ที่ไหน
    let deviceList = [];
    let autoRefreshTimer = null;
    let lastUpdatedAt = null;

    // ค่าเริ่มต้น = เปิด (ต้องปิดเองถึงจะหยุด) ไม่งั้นการ์ดจะค้างสถานะเดิม
    // จนกว่าจะกด refresh หน้าเว็บเอง ทั้งที่อุปกรณ์รายงานเข้ามาแล้ว
    const autoRefreshOn = () => localStorage.getItem(LS_AUTO_REFRESH) !== "0";

    // -------- sidebar --------
    $("#collapseBtn").addEventListener("click", () => {
      $("#sidebar").classList.toggle("collapsed");
    });
    $("#navLogout").addEventListener("click", (e) => {
      e.preventDefault();
      logout();
    });

    async function logout() {
      try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch {}
      clearUiAuth();
      window.location.href = "index.html";
    }

    // -------- cards --------
    function renderCards() {
      const grid = $("#cardsGrid");
      grid.innerHTML = "";
      CATEGORIES.forEach((cat) => {
        const stats = dashboardData[cat.key] || { up: 0, down: 0, unknown: 0 };
        const card = document.createElement("div");
        card.className = "card" + (cat.accent === "green" ? " accent-green" : "");
        card.innerHTML = `
          <div class="card-info">
            <div class="card-title">${cat.title}</div>
            <div class="card-stats">
              <button type="button" class="stat up" data-cat="${cat.key}" data-status="up" title="ดูรายการอุปกรณ์">
                <span class="stat-label">UP</span>
                <span class="stat-value">${stats.up} ตัว</span>
              </button>
              <button type="button" class="stat down" data-cat="${cat.key}" data-status="down" title="ดูรายการอุปกรณ์">
                <span class="stat-label">DOWN</span>
                <span class="stat-value">${stats.down} ตัว</span>
              </button>
              <button type="button" class="stat unknown" data-cat="${cat.key}" data-status="unknown" title="ดูรายการอุปกรณ์">
                <span class="stat-label">UNKNOWN</span>
                <span class="stat-value">${stats.unknown} ตัว</span>
              </button>
            </div>
          </div>
          <div class="card-icon"><i class="fa-solid ${cat.icon}"></i></div>
        `;
        grid.appendChild(card);
      });

      const totalDown = CATEGORIES.reduce((sum, c) => sum + ((dashboardData[c.key] || {}).down || 0), 0);
      $("#alertBadge").textContent = totalDown;
      renderNotifPanel();
      applySearchFilter();
    }

    // -------- device detail (กดจากการ์ด) --------
    const detailModal = $("#detailModal");

    function devicesIn(catKey, status) {
      return deviceList.filter((d) => d.category === catKey && (!status || devStatus(d) === status));
    }

    // การ์ดถูกวาดใหม่ทุกรอบ refresh — ผูก listener ที่ grid ทีเดียวแทนผูกรายปุ่ม
    $("#cardsGrid").addEventListener("click", (e) => {
      const btn = e.target.closest(".stat");
      if (btn) openDetail(btn.dataset.cat, btn.dataset.status);
    });

    function openDetail(catKey, status) {
      const cat = CATEGORIES.find((c) => c.key === catKey);
      $("#detailTitle").textContent =
        `${cat ? cat.title : catKey} — ${STATUS_LABEL[status] || "ทั้งหมด"}`;

      const tbody = $("#detailRows");
      tbody.innerHTML = "";
      const list = deviceList.length ? devicesIn(catKey, status) : [];

      if (!deviceList.length) {
        // โหมด API ภายนอก/ตัวอย่าง — มีแต่ยอดรวม ไม่มีข้อมูลรายตัวให้แสดง
        tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">ตัวเลขชุดนี้ไม่ได้มาจากทะเบียนอุปกรณ์ จึงดูรายตัวไม่ได้ — เพิ่มอุปกรณ์ในหน้า “อุปกรณ์” ก่อน</td></tr>`;
      } else if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">ไม่มีอุปกรณ์ในกลุ่มนี้</td></tr>`;
      } else {
        list.forEach((dev) => {
          const tr = document.createElement("tr");
          const tdStatus = document.createElement("td");
          tdStatus.innerHTML = statusBadge(dev);
          tr.append(
            cell(dev.id, "dev-id"),
            cell(dev.name),
            cell(dev.circuit),
            cell(dev.ip),
            coordCell(dev),
            tdStatus,
            cell(seenText(dev), "dev-seen"),
          );
          tbody.appendChild(tr);
        });
      }
      detailModal.hidden = false;
    }

    $("#detailClose").addEventListener("click", () => { detailModal.hidden = true; });
    detailModal.addEventListener("click", (e) => {
      if (e.target === detailModal) detailModal.hidden = true;
    });

    // -------- notification bell --------
    const notifPanel = $("#notifPanel");
    // จำว่าหมวดไหนกางอยู่ ไม่งั้นพอ refresh ทุก 15 วิ รายการที่เพิ่งกางจะหุบเอง
    const notifOpen = new Set();

    function renderNotifPanel() {
      const list = $("#notifList");
      list.innerHTML = "";
      const downCats = CATEGORIES.filter((c) => (dashboardData[c.key] || {}).down > 0);

      if (downCats.length === 0) {
        list.innerHTML = `<li class="notif-empty">ไม่มีอุปกรณ์ที่มีปัญหา</li>`;
      } else {
        downCats.forEach((cat) => {
          const li = document.createElement("li");
          li.className = "notif-group";

          const head = document.createElement("button");
          head.type = "button";
          head.className = "notif-item";
          head.innerHTML = `
            <span class="notif-dot"></span>
            <span class="notif-name">${cat.title}</span>
            <span class="notif-count">${dashboardData[cat.key].down} ตัว</span>
            <i class="fa-solid fa-chevron-down notif-chevron"></i>
          `;

          const sub = document.createElement("ul");
          sub.className = "notif-sub";
          const open = notifOpen.has(cat.key);
          sub.hidden = !open;
          head.classList.toggle("open", open);
          if (open) fillNotifSub(sub, cat.key);

          head.addEventListener("click", () => {
            const nowOpen = !notifOpen.has(cat.key);
            if (nowOpen) notifOpen.add(cat.key); else notifOpen.delete(cat.key);
            sub.hidden = !nowOpen;
            head.classList.toggle("open", nowOpen);
            if (nowOpen) fillNotifSub(sub, cat.key);
          });

          li.append(head, sub);
          list.appendChild(li);
        });
      }

      $("#notifUpdatedAt").textContent = "อัปเดตล่าสุด: " + (lastUpdatedAt
        ? lastUpdatedAt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
        : "-");
    }

    function fillNotifSub(ul, catKey) {
      ul.innerHTML = "";
      const list = devicesIn(catKey, "down");
      if (!list.length) {
        const li = document.createElement("li");
        li.className = "notif-sub-empty";
        li.textContent = "ตัวเลขชุดนี้มาจาก API ภายนอก จึงดูรายตัวไม่ได้";
        ul.appendChild(li);
        return;
      }
      list.forEach((dev) => {
        const li = document.createElement("li");
        li.className = "notif-sub-item";

        const name = document.createElement("div");
        name.className = "notif-sub-name";
        name.textContent = `${dev.id} · ${dev.name}`;

        const meta = document.createElement("div");
        meta.className = "notif-sub-meta";
        meta.textContent = [
          dev.circuit ? `วงจร ${dev.circuit}` : "",
          dev.ip,
          dev.last_seen ? `ล่าสุด ${seenText(dev)}` : "",
        ].filter(Boolean).join(" · ") || "ยังไม่มีข้อมูลเพิ่มเติม";

        li.append(name, meta);

        if (hasCoord(dev)) {
          const a = document.createElement("a");
          a.className = "notif-sub-map";
          a.href = mapsUrl(dev);
          a.target = "_blank";
          a.rel = "noopener";
          a.innerHTML = `<i class="fa-solid fa-location-dot"></i> ดูบนแผนที่`;
          li.appendChild(a);
        }
        ul.appendChild(li);
      });
    }

    function closeNotifPanel() {
      notifPanel.hidden = true;
    }

    $("#notifBell").addEventListener("click", (e) => {
      e.stopPropagation();
      profileMenu.hidden = true;
      notifPanel.hidden = !notifPanel.hidden;
    });
    notifPanel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", closeNotifPanel);

    $("#notifRefreshBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      fetchDashboardData().catch(() => {});
    });

    // -------- search (filter cards by title) --------
    let searchQuery = "";

    function applySearchFilter() {
      document.querySelectorAll("#cardsGrid .card").forEach((card) => {
        const title = card.querySelector(".card-title").textContent.toLowerCase();
        card.style.display = !searchQuery || title.includes(searchQuery) ? "" : "none";
      });
    }

    $(".search-box input").addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      applySearchFilter();
    });

    // -------- profile menu --------
    const profileMenu = $("#profileMenu");

    $("#profileBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      closeNotifPanel();
      profileMenu.hidden = !profileMenu.hidden;
    });
    profileMenu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { profileMenu.hidden = true; });

    $("#profileLogout").addEventListener("click", logout);

    // แสดงชื่อผู้ใช้จริงจาก session
    api("/api/me").then(async (res) => {
      if (res.ok) {
        const me = await res.json();
        $("#profileMenu .profile-menu-user span").textContent = me.user;
      }
    }).catch(() => {});

    // -------- settings modal --------
    const settingsModal = $("#settingsModal");

    async function openSettings() {
      $("#apiError").textContent = "";
      $("#apiUrl").value = "";
      $("#apiKey").value = "";
      $("#autoRefresh").checked = autoRefreshOn();
      settingsModal.hidden = false;
      try {
        const res = await api("/api/config");
        if (res.ok) {
          const cfg = await res.json();
          $("#apiUrl").value = cfg.url || "";
          $("#apiKey").placeholder = cfg.hasKey
            ? "ตั้งค่าไว้แล้ว (ซ่อนอยู่บนเซิร์ฟเวอร์) — พิมพ์ใหม่เพื่อเปลี่ยน"
            : "ไม่บังคับ";
        }
      } catch {}
    }
    function closeSettings() {
      settingsModal.hidden = true;
    }

    $("#navSettings").addEventListener("click", (e) => {
      e.preventDefault();
      openSettings();
    });
    $("#apiStatus").addEventListener("click", openSettings);
    $("#settingsClose").addEventListener("click", closeSettings);
    settingsModal.addEventListener("click", (e) => {
      if (e.target === settingsModal) closeSettings();
    });

    function updateApiStatus(mode) {
      // mode: "connected" | "devices" | "demo" | "loading" | "error"
      const el = $("#apiStatus");
      el.classList.remove("connected", "demo", "loading", "error");
      if (mode === "connected") {
        el.classList.add("connected");
        el.querySelector("span").textContent = "เชื่อมต่อ API แล้ว";
      } else if (mode === "devices") {
        el.classList.add("connected");
        el.querySelector("span").textContent = "รับสถานะจากอุปกรณ์ (MikroTik Netwatch)";
      } else if (mode === "demo") {
        el.classList.add("demo");
        el.querySelector("span").textContent = "แสดงข้อมูลตัวอย่าง (ยังไม่ได้ตั้งค่า API)";
      } else if (mode === "loading") {
        el.classList.add("loading");
        el.querySelector("span").textContent = "กำลังดึงข้อมูล...";
      } else {
        el.classList.add("error");
        el.querySelector("span").textContent = "เชื่อมต่อ API ไม่สำเร็จ";
      }
    }

    function startAutoRefresh() {
      stopAutoRefresh();
      autoRefreshTimer = setInterval(() => {
        fetchDashboardData().catch(() => {});
      }, 15000);
    }
    function stopAutoRefresh() {
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }

    $("#apiTestBtn").addEventListener("click", async () => {
      const errEl = $("#apiError");
      errEl.style.color = "";
      errEl.textContent = "กำลังทดสอบ...";
      try {
        const res = await api("/api/config/test", {
          method: "POST",
          body: JSON.stringify({
            url: $("#apiUrl").value.trim(),
            key: $("#apiKey").value.trim(),
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          errEl.style.color = "#22b573";
          errEl.textContent = "เชื่อมต่อสำเร็จ";
        } else {
          errEl.textContent = "เชื่อมต่อไม่สำเร็จ: " + (j.error || "HTTP " + res.status);
        }
      } catch (err) {
        if (err.message !== "unauthorized") errEl.textContent = "เชื่อมต่อไม่สำเร็จ";
      }
    });

    $("#apiSaveBtn").addEventListener("click", async () => {
      const errEl = $("#apiError");
      errEl.style.color = "";
      errEl.textContent = "กำลังบันทึก...";
      try {
        const res = await api("/api/config", {
          method: "POST",
          body: JSON.stringify({
            url: $("#apiUrl").value.trim(),
            key: $("#apiKey").value.trim(),
          }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);

        localStorage.setItem(LS_AUTO_REFRESH, $("#autoRefresh").checked ? "1" : "0");
        if ($("#autoRefresh").checked) startAutoRefresh(); else stopAutoRefresh();

        await fetchDashboardData();
        errEl.style.color = "#22b573";
        errEl.textContent = "บันทึกและดึงข้อมูลสำเร็จ";
        setTimeout(closeSettings, 700);
      } catch (err) {
        if (err.message !== "unauthorized") {
          errEl.textContent = "บันทึกค่าไว้แล้ว แต่ดึงข้อมูลไม่สำเร็จ";
        }
      }
    });

    // -------- fetch + aggregation --------
    async function fetchDashboardData() {
      updateApiStatus("loading");
      try {
        const res = await api("/api/status");
        if (!res.ok) throw new Error("HTTP " + res.status);
        const payload = await res.json();

        // ยอดบนการ์ดนับมาจากทะเบียนอุปกรณ์เมื่อ source === "devices" เท่านั้น
        // โหมดอื่น (API ภายนอก/ตัวอย่าง) มีแต่ยอดรวม จึงไม่มีรายตัวให้กดดู
        deviceList = payload.source === "devices" ? await fetchDeviceList() : [];

        lastUpdatedAt = new Date();
        dashboardData = normalizeData(payload.data);
        renderCards();
        updateApiStatus(
          payload.source === "api" ? "connected"
          : payload.source === "devices" ? "devices"
          : "demo"
        );
      } catch (err) {
        if (err.message !== "unauthorized") updateApiStatus("error");
        throw err;
      }
    }

    async function fetchDeviceList() {
      try {
        const res = await api("/api/devices");
        return res.ok ? (await res.json()).devices : [];
      } catch (err) {
        if (err.message === "unauthorized") throw err;
        return [];   // ดึงรายตัวไม่ได้ก็ยังให้การ์ดแสดงยอดรวมตามปกติ
      }
    }

    function normalizeData(json) {
      const result = {};
      CATEGORIES.forEach((c) => (result[c.key] = { up: 0, down: 0, unknown: 0 }));

      if (Array.isArray(json)) {
        // device-list mode: [{category/type, status}, ...]
        json.forEach((item) => {
          const rawCat = (item.category || item.type || "").toString().toLowerCase();
          const catKey = resolveCategoryKey(rawCat);
          if (!catKey) return;
          const status = (item.status || "").toString().toLowerCase();
          if (status === "up" || status === "online" || status === "ปกติ") result[catKey].up++;
          else if (status === "down" || status === "offline" || status === "ขัดข้อง") result[catKey].down++;
          else result[catKey].unknown++;
        });
        return result;
      }

      if (json && typeof json === "object") {
        // summary mode: { recorder: {up,down,unknown}, ... }
        Object.keys(json).forEach((rawKey) => {
          const catKey = resolveCategoryKey(rawKey.toLowerCase());
          if (!catKey) return;
          const val = json[rawKey] || {};
          result[catKey] = {
            up: Number(val.up ?? val.UP ?? 0) || 0,
            down: Number(val.down ?? val.DOWN ?? 0) || 0,
            unknown: Number(val.unknown ?? val.UNKNOWN ?? 0) || 0,
          };
        });
      }
      return result;
    }

    function resolveCategoryKey(raw) {
      for (const key of Object.keys(ALIASES)) {
        if (ALIASES[key].some((alias) => raw.includes(alias))) return key;
      }
      return null;
    }

    // -------- init --------
    renderCards();
    fetchDashboardData().catch(() => {});
    if (autoRefreshOn()) startAutoRefresh();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) fetchDashboardData().catch(() => {});
    });
  }

  // ---------------------------------------------------------------
  // DEVICES PAGE (devices.html)
  // ---------------------------------------------------------------
  const devicesScreen = $("#devicesScreen");
  if (devicesScreen) {
    if (!uiLoggedIn()) {
      window.location.href = "index.html";
    } else {
      initDevices();
    }
  }

  function initDevices() {
    let devices = [];
    let searchQuery = "";

    // -------- sidebar / profile --------
    $("#collapseBtn").addEventListener("click", () => {
      $("#sidebar").classList.toggle("collapsed");
    });

    async function logout() {
      try { await fetch("/api/logout", { method: "POST", credentials: "same-origin" }); } catch {}
      clearUiAuth();
      window.location.href = "index.html";
    }
    $("#navLogout").addEventListener("click", (e) => { e.preventDefault(); logout(); });
    $("#profileLogout").addEventListener("click", logout);

    const profileMenu = $("#profileMenu");
    $("#profileBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      profileMenu.hidden = !profileMenu.hidden;
    });
    profileMenu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { profileMenu.hidden = true; });

    api("/api/me").then(async (res) => {
      if (res.ok) {
        const me = await res.json();
        $("#profileMenu .profile-menu-user span").textContent = me.user;
      }
    }).catch(() => {});

    // -------- devices table --------
    function renderDevices() {
      const tbody = $("#deviceRows");
      tbody.innerHTML = "";
      const filtered = devices.filter((d) =>
        !searchQuery ||
        d.name.toLowerCase().includes(searchQuery) ||
        (d.circuit || "").toLowerCase().includes(searchQuery) ||
        (CATEGORY_TITLES[d.category] || "").toLowerCase().includes(searchQuery) ||
        (d.ip || "").includes(searchQuery) ||
        d.id === searchQuery
      );

      filtered.forEach((dev) => {
        const tr = document.createElement("tr");

        const tdStatus = document.createElement("td");
        tdStatus.innerHTML = statusBadge(dev);

        const tdActions = document.createElement("td");
        tdActions.className = "dev-actions";
        const editBtn = document.createElement("button");
        editBtn.className = "btn-mini";
        editBtn.innerHTML = `<i class="fa-solid fa-pen-to-square"></i> แก้ไข`;
        editBtn.addEventListener("click", () => openEditModal(dev));
        const codeBtn = document.createElement("button");
        codeBtn.className = "btn-mini";
        codeBtn.innerHTML = `<i class="fa-solid fa-code"></i> โค้ด`;
        codeBtn.addEventListener("click", () => openCodeModal(dev));
        const delBtn = document.createElement("button");
        delBtn.className = "btn-mini danger";
        delBtn.innerHTML = `<i class="fa-solid fa-trash"></i>`;
        delBtn.title = "ลบอุปกรณ์";
        delBtn.addEventListener("click", () => deleteDevice(dev));
        tdActions.append(editBtn, codeBtn, delBtn);

        tr.append(
          cell(dev.id, "dev-id"),
          cell(dev.name),
          cell(dev.circuit),
          cell(CATEGORY_TITLES[dev.category] || dev.category),
          cell(dev.ip),
          coordCell(dev),
          tdStatus,
          cell(seenText(dev), "dev-seen"),
          tdActions,
        );
        tbody.appendChild(tr);
      });

      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="dev-empty">${devices.length === 0 ? "ยังไม่มีอุปกรณ์ — เพิ่มจากฟอร์มด้านบน" : "ไม่พบอุปกรณ์ที่ค้นหา"}</td></tr>`;
      }
      $("#deviceCount").textContent = devices.length;
    }

    async function loadDevices() {
      try {
        const res = await api("/api/devices");
        if (res.ok) {
          devices = (await res.json()).devices;
          renderDevices();
        }
      } catch {}
    }

    $("#deviceSearch").addEventListener("input", (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      renderDevices();
    });

    // -------- add device --------
    $("#deviceForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = $("#deviceError");
      errEl.style.color = "";
      errEl.textContent = "";
      const coord = parseCoordInput($("#devCoord").value);
      if (coord === null) {
        errEl.textContent = COORD_ERROR;
        return;
      }
      try {
        const res = await api("/api/devices", {
          method: "POST",
          body: JSON.stringify({
            id: $("#devId").value.trim(),
            name: $("#devName").value.trim(),
            category: $("#devCategory").value,
            circuit: $("#devCircuit").value.trim(),
            ip: $("#devIp").value.trim(),
            lat: coord.lat,
            lng: coord.lng,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          errEl.style.color = "#22b573";
          errEl.textContent = `เพิ่มแล้ว — ได้เลข ID ${j.id} (กดปุ่มโค้ดในตารางเพื่อ copy ไปใส่ MikroTik)`;
          ["#devId", "#devName", "#devCircuit", "#devIp", "#devCoord"].forEach((sel) => {
            $(sel).value = "";
          });
          await loadDevices();
        } else {
          errEl.textContent = j.error || "เพิ่มไม่สำเร็จ";
        }
      } catch (err) {
        if (err.message !== "unauthorized") errEl.textContent = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
      }
    });

    async function deleteDevice(dev) {
      if (!confirm(`ลบอุปกรณ์ ID ${dev.id} "${dev.name}" ?`)) return;
      try {
        const res = await api(`/api/devices/${dev.id}`, { method: "DELETE" });
        if (res.ok) loadDevices();
      } catch {}
    }

    // -------- แก้ไขอุปกรณ์ --------
    const editModal = $("#editModal");
    let editDev = null;

    function openEditModal(dev) {
      editDev = dev;
      $("#editId").value = dev.id;
      $("#editName").value = dev.name || "";
      $("#editCategory").value = dev.category;
      $("#editCircuit").value = dev.circuit || "";
      $("#editIp").value = dev.ip || "";
      $("#editCoord").value = coordText(dev);
      $("#editError").textContent = "";
      $("#editIdWarn").hidden = true;
      editModal.hidden = false;
    }

    function closeEditModal() {
      editModal.hidden = true;
      editDev = null;
    }

    // เปลี่ยนไอดี = สคริปต์ที่วางไว้ใน MikroTik จะยิงมาด้วยเลขเก่า สถานะจะไม่เข้าอีกเลย
    $("#editId").addEventListener("input", () => {
      $("#editIdWarn").hidden = !editDev || $("#editId").value.trim() === editDev.id;
    });

    $("#editSave").addEventListener("click", async () => {
      if (!editDev) return;
      const errEl = $("#editError");
      errEl.textContent = "";
      const coord = parseCoordInput($("#editCoord").value);
      if (coord === null) {
        errEl.textContent = COORD_ERROR;
        return;
      }
      try {
        const res = await api(`/api/devices/${editDev.id}`, {
          method: "PUT",
          body: JSON.stringify({
            id: $("#editId").value.trim(),
            name: $("#editName").value.trim(),
            category: $("#editCategory").value,
            circuit: $("#editCircuit").value.trim(),
            ip: $("#editIp").value.trim(),
            lat: coord.lat,
            lng: coord.lng,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          closeEditModal();
          await loadDevices();
        } else {
          errEl.textContent = j.error || "บันทึกไม่สำเร็จ";
        }
      } catch (err) {
        if (err.message !== "unauthorized") errEl.textContent = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
      }
    });

    $("#editClose").addEventListener("click", closeEditModal);
    $("#editCancel").addEventListener("click", closeEditModal);
    editModal.addEventListener("click", (e) => {
      if (e.target === editModal) closeEditModal();
    });

    // -------- ปักหมุดบนแผนที่ (Leaflet + OpenStreetMap — ฟรี ไม่ต้องมี API key) --------
    const mapModal = $("#mapModal");
    let leafletMap = null;
    let leafletMarker = null;
    let pinTarget = null;      // ช่องกรอกที่จะเอาพิกัดกลับไปใส่

    document.querySelectorAll("[data-pin]").forEach((btn) => {
      btn.addEventListener("click", () => openMapPicker($("#" + btn.dataset.pin)));
    });

    function openMapPicker(input) {
      pinTarget = input;
      $("#mapSearch").value = "";
      $("#mapResults").hidden = true;
      mapModal.hidden = false;

      if (typeof L === "undefined") {
        // CDN โดนบล็อกหรือเครื่องนี้ออกเน็ตไม่ได้ — ยังพิมพ์พิกัดลงช่องเองได้
        $("#mapHint").innerHTML = "<b>โหลดแผนที่ไม่ได้</b> — เครื่องนี้ต่ออินเทอร์เน็ตไม่ได้ หรือ CDN โดนบล็อก พิมพ์พิกัดลงช่องเองได้เลย";
        $("#mapCoord").textContent = "ยังไม่ได้ปักหมุด";
        return;
      }
      if (!leafletMap) createMap();

      const start = parseCoordInput(input.value);
      const pinned = start !== null && start.lat !== "";
      const view = pinned ? [start.lat, start.lng, 17] : defaultView();
      leafletMap.setView([view[0], view[1]], view[2]);
      setPin(pinned ? [start.lat, start.lng] : null);
      // container เพิ่งถูกแสดง Leaflet ยังวัดขนาดเป็น 0 อยู่ ถ้าไม่สั่งวัดใหม่แผนที่จะเพี้ยน
      setTimeout(() => leafletMap.invalidateSize(), 0);
    }

    function createMap() {
      leafletMap = L.map("mapCanvas");
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(leafletMap);
      leafletMap.on("click", (e) => setPin([e.latlng.lat, e.latlng.lng]));
    }

    function defaultView() {
      // เริ่มที่อุปกรณ์ตัวแรกที่เคยปักหมุดไว้ — ปกติอยู่พื้นที่เดียวกัน จะได้ไม่ต้องซูมหาใหม่ทุกครั้ง
      const ref = devices.find(hasCoord);
      return ref ? [ref.lat, ref.lng, 15] : [13.7563, 100.5018, 6];
    }

    function setPin(latlng) {
      if (!latlng) {
        if (leafletMarker) {
          leafletMap.removeLayer(leafletMarker);
          leafletMarker = null;
        }
        $("#mapCoord").textContent = "ยังไม่ได้ปักหมุด";
        return;
      }
      if (leafletMarker) {
        leafletMarker.setLatLng(latlng);
      } else {
        leafletMarker = L.marker(latlng, { draggable: true }).addTo(leafletMap);
        leafletMarker.on("dragend", () => {
          const p = leafletMarker.getLatLng();
          showCoord(p.lat, p.lng);
        });
      }
      showCoord(latlng[0], latlng[1]);
    }

    function showCoord(lat, lng) {
      $("#mapCoord").textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    }

    // Nominatim ของ OpenStreetMap — ใช้ฟรี ขอแค่ยิงเท่าที่จำเป็น (เฉพาะตอนกดค้นหา)
    async function searchPlace() {
      const q = $("#mapSearch").value.trim();
      const box = $("#mapResults");
      if (!q || !leafletMap) return;
      box.hidden = false;
      box.innerHTML = `<li class="map-result-note">กำลังค้นหา...</li>`;
      try {
        const res = await fetch(
          "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=th&q="
          + encodeURIComponent(q)
        );
        const hits = await res.json();
        box.innerHTML = "";
        if (!Array.isArray(hits) || !hits.length) {
          box.innerHTML = `<li class="map-result-note">ไม่พบสถานที่นี้</li>`;
          return;
        }
        hits.forEach((hit) => {
          const li = document.createElement("li");
          li.className = "map-result";
          li.textContent = hit.display_name;
          li.addEventListener("click", () => {
            const lat = Number(hit.lat);
            const lng = Number(hit.lon);
            leafletMap.setView([lat, lng], 17);
            setPin([lat, lng]);
            box.hidden = true;
          });
          box.appendChild(li);
        });
      } catch {
        box.innerHTML = `<li class="map-result-note">ค้นหาไม่สำเร็จ (ต่ออินเทอร์เน็ตไม่ได้)</li>`;
      }
    }

    $("#mapSearchBtn").addEventListener("click", searchPlace);
    $("#mapSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        searchPlace();
      }
    });

    $("#mapLocateBtn").addEventListener("click", () => {
      if (!leafletMap || !navigator.geolocation) return;
      $("#mapCoord").textContent = "กำลังหาตำแหน่ง...";
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          leafletMap.setView([latitude, longitude], 17);
          setPin([latitude, longitude]);
        },
        () => {
          // geolocation ใช้ได้เฉพาะ https หรือ localhost — บน http ในวง LAN เบราว์เซอร์จะปฏิเสธ
          $("#mapCoord").textContent = "หาตำแหน่งไม่ได้ (ต้องเปิดผ่าน https และอนุญาตให้เข้าถึงตำแหน่ง)";
        }
      );
    });

    function closeMap() {
      mapModal.hidden = true;
      pinTarget = null;
    }

    $("#mapApply").addEventListener("click", () => {
      const text = $("#mapCoord").textContent;
      if (pinTarget && parseCoordInput(text)) pinTarget.value = text;
      closeMap();
    });
    $("#mapClose").addEventListener("click", closeMap);
    $("#mapCancel").addEventListener("click", closeMap);
    mapModal.addEventListener("click", (e) => {
      if (e.target === mapModal) closeMap();
    });

    // -------- MikroTik code modal --------
    const codeModal = $("#codeModal");
    const baseUrlInput = $("#codeBaseUrl");
    let codeDev = null;

    // location.origin คือ URL ที่ "เบราว์เซอร์" ใช้ — ถ้าเปิดเว็บบนเครื่องเซิร์ฟเวอร์เอง
    // จะได้ 127.0.0.1/localhost ซึ่ง MikroTik ยิงกลับมาไม่ถึง (มันจะยิงหาตัวเอง)
    // จึงถาม IP จริงในวง LAN จากเซิร์ฟเวอร์มาใช้แทน
    let serverBase = location.origin;
    let pushToken = "";
    api("/api/server-info").then(async (res) => {
      if (!res.ok) return;
      const info = await res.json();
      const isLocal = /^(127\.|localhost|\[?::1)/i.test(location.hostname);
      if (info.base_url && isLocal) serverBase = info.base_url;
      pushToken = info.push_token || "";
      if (codeModal.hidden) baseUrlInput.value = serverBase;
      renderCode();
      // deploy อยู่บนโฮสต์จริงแต่ยังเก็บลงไฟล์ = serverless ที่ยังไม่ได้ต่อฐานข้อมูล
      // เตือนไว้ก่อนเลย ไม่ต้องรอให้กดเพิ่มอุปกรณ์แล้วพัง
      if (info.storage === "file" && !isLocal) showStorageWarning();
    }).catch(() => {});

    function showStorageWarning() {
      if ($("#storageWarn")) return;
      const el = document.createElement("div");
      el.id = "storageWarn";
      el.className = "storage-warn";
      el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i>
        <span>ยังไม่ได้เชื่อมฐานข้อมูล — โฮสต์นี้เขียนไฟล์ไม่ได้ ทำให้<b>เพิ่มอุปกรณ์และรับสถานะจาก MikroTik ไม่ได้</b>
        ให้ไปที่ Vercel → แท็บ Storage → Upstash for Redis → Connect แล้วสั่ง Redeploy</span>`;
      document.querySelector(".content-head").insertAdjacentElement("afterend", el);
    }

    function codeBase() {
      return (baseUrlInput.value.trim() || serverBase).replace(/\/+$/, "");
    }

    function pushUrl(dev, status) {
      // ถ้าเซิร์ฟเวอร์ตั้ง PUSH_TOKEN ไว้ ต้องแนบมาด้วยไม่งั้นโดนปฏิเสธ 403
      const token = pushToken ? `&token=${encodeURIComponent(pushToken)}` : "";
      return `${codeBase()}/status/mikrotik.php?id=${dev.id}&status=${status}${token}`;
    }

    function mikrotikScript(dev, status) {
      // ห่อด้วย do/on-error ไม่ให้ Netwatch หยุดทำงานถ้ายิงไม่สำเร็จ และ log ไว้ใน MikroTik
      return `:do { /tool fetch url="${pushUrl(dev, status)}" keep-result=no; } `
        + `on-error={ :log warning "NT-CCTV: report id=${dev.id} ${status} failed"; }`;
    }

    function schedulerScript(dev) {
      // อ่านสถานะปัจจุบันจาก Netwatch แล้วส่งซ้ำ — กันเคสที่อุปกรณ์ up อยู่ก่อนแล้ว
      // จึงไม่มี event เปลี่ยนสถานะให้สคริปต์ On Up ทำงาน
      const token = pushToken ? `&token=${encodeURIComponent(pushToken)}` : "";
      return `:local st [/tool netwatch get [find where host="${dev.ip}"] status];\n`
        + `:do { /tool fetch url="${codeBase()}/status/mikrotik.php?id=${dev.id}&status=$st${token}" keep-result=no; } `
        + `on-error={ :log warning "NT-CCTV: sync id=${dev.id} failed"; }`;
    }

    function renderCode() {
      if (!codeDev) return;
      $("#codeUp").textContent = mikrotikScript(codeDev, "up");
      $("#codeDown").textContent = mikrotikScript(codeDev, "down");
      $("#codeTestUrl").textContent = pushUrl(codeDev, "up");

      // สคริปต์ Scheduler ต้องอ้าง Netwatch ด้วย IP — ไม่มี IP ก็สร้างให้ไม่ได้
      const hasIp = !!codeDev.ip;
      $("#codeSyncHead").hidden = !hasIp;
      $("#codeSync").hidden = !hasIp;
      $("#codeSyncHint").hidden = !hasIp;
      if (hasIp) $("#codeSync").textContent = schedulerScript(codeDev);
    }

    function openCodeModal(dev) {
      codeDev = dev;
      $("#codeDevName").textContent = `ID ${dev.id} — ${dev.name}`;
      baseUrlInput.value = codeBase();
      renderCode();
      codeModal.hidden = false;
    }

    baseUrlInput.addEventListener("input", renderCode);

    $("#codeClose").addEventListener("click", () => { codeModal.hidden = true; });
    codeModal.addEventListener("click", (e) => {
      if (e.target === codeModal) codeModal.hidden = true;
    });

    document.querySelectorAll(".btn-copy").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = document.getElementById(btn.dataset.copy).textContent;
        try {
          await navigator.clipboard.writeText(text);
          btn.innerHTML = `<i class="fa-solid fa-check"></i> คัดลอกแล้ว`;
          setTimeout(() => { btn.innerHTML = `<i class="fa-regular fa-copy"></i> copy`; }, 1500);
        } catch {}
      });
    });

    // -------- init --------
    loadDevices();
    setInterval(loadDevices, 15000); // อัปเดตสถานะในตารางเป็นระยะ
    // กลับมาที่แท็บนี้เมื่อไหร่ ให้ดึงสถานะล่าสุดทันที ไม่ต้องรอรอบถัดไป
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) loadDevices();
    });
  }
})();
