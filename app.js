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
              <div class="stat up">
                <span class="stat-label">UP</span>
                <span class="stat-value">${stats.up} ตัว</span>
              </div>
              <div class="stat down">
                <span class="stat-label">DOWN</span>
                <span class="stat-value">${stats.down} ตัว</span>
              </div>
              <div class="stat unknown">
                <span class="stat-label">UNKNOWN</span>
                <span class="stat-value">${stats.unknown} ตัว</span>
              </div>
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

    // -------- notification bell --------
    const notifPanel = $("#notifPanel");

    function renderNotifPanel() {
      const list = $("#notifList");
      list.innerHTML = "";
      const downCats = CATEGORIES.filter((c) => (dashboardData[c.key] || {}).down > 0);

      if (downCats.length === 0) {
        list.innerHTML = `<li class="notif-empty">ไม่มีอุปกรณ์ที่มีปัญหา</li>`;
      } else {
        downCats.forEach((cat) => {
          const li = document.createElement("li");
          li.className = "notif-item";
          li.innerHTML = `
            <span class="notif-dot"></span>
            <span class="notif-name">${cat.title}</span>
            <span class="notif-count">${dashboardData[cat.key].down} ตัว</span>
          `;
          list.appendChild(li);
        });
      }

      $("#notifUpdatedAt").textContent = "อัปเดตล่าสุด: " + (lastUpdatedAt
        ? lastUpdatedAt.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
        : "-");
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
    const CATEGORY_TITLES = {
      recorder: "เครื่องบันทึก",
      camera: "กล้อง CCTV",
      transmitter: "เครื่องส่ง",
      receiver: "เครื่องรับ",
      router: "Router",
      accesspoint: "Access Point",
    };

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
    function statusBadge(dev) {
      if (dev.status === "up") return `<span class="dev-status up">UP</span>`;
      if (dev.status === "down") return `<span class="dev-status down">DOWN</span>`;
      return `<span class="dev-status unknown">ยังไม่รายงาน</span>`;
    }

    function renderDevices() {
      const tbody = $("#deviceRows");
      tbody.innerHTML = "";
      const filtered = devices.filter((d) =>
        !searchQuery ||
        d.name.toLowerCase().includes(searchQuery) ||
        (CATEGORY_TITLES[d.category] || "").toLowerCase().includes(searchQuery) ||
        (d.ip || "").includes(searchQuery) ||
        d.id === searchQuery
      );

      filtered.forEach((dev) => {
        const tr = document.createElement("tr");

        const tdId = document.createElement("td");
        tdId.className = "dev-id";
        tdId.textContent = dev.id;

        const tdName = document.createElement("td");
        tdName.textContent = dev.name; // textContent กัน XSS จากชื่อที่ผู้ใช้กรอก

        const tdCat = document.createElement("td");
        tdCat.textContent = CATEGORY_TITLES[dev.category] || dev.category;

        const tdIp = document.createElement("td");
        tdIp.textContent = dev.ip || "-";

        const tdStatus = document.createElement("td");
        tdStatus.innerHTML = statusBadge(dev);

        const tdSeen = document.createElement("td");
        tdSeen.className = "dev-seen";
        tdSeen.textContent = dev.last_seen ? dev.last_seen.replace("T", " ") : "-";

        const tdActions = document.createElement("td");
        tdActions.className = "dev-actions";
        const codeBtn = document.createElement("button");
        codeBtn.className = "btn-mini";
        codeBtn.innerHTML = `<i class="fa-solid fa-code"></i> โค้ด`;
        codeBtn.addEventListener("click", () => openCodeModal(dev));
        const delBtn = document.createElement("button");
        delBtn.className = "btn-mini danger";
        delBtn.innerHTML = `<i class="fa-solid fa-trash"></i>`;
        delBtn.title = "ลบอุปกรณ์";
        delBtn.addEventListener("click", () => deleteDevice(dev));
        tdActions.append(codeBtn, delBtn);

        tr.append(tdId, tdName, tdCat, tdIp, tdStatus, tdSeen, tdActions);
        tbody.appendChild(tr);
      });

      if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="dev-empty">${devices.length === 0 ? "ยังไม่มีอุปกรณ์ — เพิ่มจากฟอร์มด้านบน" : "ไม่พบอุปกรณ์ที่ค้นหา"}</td></tr>`;
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
      try {
        const res = await api("/api/devices", {
          method: "POST",
          body: JSON.stringify({
            name: $("#devName").value.trim(),
            category: $("#devCategory").value,
            ip: $("#devIp").value.trim(),
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (res.ok) {
          errEl.style.color = "#22b573";
          errEl.textContent = `เพิ่มแล้ว — ได้เลข ID ${j.id} (กดปุ่มโค้ดในตารางเพื่อ copy ไปใส่ MikroTik)`;
          $("#devName").value = "";
          $("#devIp").value = "";
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
