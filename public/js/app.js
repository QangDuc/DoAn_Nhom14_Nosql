/**
 * FinGuard Pro — Core Banking & Fraud Intelligence
 * Pure Vanilla JS, No external CDN dependency (100% Offline)
 */

let networkInstance = null;
let lastGraphData = null;
let cachedAccounts = [];
let cachedRiskScores = {};
let currentFraudMode = 'ALERT';
let showIsolatedNodes = false; // Mặc định ẩn các node cô lập (Yêu cầu 4)
let currentAuthToken = sessionStorage.getItem('fg_auth_token') || sessionStorage.getItem('token') || null;
let currentAuthAccount = sessionStorage.getItem('fg_auth_account') || null;
let currentStaffRole = sessionStorage.getItem('fg_user_role') || sessionStorage.getItem('fg_staff_role') || null;
let dashboardLoginRole = 'ADMIN';

// Cache số liệu để animate nhảy số mượt mà
const animatedKpis = {
  totalAccounts: 0,
  totalTx: 0,
  fraudCycles: 0,
  redisMonitored: 0
};

function getAuthHeaders(extra = {}) {
  const token = sessionStorage.getItem('fg_auth_token') || sessionStorage.getItem('token') || currentAuthToken;
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function getAdminHeaders(extra = {}) {
  const token = sessionStorage.getItem('fg_auth_token') || sessionStorage.getItem('token') || currentAuthToken;
  const headers = { 'Content-Type': 'application/json', 'x-allow-fallback': 'true', ...extra };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

function isSameOriginApi(resource) {
  try {
    const urlStr = typeof resource === 'string' ? resource : (resource?.url || '');
    if (!urlStr) return false;
    const parsed = new URL(urlStr, window.location.origin);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/');
  } catch (_) {
    return false;
  }
}

// Interceptor cho mọi yêu cầu fetch trong Dashboard (Việc 3)
// Chỉ gắn Authorization khi URL là đường dẫn cùng nguồn gốc bắt đầu bằng "/api/" (tuyệt đối không gắn cho tên miền khác)
const _originalFetch = window.fetch;
window.fetch = async function (resource, init = {}) {
  init = init || {};
  const token = sessionStorage.getItem('fg_auth_token') || sessionStorage.getItem('token') || currentAuthToken;

  if (token && isSameOriginApi(resource)) {
    let headers = init.headers;
    if (!headers) {
      headers = {};
      headers['Authorization'] = `Bearer ${token}`;
      init.headers = headers;
    } else if (headers instanceof Headers) {
      if (!headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
      }
    } else if (typeof headers === 'object') {
      if (!headers['Authorization'] && !headers['authorization']) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  const response = await _originalFetch(resource, init);

  const urlStr = typeof resource === 'string' ? resource : (resource?.url || '');
  let isAuthLogin = false;
  try {
    const parsed = new URL(urlStr, window.location.origin);
    isAuthLogin = parsed.origin === window.location.origin && (parsed.pathname === '/api/auth/login' || parsed.pathname === '/api/staff/login');
  } catch (_) {
    isAuthLogin = urlStr.includes('/api/auth/login') || urlStr.includes('/api/staff/login');
  }

  // Không chuyển hướng về login khi 401 xảy ra ở /api/auth/login (để hiện lỗi sai mật khẩu tại chỗ) (Việc 3)
  if (response.status === 401 && !isAuthLogin) {
    sessionStorage.removeItem('fg_auth_token');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('fg_auth_account');
    sessionStorage.removeItem('fg_user_role');
    sessionStorage.removeItem('fg_staff_role');
    currentAuthToken = null;
    if (!window.location.pathname.endsWith('login.html')) {
      window.location.href = '/login.html';
    }
  }

  return response;
};

function applyRolePermissions(role, staffId, fullName) {
  currentStaffRole = role;
  if (role) {
    sessionStorage.setItem('fg_staff_role', role);
  }

  // Ẩn nút và tab cần quyền ADMIN khi vai trò là ANALYST
  const adminEls = document.querySelectorAll('.admin-only');
  adminEls.forEach(el => {
    if (role === 'ANALYST') {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });

  const label = document.getElementById('session-user-label');
  const badge = document.getElementById('session-user-role-badge');
  const btnLogout = document.getElementById('btn-logout');
  const btnLoginRedirect = document.getElementById('btn-login-redirect');

  if (role) {
    if (label) {
      label.textContent = staffId ? `${staffId} (${fullName || ''})` : `Nhân viên (${role})`;
      label.style.color = 'var(--text-normal)';
    }
    if (badge) {
      badge.textContent = role;
      badge.className = role === 'ADMIN' ? 'pill pill-danger' : 'pill pill-info';
      badge.style.display = 'inline-block';
    }
    initLiveEventsStream();
    if (btnLogout) btnLogout.style.display = 'inline-block';
    if (btnLoginRedirect) btnLoginRedirect.style.display = 'none';
  } else {
    if (label) {
      label.textContent = 'Chưa đăng nhập';
      label.style.color = 'var(--text-muted)';
    }
    if (badge) badge.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'none';
    if (btnLoginRedirect) btnLoginRedirect.style.display = 'inline-block';
  }
}

async function checkStaffSession() {
  try {
    const res = await fetch('/api/staff/me', {
      headers: getAdminHeaders(),
      credentials: 'include'
    });
    if (res.ok) {
      const data = await res.json();
      applyRolePermissions(data.staff.role, data.staff.staffId, data.staff.fullName);
      return true;
    }
  } catch (_) {}

  if (currentStaffRole) {
    applyRolePermissions(currentStaffRole, currentAuthAccount);
  } else {
    applyRolePermissions(null);
  }
  return false;
}

function setDashboardLoginRole(role) {
  dashboardLoginRole = role;
  const btnCustomer = document.getElementById('card-role-customer');
  const btnStaff = document.getElementById('card-role-staff');
  const accInput = document.getElementById('login-account');
  const accLabel = document.getElementById('login-account-label');

  if (role === 'CUSTOMER') {
    if (btnCustomer) btnCustomer.className = 'btn-sm btn-primary';
    if (btnStaff) btnStaff.className = 'btn-sm btn-outline';
    if (accLabel) accLabel.textContent = 'Mã tài khoản khách hàng:';
    if (accInput) {
      accInput.value = 'ACC001';
      accInput.placeholder = 'VD: ACC001';
    }
  } else {
    if (btnStaff) btnStaff.className = 'btn-sm btn-primary';
    if (btnCustomer) btnCustomer.className = 'btn-sm btn-outline';
    if (accLabel) accLabel.textContent = 'Mã nhân viên (Staff ID):';
    if (accInput) {
      accInput.value = 'STAFF001';
      accInput.placeholder = 'VD: STAFF001';
    }
  }
}

async function handleStaffLogout() {
  try {
    await fetch('/api/staff/logout', {
      method: 'POST',
      headers: getAdminHeaders(),
      credentials: 'include'
    });
  } catch (_) {}
  currentAuthToken = null;
  currentAuthAccount = null;
  currentStaffRole = null;
  sessionStorage.removeItem('fg_auth_token');
  sessionStorage.removeItem('token');
  sessionStorage.removeItem('fg_auth_account');
  sessionStorage.removeItem('fg_staff_role');
  sessionStorage.removeItem('fg_user_role');
  window.location.href = '/login.html';
}

// Định dạng thời gian TTL dạng mm:ss
function formatTtl(seconds) {
  if (seconds === null || seconds === undefined || seconds <= 0) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Cập nhật Chip HTTP Status ở Console Header
function updateConsoleStatus(chipId, statusCode, statusText) {
  const chip = document.getElementById(chipId);
  if (!chip) return;
  chip.style.display = 'inline-block';
  chip.textContent = `${statusCode} ${statusText || ''}`.trim();
  chip.className = 'console-chip';
  if (statusCode >= 200 && statusCode < 300) {
    chip.classList.add('c2xx');
  } else if (statusCode === 429) {
    chip.classList.add('c429');
  } else {
    chip.classList.add('c4xx');
  }
}

// Drawer mở / đóng bộ công cụ mô phỏng
function openDemoDrawer() {
  const backdrop = document.getElementById('demo-drawer-backdrop');
  const panel = document.getElementById('demo-drawer-panel');
  if (backdrop) backdrop.classList.add('open');
  if (panel) panel.classList.add('open');
}

function closeDemoDrawer() {
  const backdrop = document.getElementById('demo-drawer-backdrop');
  const panel = document.getElementById('demo-drawer-panel');
  if (backdrop) backdrop.classList.remove('open');
  if (panel) panel.classList.remove('open');
}

// Accordion chu trình
function toggleFraudAccordion() {
  const acc = document.getElementById('fraud-accordion');
  if (!acc) return;
  acc.classList.toggle('open');
  const btn = document.getElementById('fraud-toggle-btn');
  if (btn) {
    btn.textContent = acc.classList.contains('open') ? 'Thu gọn ▲' : 'Chi tiết ▼';
  }
}

// Hiệu ứng nhảy số mượt mà (smooth counter animation)
function animateValue(elementId, start, end, duration = 400) {
  const obj = document.getElementById(elementId);
  if (!obj) return;
  if (start === end) {
    obj.textContent = end;
    return;
  }
  const range = end - start;
  let current = start;
  const increment = range > 0 ? 1 : -1;
  const stepTime = Math.abs(Math.floor(duration / (range || 1)));
  const timer = setInterval(() => {
    current += increment;
    obj.textContent = current;
    if (current === end) {
      clearInterval(timer);
    }
  }, Math.max(stepTime, 20));
}

// Toast thông báo thay cho alert()
function showToast(message, type = 'primary') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 3500);
}

// Sao chép nội dung khối JSON
function copyConsoleBox(elementId, btn) {
  const el = document.getElementById(elementId);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const oldText = btn.textContent;
    btn.textContent = 'Đã chép!';
    setTimeout(() => { btn.textContent = oldText; }, 1500);
  });
}

// Cập nhật trạng thái loading cho nút bấm
function setButtonLoading(button, isLoading, loadingText = 'Đang xử lý...') {
  if (!button) return;
  if (isLoading) {
    button.dataset.originalText = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `
      <svg class="icon" style="animation:spin 1s linear infinite" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      ${loadingText}
    `;
  } else {
    button.disabled = false;
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
    }
  }
}

// ================= 1. KIỂM TRA HEALTH SYSTEM TỪ /api/health =================
async function checkSystemHealth() {
  try {
    const res = await fetch('/api/health', { headers: getAdminHeaders() });
    const data = await res.json();

    const neoPill = document.getElementById('neo4j-status-pill');
    const redisPill = document.getElementById('redis-status-pill');
    const topFallbackAlert = document.getElementById('top-fallback-alert');

    if (neoPill) {
      if (data.neo4j === 'real') {
        neoPill.className = 'status-pill real';
        neoPill.innerHTML = '<i class="dot green"></i> Neo4j: real';
      } else {
        neoPill.className = 'status-pill fallback';
        neoPill.innerHTML = '<i class="dot yellow"></i> Neo4j: fallback';
      }
    }

    if (redisPill) {
      if (data.redis === 'real') {
        redisPill.className = 'status-pill real';
        redisPill.innerHTML = '<i class="dot green"></i> Redis: real';
      } else {
        redisPill.className = 'status-pill fallback';
        redisPill.innerHTML = '<i class="dot yellow"></i> Redis: fallback';
      }
    }

    const isAnyFallback = data.neo4j === 'fallback' || data.redis === 'fallback';

    if (topFallbackAlert) {
      topFallbackAlert.style.display = isAnyFallback ? 'flex' : 'none';
    }
  } catch (err) {
    console.error('Lỗi kiểm tra health:', err);
  }
}

// Chuyển đổi tab
function switchTab(tabId, navEl) {
  document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const tab = document.getElementById(`tab-${tabId}`);
  if (tab) tab.classList.add('active');

  if (navEl) {
    navEl.classList.add('active');
  } else {
    const navs = document.querySelectorAll('.nav-item');
    if (tabId === 'overview' && navs[0]) navs[0].classList.add('active');
    if (tabId === 'transfer' && navs[1]) navs[1].classList.add('active');
    if (tabId === 'accounts' && navs[2]) navs[2].classList.add('active');
    if (tabId === 'security' && navs[3]) navs[3].classList.add('active');
    if (tabId === 'deep-analysis' && navs[4]) navs[4].classList.add('active');
    if (tabId === 'explain' && navs[5]) navs[5].classList.add('active');
  }

  const titles = {
    overview: [
      'Trung tâm Giám sát Rủi ro & Đồ thị Dòng tiền',
      'Phát hiện chu trình luân chuyển khép kín thời gian thực (Neo4j) & Chặn dò mật khẩu tự động (Redis)'
    ],
    transfer: [
      'Cổng Giao dịch Chuyển tiền & Kiểm toán Chu trình',
      'Thực thi Giao dịch toàn vẹn (ACID) và tự động rà soát chu trình nghi vấn sau mỗi lệnh chuyển'
    ],
    accounts: [
      'Quản lý Hồ sơ Tài khoản Ngân hàng (CRUD)',
      'Quản trị danh sách Node (:Account), điều chỉnh số dư, mở mới hoặc phong tỏa tài khoản'
    ],
    security: [
      'Trung tâm Phòng chống Tấn công Brute-Force (Lớp bảo vệ xác thực)',
      'Giám sát bộ đếm INCR login:fail:*, khóa tự động login:lock:* và quản lý TTL theo thời gian thực'
    ],
    'deep-analysis': [
      'Phân Tích Đồ Thị Nâng Cao & Phát Hiện Mẫu Rửa Tiền',
      'Truy vấn chu trình dài (3-5 đỉnh) và phát hiện các mẫu gian lận tinh vi: Structuring, Mule account, Rapid Fan-out'
    ],
    explain: [
      'Phân Tích Kế Hoạch Thực Thi Truy Vấn Cypher (PROFILE Explain)',
      'Đánh giá hiệu năng, DB Hits, số dòng và cấu trúc toán tử thực thi của Neo4j'
    ]
  };

  if (titles[tabId]) {
    document.getElementById('topbar-title').textContent = titles[tabId][0];
    document.getElementById('topbar-subtitle').textContent = titles[tabId][1];
  }

  if (tabId === 'overview' && networkInstance) {
    setTimeout(() => networkInstance.fit(), 100);
  }
  if (tabId === 'transfer') {
    loadAllAccountsForDropdown();
    loadRecentTransactions();
  }
  if (tabId === 'accounts') {
    loadAccountsCrudTable();
  }
  if (tabId === 'deep-analysis') {
    runDeepAnalysis();
  }
  if (tabId === 'explain') {
    runCypherExplain();
  }
}

// ================= TÍNH TOÁN RỦI RO & CHẾ ĐỘ BẢO MẬT (POLYGLOT NEO4J + REDIS) =================
async function loadRiskScores() {
  try {
    const res = await fetch('/api/risk/scores', {
      headers: getAdminHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.scores || []);
    cachedRiskScores = {};
    for (const item of list) {
      cachedRiskScores[item.accountId] = item;
    }
  } catch (err) {
    console.error('Lỗi tải chỉ số rủi ro:', err);
  }
}

function formatRiskTooltip(risk) {
  if (!risk || !risk.factors) return '';
  const f = risk.factors;
  const cPoints = f.inCycle ? '+40' : '+0';
  const pPoints = `+${Math.min(20, 2 * (f.partnerCount || 0))}`;
  const fPoints = `+${Math.min(25, 5 * (f.loginFailures || 0))}`;
  const lPoints = f.isLocked ? '+15' : '+0';
  return `Điểm: ${risk.score}/100 [Chu trình: ${cPoints}, Đối tác: ${pPoints}, Đăng nhập sai: ${fPoints}, Khóa: ${lPoints}]`;
}

async function loadFraudMode() {
  try {
    const res = await fetch('/api/security/mode', { headers: getAdminHeaders() });
    const data = await res.json();
    currentFraudMode = data.mode || 'ALERT';
    updateFraudModeUI();
  } catch (err) {
    console.error('Lỗi tải chế độ bảo mật:', err);
  }
}

function updateFraudModeUI() {
  const pill = document.getElementById('current-fraud-mode-pill');
  const btn = document.getElementById('btn-toggle-fraud-mode');
  if (pill) {
    pill.textContent = currentFraudMode === 'BLOCK' ? 'Ngăn chặn chủ động' : 'Giám sát';
    pill.className = currentFraudMode === 'BLOCK' ? 'pill pill-danger' : 'pill pill-info';
  }
  if (btn) {
    btn.textContent = currentFraudMode === 'BLOCK' ? 'Chuyển sang Giám sát' : 'Chuyển sang Ngăn chặn chủ động';
    btn.className = currentFraudMode === 'BLOCK' ? 'btn-sm btn-outline' : 'btn-sm btn-outline-danger';
  }
}

async function toggleFraudMode() {
  const nextMode = currentFraudMode === 'ALERT' ? 'BLOCK' : 'ALERT';
  if (nextMode === 'BLOCK') {
    const confirmSwitch = confirm('XÁC NHẬN CHUYỂN SANG CHẾ ĐỘ NGĂN CHẶN CHỦ ĐỘNG (BLOCK):\n\nỞ chế độ này, Neo4j sẽ tự động kiểm tra trước và ROLLBACK mọi giao dịch có nguy cơ khép chu trình 3 đỉnh, trả mã lỗi HTTP 409 Conflict.\n\nBạn có muốn kích hoạt?');
    if (!confirmSwitch) return;
  }

  try {
    const res = await fetch('/api/security/mode', {
      method: 'PUT',
      headers: getAdminHeaders(),
      body: JSON.stringify({ mode: nextMode })
    });
    const data = await res.json();
    if (res.ok) {
      currentFraudMode = data.mode;
      updateFraudModeUI();
      showToast(data.message, currentFraudMode === 'BLOCK' ? 'danger' : 'success');
    } else {
      showToast(data.error || 'Không thể đổi chế độ', 'danger');
    }
  } catch (err) {
    showToast('Lỗi cập nhật chế độ: ' + err.message, 'danger');
  }
}

async function loadFrozenAccounts() {
  const tbody = document.getElementById('frozen-accounts-tbody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/security/frozen', {
      headers: getAdminHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    const frozenList = data.frozenAccounts || [];

    if (frozenList.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted); padding:12px;">Không có tài khoản nào bị phong tỏa</td></tr>`;
      return;
    }

    tbody.innerHTML = frozenList.map(item => {
      const reasonBadge = item.reason === 'CYCLE'
        ? `<span class="pill pill-danger">CYCLE</span>`
        : `<span class="pill pill-warning">BRUTE_FORCE</span>`;

      return `
        <tr>
          <td><b>${item.accountId}</b></td>
          <td>${reasonBadge}</td>
          <td style="font-family:monospace; font-weight:600;">${formatTtl(item.remainingSeconds)}</td>
          <td>
            ${currentStaffRole !== 'ANALYST' ? `<button class="btn-sm btn-outline admin-only" style="padding:2px 8px; font-size:11px;" onclick="unfreezeAccount('${item.accountId}')">Gỡ phong tỏa</button>` : '-'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách tài khoản phong tỏa:', err);
  }
}

async function unfreezeAccount(accountId) {
  try {
    const res = await fetch(`/api/security/unfreeze/${accountId}`, {
      method: 'POST',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadFrozenAccounts();
      await loadSecurityStatus();
    } else {
      showToast(data.error || 'Lỗi gỡ phong tỏa', 'danger');
    }
  } catch (err) {
    showToast('Lỗi gỡ phong tỏa: ' + err.message, 'danger');
  }
}

// ================= 2. LỚP BẢO VỆ XÁC THỰC (LIVE 3S + TTL ĐẾM NGƯỢC) =================
let cachedSecurityItems = [];

async function loadSecurityStatus() {
  try {
    loadFrozenAccounts();
    loadIpStatus();
    loadSessions();
    const res = await fetch('/api/auth/admin/security-status', {
      headers: getAdminHeaders()
    });
    const data = await res.json();
    cachedSecurityItems = data.items || [];

    const lockedCount = data.summary ? data.summary.locked : cachedSecurityItems.filter(i => i.isLocked).length;
    const monitoredCount = data.summary ? data.summary.monitored : cachedSecurityItems.length;

    // Cập nhật KPI nhảy số mượt tại cả tab Tổng quan và thẻ theo dõi tab Bảo mật (Yêu cầu 3)
    animateValue('kpi-redis-monitored', animatedKpis.redisMonitored, monitoredCount);
    animatedKpis.redisMonitored = monitoredCount;

    const monitoredSec = document.getElementById('kpi-redis-monitored-sec');
    if (monitoredSec) monitoredSec.textContent = monitoredCount;

    const lockedSub = document.getElementById('kpi-redis-locked');
    if (lockedSub) lockedSub.textContent = `${lockedCount} đang bị khóa`;

    const lockedSecSub = document.getElementById('kpi-redis-locked-sec');
    if (lockedSecSub) lockedSecSub.textContent = `${lockedCount} đang bị khóa`;

    const badgeLocked = document.getElementById('badge-locked');
    if (badgeLocked) {
      badgeLocked.textContent = lockedCount;
      if (lockedCount > 0) {
        badgeLocked.classList.add('danger');
      } else {
        badgeLocked.classList.remove('danger');
      }
    }

    renderSecurityTable();
  } catch (err) {
    console.error('Lỗi tải trạng thái Redis:', err);
  }
}

// Render 5 chấm tiến trình fail dots
function renderFailDots(failCount, isLocked) {
  let dots = '';
  for (let i = 1; i <= 5; i++) {
    let dotClass = '';
    if (isLocked) {
      dotClass = 'filled-red';
    } else if (i <= failCount) {
      dotClass = failCount >= 4 ? 'filled-yellow' : 'filled-green';
    }
    dots += `<span class="fail-dot ${dotClass}"></span>`;
  }
  return `<div class="fail-dots" title="${isLocked ? 'Đã khóa' : `Xác thực thất bại ${failCount}/5 lần`}">${dots}</div>`;
}

// Render bảng Redis: Sắp xếp tài khoản bị khóa lên đầu, badge 1 dòng, 5 dots, TTL mm:ss, không cuộn ngang
function renderSecurityTable() {
  const tbody = document.getElementById('redis-security-tbody');
  const fullTbody = document.getElementById('security-full-tbody');
  if (!tbody) return;

  // Sắp xếp: Tài khoản bị khóa lên trước, sau đó giảm dần theo số lần nhập sai
  const sortedItems = [...cachedSecurityItems].sort((a, b) => {
    if (a.isLocked && !b.isLocked) return -1;
    if (!a.isLocked && b.isLocked) return 1;
    return (b.failCount || 0) - (a.failCount || 0);
  });

  if (sortedItems.length === 0) {
    const emptyRow = '<tr><td colspan="5" style="text-align:center;color:var(--text-muted)">Không có tài khoản nào bị theo dõi hoặc nhập sai.</td></tr>';
    tbody.innerHTML = emptyRow;
    if (fullTbody) fullTbody.innerHTML = emptyRow;
    return;
  }

  // Bảng thu gọn cột phải (Overview): hiển thị tối đa 5 tài khoản nguy cơ cao nhất
  // Cột cố định: Tài khoản 72px | Lần sai 104px | Trạng thái 84px | TTL 52px | Gỡ khóa tạm thời 32px
  const top5Items = sortedItems.slice(0, 5);

  tbody.innerHTML = top5Items.map(item => {
    const ttlFormatted = item.isLocked
      ? `<b style="color:var(--danger)">${formatTtl(item.lockTtl)}</b>`
      : `${formatTtl(item.failTtl)}`;

    let badgeDotColor = 'var(--success)';
    let badgeClass = 'pill-success';
    let badgeText = 'Bình thường';

    if (item.isLocked || item.status === 'LOCKED') {
      badgeDotColor = 'var(--danger)';
      badgeClass = 'pill-danger';
      badgeText = 'Đã khóa';
    } else if (item.status === 'WARNING' || item.failCount >= 3) {
      badgeDotColor = 'var(--warning)';
      badgeClass = 'pill-warning';
      badgeText = 'Cảnh báo';
    }

    return `
      <tr class="${item.isLocked ? 'row-locked' : ''}">
        <td style="width:72px;"><b>${item.accountId}</b></td>
        <td style="width:104px;">
          ${renderFailDots(item.failCount, item.isLocked)}
          <b>${item.failCount}</b>/5
        </td>
        <td style="width:84px;"><span class="pill ${badgeClass}" style="padding:2px 4px; font-size:10px;"><i class="dot" style="background:${badgeDotColor}"></i> ${badgeText}</span></td>
        <td style="width:52px;"><span class="ttl-countdown" data-acc="${item.accountId}" style="font-size:11px;">${ttlFormatted}</span></td>
        <td style="width:32px; text-align:center;">
          ${currentStaffRole !== 'ANALYST' ? `
          <button class="btn-unlock-icon admin-only" onclick="confirmUnlockAccount('${item.accountId}')" title="Gỡ khóa tạm thời tài khoản ${item.accountId}">
            <svg class="icon" style="width:13px;height:13px;color:var(--primary);" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
          </button>` : '-'}
        </td>
      </tr>
    `;
  }).join('');

  // Bảng đầy đủ trên tab Bảo Mật
  if (fullTbody) {
    fullTbody.innerHTML = sortedItems.map(item => {
      const keyName = item.isLocked ? `login:lock:${item.accountId}` : `login:fail:${item.accountId}`;
      const ttlFormatted = item.isLocked
        ? `<b style="color:var(--danger)">${formatTtl(item.lockTtl)}</b> (Khóa 5m)`
        : `${formatTtl(item.failTtl)} (Cửa sổ 15m)`;

      let badgeDotColor = 'var(--success)';
      let badgeClass = 'pill-success';
      let badgeText = 'Bình thường';

      if (item.isLocked || item.status === 'LOCKED') {
        badgeDotColor = 'var(--danger)';
        badgeClass = 'pill-danger';
        badgeText = 'Đã khóa';
      } else if (item.status === 'WARNING' || item.failCount >= 3) {
        badgeDotColor = 'var(--warning)';
        badgeClass = 'pill-warning';
        badgeText = 'Cảnh báo';
      }

      return `
        <tr class="${item.isLocked ? 'row-locked' : ''}">
          <td><b>${item.accountId}</b></td>
          <td><code>${keyName}</code></td>
          <td>
            ${renderFailDots(item.failCount, item.isLocked)}
            <b>${item.failCount}</b> / 5
          </td>
          <td><span class="pill ${badgeClass}"><i class="dot" style="background:${badgeDotColor}"></i> ${badgeText}</span></td>
          <td><span class="ttl-countdown-full" data-acc="${item.accountId}">${ttlFormatted}</span></td>
          <td>
            ${currentStaffRole !== 'ANALYST' ? `<button class="btn-sm btn-outline btn-unlock-single admin-only" onclick="confirmUnlockAccount('${item.accountId}')">Gỡ khóa tạm thời</button>` : '-'}
          </td>
        </tr>
      `;
    }).join('');
  }
}

// Đồng hồ giảm TTL cục bộ từng 1 giây để số giây nhảy mượt mm:ss
setInterval(() => {
  let changed = false;
  for (const item of cachedSecurityItems) {
    if (item.isLocked && item.lockTtl > 0) {
      item.lockTtl--;
      changed = true;
    }
    if (!item.isLocked && item.failTtl > 0) {
      item.failTtl--;
      changed = true;
    }
  }
  if (changed) {
    document.querySelectorAll('.ttl-countdown').forEach(el => {
      const acc = el.getAttribute('data-acc');
      const item = cachedSecurityItems.find(i => i.accountId === acc);
      if (item) {
        el.innerHTML = item.isLocked
          ? `<b style="color:var(--danger)">${formatTtl(item.lockTtl)}</b>`
          : `${formatTtl(item.failTtl)}`;
      }
    });
    document.querySelectorAll('.ttl-countdown-full').forEach(el => {
      const acc = el.getAttribute('data-acc');
      const item = cachedSecurityItems.find(i => i.accountId === acc);
      if (item) {
        el.innerHTML = item.isLocked
          ? `<b style="color:var(--danger)">${formatTtl(item.lockTtl)}</b> (Khóa 5m)`
          : `${formatTtl(item.failTtl)} (Cửa sổ 15m)`;
      }
    });
  }
}, 1000);

// Nút gỡ khóa tạm thời có xác nhận
async function confirmUnlockAccount(accountId) {
  if (!confirm(`Xác nhận gỡ khóa tạm thời và xóa bộ đếm thất bại cho tài khoản ${accountId}?`)) return;
  await unlockAccount(accountId);
}

async function unlockAccount(accountId) {
  try {
    const res = await fetch(`/api/auth/admin/unlock/${accountId}`, {
      method: 'POST',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    showToast(data.message, 'success');
    const logEl = document.getElementById('login-result');
    if (logEl) logEl.textContent = `[UNLOCK] ${data.message}`;
    updateConsoleStatus('login-status-chip', res.status, 'OK');
    await loadSecurityStatus();
  } catch (err) {
    showToast('Lỗi gỡ khóa tạm thời: ' + err.message, 'danger');
  }
}

// ================= IP BRUTE-FORCE & ACTIVE SESSIONS =================
let cachedIpItems = [];
async function loadIpStatus() {
  try {
    const res = await fetch('/api/auth/admin/ip-status', {
      headers: getAdminHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    cachedIpItems = data.items || [];
    const tbody = document.getElementById('ip-status-tbody');
    if (!tbody) return;

    if (cachedIpItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Không có IP nào bị theo dõi</td></tr>';
      return;
    }

    tbody.innerHTML = cachedIpItems.map(item => {
      let statusBadge = '<span class="pill pill-success">Bình thường</span>';
      if (item.status === 'BLOCKED' || item.isBlocked) {
        statusBadge = '<span class="pill pill-danger">Đã chặn</span>';
      } else if (item.status === 'WARNING') {
        statusBadge = '<span class="pill pill-warning">Cảnh báo</span>';
      }

      const displayIp = item.rawIp || item.ip;
      const ttlFormatted = item.ttl > 0 ? formatTtl(item.ttl) : '00:00';
      const canUnblock = item.isBlocked || item.failCount > 0;

      return `
        <tr>
          <td><code style="font-size:11px;">${displayIp}</code></td>
          <td><b>${item.failCount}</b></td>
          <td>${item.accountsTried}</td>
          <td>${statusBadge}</td>
          <td style="font-family:monospace; font-weight:600;">${ttlFormatted}</td>
          <td>
            ${canUnblock && currentStaffRole !== 'ANALYST' ? `<button class="btn-sm btn-outline admin-only" style="padding:2px 8px; font-size:11px;" onclick="unblockIp('${displayIp}')">Bỏ chặn</button>` : '-'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải trạng thái IP:', err);
  }
}

async function unblockIp(ip) {
  if (!confirm(`Xác nhận bỏ chặn và đặt lại bộ đếm cho địa chỉ IP ${ip}?`)) return;
  try {
    const res = await fetch(`/api/auth/admin/ip-unblock/${encodeURIComponent(ip)}`, {
      method: 'POST',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadIpStatus();
    } else {
      showToast(data.error || 'Lỗi khi bỏ chặn IP', 'danger');
    }
  } catch (err) {
    showToast('Lỗi khi bỏ chặn IP: ' + err.message, 'danger');
  }
}

let cachedSessionItems = [];
async function loadSessions() {
  try {
    const res = await fetch('/api/auth/admin/sessions', {
      headers: getAdminHeaders()
    });
    if (!res.ok) return;
    const data = await res.json();
    cachedSessionItems = data.sessions || [];
    const tbody = document.getElementById('active-sessions-tbody');
    if (!tbody) return;

    if (cachedSessionItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">Không có phiên nào đang hoạt động</td></tr>';
      return;
    }

    tbody.innerHTML = cachedSessionItems.map(item => {
      const ttlFormatted = item.ttl > 0 ? formatTtl(item.ttl) : '00:00';
      return `
        <tr>
          <td><code style="font-size:11px;" title="UserAgent: ${item.userAgent}">${item.sessionId}…</code></td>
          <td><b>${item.accountId}</b></td>
          <td><span style="font-size:11px;">${item.ip}</span></td>
          <td>${item.ageSeconds}s</td>
          <td style="font-family:monospace; font-weight:600;">${ttlFormatted}</td>
          <td style="white-space:nowrap;">
            ${currentStaffRole !== 'ANALYST' ? `
            <button class="btn-sm btn-outline-danger admin-only" style="padding:2px 6px; font-size:11px; margin-right:4px;" onclick="revokeSession('${item.sessionId}')">Buộc đăng xuất</button>
            <button class="btn-sm btn-outline admin-only" style="padding:2px 6px; font-size:11px;" onclick="revokeAccountAllSessions('${item.accountId}')">Đăng xuất tất cả của TK</button>
            ` : '-'}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Lỗi tải danh sách phiên:', err);
  }
}

async function revokeSession(sessionId) {
  if (!confirm(`Xác nhận buộc đăng xuất phiên ${sessionId}?`)) return;
  try {
    const res = await fetch('/api/auth/admin/sessions/revoke', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadSessions();
    } else {
      showToast(data.error || 'Lỗi khi thu hồi phiên', 'danger');
    }
  } catch (err) {
    showToast('Lỗi khi thu hồi phiên: ' + err.message, 'danger');
  }
}

async function revokeAccountAllSessions(accountId) {
  if (!confirm(`Xác nhận buộc đăng xuất TẤT CẢ các phiên của tài khoản ${accountId}?`)) return;
  try {
    const res = await fetch('/api/auth/admin/sessions/revoke', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      await loadSessions();
    } else {
      showToast(data.error || 'Lỗi khi thu hồi phiên', 'danger');
    }
  } catch (err) {
    showToast('Lỗi khi thu hồi phiên: ' + err.message, 'danger');
  }
}

// ================= 3. ĐĂNG NHẬP & TEST BRUTE-FORCE =================
async function submitLogin() {
  const accInput = document.getElementById('login-account');
  const passInput = document.getElementById('login-password');
  const username = accInput.value.trim();
  const password = passInput.value;
  const box = document.getElementById('login-result');
  const btn = event ? event.target : null;

  if (!username) {
    showToast('Vui lòng nhập tài khoản', 'warning');
    return;
  }

  setButtonLoading(btn, true, 'Đang xác thực...');
  try {
    const isCustomer = dashboardLoginRole === 'CUSTOMER';
    const endpoint = isCustomer ? '/api/auth/login' : '/api/staff/login';
    const body = isCustomer
      ? { accountId: username, password }
      : { staffId: username, password };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include'
    });
    const data = await res.json();
    box.textContent = JSON.stringify(data, null, 2);
    updateConsoleStatus('login-status-chip', res.status, res.statusText);

    if (res.ok) {
      currentAuthToken = data.token;
      sessionStorage.setItem('fg_auth_token', data.token);
      sessionStorage.setItem('token', data.token);

      if (isCustomer) {
        currentAuthAccount = data.account.accountId;
        sessionStorage.setItem('fg_auth_account', data.account.accountId);
        sessionStorage.setItem('fg_user_role', data.role || data.account.role);
        document.getElementById('session-user-label').textContent = `${data.account.accountId} (${data.account.ownerName})`;
        document.getElementById('session-user-label').style.color = 'var(--success)';
        showToast(`Đăng nhập thành công! Đang chuyển hướng sang cổng khách hàng...`, 'success');
        setTimeout(() => {
          window.location.href = '/app/';
        }, 600);
      } else {
        currentAuthAccount = data.staff.staffId;
        sessionStorage.setItem('fg_auth_account', data.staff.staffId);
        sessionStorage.setItem('fg_staff_role', data.staff.role);
        sessionStorage.setItem('fg_user_role', data.staff.role);
        applyRolePermissions(data.staff.role, data.staff.staffId, data.staff.fullName);
        showToast(`Đăng nhập thành công nhân viên ${data.staff.staffId} (${data.staff.role})`, 'success');
      }
    } else if (res.status === 429) {
      showToast(`Tài khoản ${username} đã bị KHÓA!`, 'danger');
    } else {
      showToast(data.error || 'Đăng nhập thất bại', 'warning');
    }
    await loadSecurityStatus();
  } catch (err) {
    box.textContent = 'Lỗi kết nối: ' + err.message;
    updateConsoleStatus('login-status-chip', 500, 'Error');
  } finally {
    setButtonLoading(btn, false);
  }
}

function fillCorrectPassword() {
  const pwdInput = document.getElementById('login-password');
  pwdInput.value = '';
  pwdInput.focus();
  showToast('Vui lòng nhập mật khẩu vào ô bên trên', 'primary');
}

function focusSecPassword() {
  const pwdInput = document.getElementById('sec-test-password');
  pwdInput.value = '';
  pwdInput.focus();
  showToast('Vui lòng nhập mật khẩu vào ô bên trên', 'primary');
}

async function simulateBruteForceAttack() {
  const accountId = document.getElementById('login-account').value.trim() || 'ACC025';
  const box = document.getElementById('login-result');
  const btn = event ? event.target : null;

  setButtonLoading(btn, true, 'Đang bắn 5 request...');
  box.textContent = `⚡ Bắt đầu mô phỏng tấn công Brute-force vào ${accountId}...\n`;

  for (let i = 1; i <= 5; i++) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, password: `Wrong_Attempt_${i}` })
    });
    const data = await res.json();
    box.textContent += `Lần ${i} [HTTP ${res.status}]: ${data.error}\n`;
    updateConsoleStatus('login-status-chip', res.status, res.status === 429 ? 'LOCKED 429' : '401 Fail');
    await loadSecurityStatus();
    await new Promise(r => setTimeout(r, 200));
  }
  setButtonLoading(btn, false);
  showToast(`Đã tự động khóa tài khoản ${accountId} sau 5 lần nhập sai!`, 'danger');
}

// Kiểm thử từ Tab Bảo mật (secTestSingleLogin & secTestBurstAttack)
async function secTestSingleLogin(isCorrect = false) {
  const accountId = document.getElementById('sec-test-account').value.trim() || 'ACC025';
  const password = document.getElementById('sec-test-password').value || '';
  const logBox = document.getElementById('sec-test-log');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, password })
    });
    const data = await res.json();
    logBox.textContent = `[${new Date().toLocaleTimeString('vi-VN')}] HTTP ${res.status}\n` + JSON.stringify(data, null, 2);
    updateConsoleStatus('sec-test-status-chip', res.status, res.statusText);
    showToast(res.ok ? 'Đăng nhập thành công' : data.error, res.ok ? 'success' : (res.status === 429 ? 'danger' : 'warning'));
    await loadSecurityStatus();
  } catch (err) {
    logBox.textContent = 'Lỗi kết nối: ' + err.message;
  }
}

async function secTestBurstAttack() {
  const accountId = document.getElementById('sec-test-account').value.trim() || 'ACC025';
  const logBox = document.getElementById('sec-test-log');
  logBox.textContent = `⚡ Bắn 5 request liên tiếp tới ${accountId}...\n`;

  for (let i = 1; i <= 5; i++) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, password: `Attack_Payload_${i}` })
    });
    const data = await res.json();
    logBox.textContent += `Lần ${i} -> HTTP ${res.status}: ${data.error}\n`;
    updateConsoleStatus('sec-test-status-chip', res.status, res.status === 429 ? 'Locked' : 'Unauthorized');
    await loadSecurityStatus();
    await new Promise(r => setTimeout(r, 180));
  }
  showToast(`Đã bắn 5 request vào ${accountId}`, 'danger');
}

// ================= 4. GIAO DỊCH CHUYỂN TIỀN =================
function setQuickTx(from, to, amount, note) {
  document.getElementById('tx-from').value = from;
  document.getElementById('tx-to').value = to;
  document.getElementById('tx-amount').value = amount;
  document.getElementById('tx-note').value = note;
}

async function submitTransaction() {
  const fromAccountId = document.getElementById('tx-from').value.trim();
  const toAccountId = document.getElementById('tx-to').value.trim();
  const amount = Number(document.getElementById('tx-amount').value);
  const note = document.getElementById('tx-note').value.trim();
  const box = document.getElementById('tx-result');
  const btn = event ? event.target : null;

  setButtonLoading(btn, true, 'Đang ghi nhận transaction...');
  try {
    const res = await fetch('/api/transactions', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fromAccountId, toAccountId, amount, note })
    });
    const data = await res.json();
    box.textContent = JSON.stringify(data, null, 2);
    updateConsoleStatus('tx-status-chip', res.status, res.statusText);

    if (res.ok) {
      if (data.fraudAlert) {
        showToast('🚨 CẢNH BÁO ĐỎ: Giao dịch khép chu trình luân chuyển khép kín!', 'danger');
      } else {
        showToast(`Chuyển ${amount.toLocaleString('vi-VN')} đ thành công`, 'success');
      }
      await scanFraudCycles();
      await lookupAccountDetail();
    } else {
      showToast(data.error, 'danger');
    }
  } catch (err) {
    box.textContent = 'Lỗi: ' + err.message;
    updateConsoleStatus('tx-status-chip', 500, 'Error');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function submitFullTransfer() {
  const fromAccountId = document.getElementById('full-tx-from').value;
  const toAccountId = document.getElementById('full-tx-to').value;
  const amount = Number(document.getElementById('full-tx-amount').value);
  const note = document.getElementById('full-tx-note').value;
  const logBox = document.getElementById('full-tx-log');
  const btn = event ? event.target : null;

  setButtonLoading(btn, true, 'Đang chuyển khoản...');
  try {
    const res = await fetch('/api/transactions', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ fromAccountId, toAccountId, amount, note })
    });
    const data = await res.json();
    logBox.textContent = JSON.stringify(data, null, 2);
    updateConsoleStatus('full-tx-status-chip', res.status, res.statusText);

    if (res.ok) {
      showToast(data.message, data.fraudAlert ? 'danger' : 'success');
      await scanFraudCycles();
      await loadRecentTransactions();
    } else {
      showToast(data.error, 'danger');
    }
  } catch (err) {
    logBox.textContent = 'Lỗi: ' + err.message;
    updateConsoleStatus('full-tx-status-chip', 500, 'Error');
  } finally {
    setButtonLoading(btn, false);
  }
}

async function autoCreateFullFraudRing() {
  const steps = [
    { fromAccountId: 'ACC035', toAccountId: 'ACC036', amount: 60000000, note: 'Chuyển vốn hợp tác' },
    { fromAccountId: 'ACC036', toAccountId: 'ACC037', amount: 59000000, note: 'Phí tư vấn tài chính' },
    { fromAccountId: 'ACC037', toAccountId: 'ACC035', amount: 58500000, note: 'Khép vòng hoàn vốn' }
  ];
  const logBox = document.getElementById('full-tx-log');
  logBox.textContent = 'Tự động tạo 3 giao dịch khép vòng ACC035 → ACC036 → ACC037 → ACC035...\n';

  for (const s of steps) {
    const res = await fetch('/api/transactions', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify(s)
    });
    const data = await res.json();
    logBox.textContent += `\n👉 ${s.fromAccountId} -> ${s.toAccountId}: ${data.message}`;
  }
  updateConsoleStatus('full-tx-status-chip', 201, 'Created');
  showToast('Đã tạo xong chu trình ACC035 → ACC036 → ACC037 → ACC035!', 'danger');
  await scanFraudCycles();
  await loadRecentTransactions();
}

async function loadRecentTransactions() {
  const res = await fetch('/api/transactions?limit=50', { headers: getAdminHeaders() });
  const data = await res.json();
  const tbody = document.getElementById('all-transactions-tbody');
  if (!tbody) return;
  tbody.innerHTML = (data.transactions || []).map(t => `
    <tr>
      <td><code>${t.txId}</code></td>
      <td><b>${t.fromAccount}</b> → <b>${t.toAccount}</b></td>
      <td style="color:var(--success); font-weight:600;">${Number(t.amount).toLocaleString('vi-VN')} đ</td>
      <td>${new Date(t.timestamp).toLocaleString('vi-VN')}</td>
      <td>${t.note}</td>
    </tr>
  `).join('');
}

// ================= 4B. PHÂN TÍCH SÂU (ADVANCED FRAUD PATTERNS & LONG CYCLES) =================
let currentPatternType = 'cycles';

function selectPatternTab(type) {
  currentPatternType = type;
  document.querySelectorAll('.pattern-chip').forEach(c => {
    c.classList.remove('active', 'btn-primary');
    c.classList.add('btn-outline');
  });
  const activeChip = document.getElementById(`chip-pattern-${type}`);
  if (activeChip) {
    activeChip.classList.add('active', 'btn-primary');
    activeChip.classList.remove('btn-outline');
  }

  const filterCycles = document.getElementById('filter-box-cycles');
  const filterPatternDesc = document.getElementById('filter-box-pattern-desc');
  const ruleText = document.getElementById('pattern-rule-text');

  if (type === 'cycles') {
    filterCycles.style.display = 'flex';
    filterPatternDesc.style.display = 'none';
    document.getElementById('deep-results-title').textContent = 'Kết Quả Phân Tích Chu Trình Dài (3-5 đỉnh)';
  } else {
    filterCycles.style.display = 'none';
    filterPatternDesc.style.display = 'flex';

    if (type === 'structuring') {
      ruleText.innerHTML = '<b>Quy tắc Structuring:</b> ≥ 3 giao dịch, mỗi GD &lt; 10.000.000 VNĐ, từ cùng nguồn tới cùng đích trong 24 giờ, tổng số tiền ≥ 20.000.000 VNĐ.';
      document.getElementById('deep-results-title').textContent = 'Kết Quả Mẫu Chia Nhỏ Giao Dịch (Structuring)';
    } else if (type === 'passthrough') {
      ruleText.innerHTML = '<b>Quy tắc Tài khoản trung chuyển (Mule account):</b> Tài khoản nhận ≥ 60.000.000 VNĐ từ ≥ 3 nguồn khác nhau trong 30 phút rồi chuyển đi ≥ 90% số đó trong 30 phút tiếp theo.';
      document.getElementById('deep-results-title').textContent = 'Kết Quả Mẫu Tài khoản trung chuyển (Mule account)';
    } else if (type === 'fanout') {
      ruleText.innerHTML = '<b>Quy tắc Phân tán dòng tiền nhanh (Rapid Fan-out):</b> Một tài khoản chuyển tiền tới ≥ 8 tài khoản thụ hưởng khác nhau trong vòng 1 giờ.';
      document.getElementById('deep-results-title').textContent = 'Kết Quả Mẫu Phân tán dòng tiền nhanh (Rapid Fan-out)';
    }
  }

  runDeepAnalysis();
}

async function runDeepAnalysis() {
  const loading = document.getElementById('deep-loading-state');
  const empty = document.getElementById('deep-empty-state');
  const errorBox = document.getElementById('deep-error-state');
  const errorMsg = document.getElementById('deep-error-msg');
  const tableWrap = document.getElementById('deep-table-wrap');
  const thead = document.getElementById('deep-results-thead');
  const tbody = document.getElementById('deep-results-tbody');
  const countBadge = document.getElementById('deep-count-badge');
  const durationLabel = document.getElementById('deep-duration-label');

  if (!tbody) return;

  loading.style.display = 'block';
  empty.style.display = 'none';
  if (errorBox) errorBox.style.display = 'none';
  tableWrap.style.display = 'none';

  try {
    let url = '';
    if (currentPatternType === 'cycles') {
      const minLen = document.getElementById('filter-min-len').value;
      const maxLen = document.getElementById('filter-max-len').value;
      const minAmount = document.getElementById('filter-min-amount').value || 0;
      const windowHours = document.getElementById('filter-window-hours').value;
      const ordered = document.getElementById('filter-ordered').checked;

      const sp = new URLSearchParams();
      sp.set('minLen', minLen);
      sp.set('maxLen', maxLen);
      if (minAmount > 0) sp.set('minAmount', minAmount);
      if (windowHours) sp.set('windowHours', windowHours);
      if (ordered) sp.set('ordered', 'true');

      url = `/api/fraud/cycles/long?${sp.toString()}`;
    } else {
      url = `/api/fraud/patterns?type=${currentPatternType}`;
    }

    const res = await fetch(url, { headers: getAdminHeaders() });
    const data = await res.json();
    loading.style.display = 'none';

    if (!res.ok) {
      if (errorBox) {
        errorBox.style.display = 'block';
        if (errorMsg) errorMsg.textContent = 'Lỗi truy vấn Cypher: ' + (data.error || res.statusText);
      }
      empty.style.display = 'none';
      tableWrap.style.display = 'none';
      durationLabel.textContent = '0 ms';
      countBadge.textContent = '0 phát hiện';
      return;
    }

    durationLabel.textContent = `${data.durationMs || 0} ms`;
    const count = data.count || 0;
    countBadge.textContent = `${count} phát hiện`;

    if (count === 0) {
      empty.style.display = 'block';
      tableWrap.style.display = 'none';
      return;
    }

    tableWrap.style.display = 'block';

    if (currentPatternType === 'cycles') {
      thead.innerHTML = `
        <tr>
          <th style="width:50px;">STT</th>
          <th style="width:75px;">Độ dài</th>
          <th>Đường đi chu trình</th>
          <th style="width:90px;">Số GD</th>
          <th>Tổng tiền chu trình</th>
          <th>Thời gian</th>
          <th style="width:130px;">Hành động</th>
        </tr>
      `;
      tbody.innerHTML = (data.cycles || []).map((c, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><span class="pill pill-info">${c.length} đỉnh</span></td>
          <td><b style="color:var(--danger)">${c.path}</b></td>
          <td>${(c.txIds || []).length} GD</td>
          <td style="color:var(--danger); font-weight:600;">${Number(c.totalAmount).toLocaleString('vi-VN')} VNĐ</td>
          <td>${Math.round(c.durationMs / 60000)} phút</td>
          <td>
            <button class="btn-sm btn-outline" onclick="viewPatternOnGraph(${JSON.stringify(c.accounts).replace(/"/g, '&quot;')})">
              Xem trên đồ thị
            </button>
          </td>
        </tr>
      `).join('');
    } else if (currentPatternType === 'structuring') {
      thead.innerHTML = `
        <tr>
          <th style="width:50px;">STT</th>
          <th>Cặp Tài Khoản (Nguồn → Đích)</th>
          <th>Số giao dịch (&lt; 10M)</th>
          <th>Tổng tiền gom (≥ 20M)</th>
          <th>Thời gian gom</th>
          <th>Mức độ</th>
          <th style="width:130px;">Hành động</th>
        </tr>
      `;
      tbody.innerHTML = (data.items || []).map((it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><b>${it.accounts[0]}</b> → <b>${it.accounts[1]}</b></td>
          <td><span class="pill pill-warning">${it.evidence.txCount} GD</span></td>
          <td style="color:var(--warning); font-weight:600;">${Number(it.evidence.totalAmount).toLocaleString('vi-VN')} VNĐ</td>
          <td>${it.evidence.spanHours} giờ</td>
          <td><span class="pill pill-danger">${it.severity}</span></td>
          <td>
            <button class="btn-sm btn-outline" onclick="viewPatternOnGraph(${JSON.stringify(it.accounts).replace(/"/g, '&quot;')})">
              Xem trên đồ thị
            </button>
          </td>
        </tr>
      `).join('');
    } else if (currentPatternType === 'passthrough') {
      thead.innerHTML = `
        <tr>
          <th style="width:50px;">STT</th>
          <th>TK Trung Gian (Mule account)</th>
          <th>Nguồn nạp (≥ 3 TK)</th>
          <th>Tổng nhận vào</th>
          <th>Tổng chuyển ra</th>
          <th>Tỷ lệ chuyển tiếp (≥ 90%)</th>
          <th style="width:130px;">Hành động</th>
        </tr>
      `;
      tbody.innerHTML = (data.items || []).map((it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><b style="color:var(--danger); font-size:14px;">${it.evidence.midAccount}</b></td>
          <td>${(it.evidence.srcAccounts || it.accounts.slice(1, 1 + (it.evidence.sourceCount || 3))).join(', ')}</td>
          <td style="color:var(--success); font-weight:600;">${Number(it.evidence.totalIn).toLocaleString('vi-VN')} VNĐ</td>
          <td style="color:var(--danger); font-weight:600;">${Number(it.evidence.totalOut).toLocaleString('vi-VN')} VNĐ</td>
          <td><span class="pill pill-danger">${it.evidence.passRatio}</span></td>
          <td>
            <button class="btn-sm btn-outline" onclick="viewPatternOnGraph(${JSON.stringify(it.accounts).replace(/"/g, '&quot;')})">
              Xem trên đồ thị
            </button>
          </td>
        </tr>
      `).join('');
    } else if (currentPatternType === 'fanout') {
      thead.innerHTML = `
        <tr>
          <th style="width:50px;">STT</th>
          <th>Tài Khoản Phân Tán (Nguồn)</th>
          <th>Số lượng tài khoản đích (≥ 8)</th>
          <th>Tổng tiền phân tán</th>
          <th>Thời gian thực hiện</th>
          <th>Mức độ</th>
          <th style="width:130px;">Hành động</th>
        </tr>
      `;
      tbody.innerHTML = (data.items || []).map((it, i) => `
        <tr>
          <td>${i + 1}</td>
          <td><b style="color:var(--danger); font-size:14px;">${it.evidence.srcAccount}</b></td>
          <td><span class="pill pill-warning">${it.evidence.destCount} tài khoản</span></td>
          <td style="color:var(--danger); font-weight:600;">${Number(it.evidence.totalAmount).toLocaleString('vi-VN')} VNĐ</td>
          <td>${it.evidence.spanMinutes} phút</td>
          <td><span class="pill pill-danger">${it.severity}</span></td>
          <td>
            <button class="btn-sm btn-outline" onclick="viewPatternOnGraph(${JSON.stringify(it.accounts).replace(/"/g, '&quot;')})">
              Xem trên đồ thị
            </button>
          </td>
        </tr>
      `).join('');
    }
  } catch (err) {
    loading.style.display = 'none';
    if (errorBox) {
      errorBox.style.display = 'block';
      if (errorMsg) errorMsg.textContent = 'Lỗi kết nối máy chủ: ' + err.message;
    }
    empty.style.display = 'none';
    tableWrap.style.display = 'none';
  }
}

function viewPatternOnGraph(accounts) {
  if (!accounts || accounts.length === 0) return;
  switchTab('overview');
  setTimeout(() => {
    focusNodes(accounts);
    showToast(`Đã khoanh vùng ${accounts.length} tài khoản thuộc mẫu trên đồ thị`, 'primary');
  }, 350);
}

async function seedPatternsWithConfirm() {
  if (!confirm('Xác nhận nạp dữ liệu mẫu cho 3 mẫu gian lận (Structuring, Mule account, Rapid Fan-out)?\n\nHệ thống sẽ thêm 15 giao dịch tuân thủ DAG trên nhóm ACC034-ACC050 và không làm phát sinh chu trình mới.')) {
    return;
  }

  try {
    const res = await fetch('/api/admin/seed-patterns', {
      method: 'POST',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message, 'success');
      runDeepAnalysis();
      scanFraudCycles();
    } else {
      showToast(data.error || 'Lỗi nạp mẫu', 'danger');
    }
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'danger');
  }
}

// ================= 5. CYPHER QUÉT GIAN LẬN & ĐỒ THỊ VIS-NETWORK =================
async function scanFraudCycles() {
  const windowHours = document.getElementById('filter-window').value;
  const minAmount = document.getElementById('filter-min-amount').value;

  const params = new URLSearchParams();
  if (windowHours) params.set('windowHours', windowHours);
  if (minAmount) params.set('minAmount', minAmount);

  try {
    const res = await fetch(`/api/fraud/cycles?${params.toString()}`, { headers: getAdminHeaders() });
    const data = await res.json();
    lastGraphData = data;

    // Cập nhật KPI số liệu thật với animation nhảy số mượt
    animateValue('kpi-total-accounts', animatedKpis.totalAccounts, data.summary.totalNodes);
    animatedKpis.totalAccounts = data.summary.totalNodes;

    animateValue('kpi-total-tx', animatedKpis.totalTx, data.summary.totalEdges);
    animatedKpis.totalTx = data.summary.totalEdges;

    animateValue('kpi-fraud-cycles', animatedKpis.fraudCycles, data.summary.cycleCount);
    animatedKpis.fraudCycles = data.summary.cycleCount;

    const fraudAccEl = document.getElementById('kpi-fraud-accounts');
    if (fraudAccEl) fraudAccEl.textContent = `${data.summary.fraudAccountCount} tài khoản trong vòng lặp`;

    // Ô chu trình có viền đỏ nhẹ khi > 0
    const fraudCard = document.getElementById('kpi-fraud-card');
    if (fraudCard) {
      if (data.summary.cycleCount > 0) {
        fraudCard.classList.add('has-fraud');
      } else {
        fraudCard.classList.remove('has-fraud');
      }
    }

    const badgeCycles = document.getElementById('badge-cycles');
    if (badgeCycles) {
      badgeCycles.textContent = data.summary.cycleCount;
      if (data.summary.cycleCount > 0) {
        badgeCycles.classList.add('danger');
      } else {
        badgeCycles.classList.remove('danger');
      }
    }

    const badgeAccounts = document.getElementById('badge-accounts');
    if (badgeAccounts) badgeAccounts.textContent = data.summary.totalNodes;

    const graphStats = document.getElementById('graph-stats');
    if (graphStats) {
      graphStats.innerHTML = `Mạng lưới: <b>${data.summary.totalNodes}</b> TK, <b>${data.summary.totalEdges}</b> GD | Cảnh báo: <b style="color:var(--danger)">${data.summary.cycleCount} chu trình (${data.summary.fraudAccountCount} TK)</b>`;
    }

    // ACCORDION CHU TRÌNH LUÂN CHUYỂN KHÉP KÍN
    const accordion = document.getElementById('fraud-accordion');
    const titleEl = document.getElementById('fraud-banner-title');
    const listEl = document.getElementById('fraud-cycles-list');

    if (data.cycles && data.cycles.length > 0) {
      if (accordion) accordion.style.display = 'block';
      if (titleEl) {
        titleEl.textContent = `PHÁT HIỆN ${data.cycles.length} CHU TRÌNH LUÂN CHUYỂN KHÉP KÍN (A → B → C → A)`;
      }

      if (listEl) {
        listEl.innerHTML = data.cycles.map((c, i) => {
          const accIds = c.accounts.map(a => a.accountId);
          const pathString = `${accIds.join(' → ')} → ${accIds[0]}`;

          // Rút gọn mã TX còn 6 ký tự cuối, tooltip hiển thị toàn bộ
          const txChips = c.txIds.map(tx => {
            const shortTx = tx.length > 6 ? tx.slice(-6) : tx;
            return `<span class="cycle-chip" title="Mã GD đầy đủ: ${tx}">TX:...${shortTx}</span>`;
          }).join('');

          return `
            <div class="cycle-card">
              <div class="cycle-card-line1">
                <span class="cycle-path-mono">#${i + 1}: ${pathString}</span>
                <button class="btn-zoom-cycle" onclick="focusNodes(${JSON.stringify(accIds)})">Zoom chu trình</button>
              </div>
              <div class="cycle-card-line2">
                <span class="cycle-chip amount">Tổng: ${Number(c.totalAmount).toLocaleString('vi-VN')} VNĐ</span>
                <span class="cycle-chip">TG: ${c.durationText}</span>
                ${txChips}
              </div>
            </div>
          `;
        }).join('');
      }
    } else {
      if (accordion) accordion.style.display = 'none';
      if (listEl) listEl.innerHTML = '';
    }

    renderCurrentGraph();
  } catch (err) {
    console.error('Lỗi quét chu trình:', err);
  }
}

// Bật / tắt hiển thị node cô lập (Yêu cầu 4)
function toggleIsolatedNodes() {
  showIsolatedNodes = !showIsolatedNodes;
  const btn = document.getElementById('btn-toggle-isolated');
  if (btn) {
    if (showIsolatedNodes) {
      btn.classList.add('active');
      btn.style.background = 'var(--primary-glow)';
      btn.style.borderColor = 'var(--primary)';
    } else {
      btn.classList.remove('active');
      btn.style.background = '#ffffff';
      btn.style.borderColor = 'var(--border-light)';
    }
  }
  renderCurrentGraph();
}

// Căn khung và toolbar hỗ trợ đồ thị
function resetGraphFit() {
  if (networkInstance) {
    networkInstance.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  }
}

function toggleOnlyCyclesView() {
  const sel = document.getElementById('graph-view-mode');
  if (!sel) return;
  sel.value = sel.value === 'fraud_only' ? 'all' : 'fraud_only';
  renderCurrentGraph();
}

// Render vis-network:
// - Chế độ "fraud_only": Bỏ physics, bố trí mỗi chu trình thành tam giác đều trên lưới (tối đa 4 cột) (Yêu cầu 5)
// - Chế độ "all": Ẩn node cô lập (khi showIsolatedNodes=false), node đỏ có nhãn 11px nền trắng mờ, node thường không nhãn (hover hiện), fit >= 80% (Yêu cầu 4)
function renderCurrentGraph() {
  if (!lastGraphData) return;
  const viewMode = document.getElementById('graph-view-mode').value;
  const container = document.getElementById('network-container');
  if (!container) return;

  // ================= CHẾ ĐỘ 1: CHỈ HIỆN CHU TRÌNH (YÊU CẦU 5) =================
  if (viewMode === 'fraud_only') {
    const cycles = lastGraphData.cycles || [];
    const triangleNodes = [];
    const triangleEdges = [];

    const numCycles = cycles.length;
    const cols = Math.min(4, Math.max(1, numCycles));
    const cellWidth = 260;
    const cellHeight = 220;
    const radius = 55;

    cycles.forEach((c, cIdx) => {
      const col = cIdx % cols;
      const row = Math.floor(cIdx / cols);
      const cx = col * cellWidth + cellWidth / 2;
      const cy = row * cellHeight + cellHeight / 2 + 15;

      // 3 đỉnh tam giác đều: Đỉnh 1 trên, Đỉnh 2 dưới phải, Đỉnh 3 dưới trái
      const accA = c.accounts[0];
      const accB = c.accounts[1];
      const accC = c.accounts[2];

      const pA = { x: cx, y: cy - radius };
      const pB = { x: cx + radius * Math.cos(Math.PI / 6), y: cy + radius * Math.sin(Math.PI / 6) };
      const pC = { x: cx - radius * Math.cos(Math.PI / 6), y: cy + radius * Math.sin(Math.PI / 6) };

      const vNodes = [
        { id: `${c.cycleId}_${accA.accountId}`, label: accA.accountId, x: pA.x, y: pA.y, accId: accA.accountId, name: accA.ownerName },
        { id: `${c.cycleId}_${accB.accountId}`, label: accB.accountId, x: pB.x, y: pB.y, accId: accB.accountId, name: accB.ownerName },
        { id: `${c.cycleId}_${accC.accountId}`, label: accC.accountId, x: pC.x, y: pC.y, accId: accC.accountId, name: accC.ownerName }
      ];

      vNodes.forEach(vn => {
        triangleNodes.push({
          id: vn.id,
          label: vn.label,
          x: vn.x,
          y: vn.y,
          fixed: true,
          physics: false,
          size: 20,
          color: { background: '#dc2626', border: '#fca5a5', highlight: { background: '#b91c1c', border: '#ffffff' } },
          font: { color: '#991b1b', size: 11, bold: true, background: 'rgba(255, 255, 255, 0.92)', strokeWidth: 0 },
          borderWidth: 2.5,
          title: `Tài khoản: ${vn.accId} — ${vn.name}`
        });
      });

      // Tìm số tiền của các cạnh A->B, B->C, C->A
      const findEdgeAmount = (from, to) => {
        const found = lastGraphData.edges.find(e => e.from === from && e.to === to);
        return found ? `${Number(found.amount).toLocaleString('vi-VN')} đ` : '';
      };

      triangleEdges.push({
        from: `${c.cycleId}_${accA.accountId}`,
        to: `${c.cycleId}_${accB.accountId}`,
        arrows: 'to',
        color: { color: '#dc2626', highlight: '#ef4444' },
        width: 2.5,
        label: findEdgeAmount(accA.accountId, accB.accountId),
        font: { color: '#991b1b', size: 10, background: 'rgba(255,255,255,0.85)', strokeWidth: 0 }
      });
      triangleEdges.push({
        from: `${c.cycleId}_${accB.accountId}`,
        to: `${c.cycleId}_${accC.accountId}`,
        arrows: 'to',
        color: { color: '#dc2626', highlight: '#ef4444' },
        width: 2.5,
        label: findEdgeAmount(accB.accountId, accC.accountId),
        font: { color: '#991b1b', size: 10, background: 'rgba(255,255,255,0.85)', strokeWidth: 0 }
      });
      triangleEdges.push({
        from: `${c.cycleId}_${accC.accountId}`,
        to: `${c.cycleId}_${accA.accountId}`,
        arrows: 'to',
        color: { color: '#dc2626', highlight: '#ef4444' },
        width: 2.5,
        label: findEdgeAmount(accC.accountId, accA.accountId),
        font: { color: '#991b1b', size: 10, background: 'rgba(255,255,255,0.85)', strokeWidth: 0 }
      });

      // Tiêu đề nhỏ "Chu trình #N" đặt phía trên tam giác
      triangleNodes.push({
        id: `TITLE_${c.cycleId}`,
        label: `Chu trình #${cIdx + 1}`,
        x: cx,
        y: cy - radius - 26,
        shape: 'box',
        margin: 5,
        color: { background: '#fef2f2', border: '#fecaca', highlight: { background: '#fee2e2', border: '#f87171' } },
        font: { color: '#991b1b', size: 11, bold: true },
        fixed: true,
        physics: false
      });
    });

    const options = {
      physics: { enabled: false },
      interaction: { hover: true, tooltipDelay: 100, zoomView: true, dragView: true }
    };

    networkInstance = new vis.Network(
      container,
      { nodes: new vis.DataSet(triangleNodes), edges: new vis.DataSet(triangleEdges) },
      options
    );

    networkInstance.fit({ animation: false });

    networkInstance.on('click', function (params) {
      if (params.nodes && params.nodes.length > 0) {
        const clickedId = params.nodes[0];
        if (clickedId.startsWith('TITLE_')) return;
        const realAccId = clickedId.includes('_') ? clickedId.split('_').slice(1).join('_') : clickedId;
        const lookupInput = document.getElementById('lookup-account-id');
        if (lookupInput) {
          lookupInput.value = realAccId;
          lookupAccountDetail();
        }
      }
    });
    return;
  }

  // ================= CHẾ ĐỘ 2: TOÀN BỘ MẠNG LƯỚI (YÊU CẦU 4) =================
  const allNodes = lastGraphData.nodes || [];
  const allEdges = lastGraphData.edges || [];

  // Xác định các node có giao dịch (connected nodes)
  const connectedNodeIds = new Set();
  for (const e of allEdges) {
    connectedNodeIds.add(e.from);
    connectedNodeIds.add(e.to);
  }
  for (const n of allNodes) {
    if (n.isFraud) connectedNodeIds.add(n.id);
  }

  // Đếm số node cô lập để hiển thị trên chip chú giải (Yêu cầu 4)
  const isolatedCount = allNodes.filter(n => !connectedNodeIds.has(n.id)).length;
  const isolatedLabel = document.getElementById('isolated-count-label');
  if (isolatedLabel) isolatedLabel.textContent = isolatedCount;

  // Lọc: nếu showIsolatedNodes = false thì ẩn các node không có cạnh nào
  const renderNodes = showIsolatedNodes
    ? allNodes
    : allNodes.filter(n => connectedNodeIds.has(n.id));

  // Node chu trình: đỏ, to, LUÔN hiện nhãn 11px; Node MEDIUM rủi ro: viền vàng; Node thường: nhỏ, xám (hover hiện)
  const visNodes = new vis.DataSet(renderNodes.map(n => {
    const risk = cachedRiskScores[n.id];
    const isMedium = risk && risk.level === 'MEDIUM';
    const isHigh = n.isFraud || (risk && risk.level === 'HIGH');

    let nodeColor;
    let borderWidth = 1;
    let nodeSize = 11;

    if (n.isFraud || isHigh) {
      nodeColor = { background: '#dc2626', border: '#fca5a5', highlight: { background: '#b91c1c', border: '#ffffff' } };
      borderWidth = 2.5;
      nodeSize = 20;
    } else if (isMedium) {
      nodeColor = { background: '#f8fafc', border: '#eab308', highlight: { background: '#fef08a', border: '#ca8a04' } };
      borderWidth = 2.5;
      nodeSize = 14;
    } else {
      nodeColor = { background: '#94a3b8', border: '#64748b', highlight: { background: '#475569', border: '#ffffff' } };
      borderWidth = 1;
      nodeSize = 11;
    }

    const riskInfo = risk ? `\nChỉ số rủi ro: ${risk.score}/100 (${risk.level})` : '';

    return {
      id: n.id,
      label: n.isFraud ? n.id : '',
      title: `${n.isFraud ? '🚨 CHU TRÌNH LUÂN CHUYỂN KHÉP KÍN\n' : ''}Tài khoản: ${n.id} — ${n.ownerName}\nSố dư: ${Number(n.balance).toLocaleString('vi-VN')} VNĐ\nTrạng thái: ${n.status}${riskInfo}`,
      color: nodeColor,
      font: {
        color: '#991b1b',
        size: 11,
        bold: true,
        background: 'rgba(255, 255, 255, 0.92)',
        strokeWidth: 0
      },
      size: nodeSize,
      borderWidth
    };
  }));

  // Cạnh bình thường: mờ mảnh; Cạnh chu trình: đỏ dày 2.5px có mũi tên
  const visEdges = new vis.DataSet(allEdges.map(e => ({
    id: e.id,
    from: e.from,
    to: e.to,
    label: e.isFraud ? `${(Number(e.amount) / 1000000).toFixed(0)}M` : '',
    title: `Mã GD: ${e.id}\nSố tiền: ${Number(e.amount).toLocaleString('vi-VN')} VNĐ\nThời gian: ${new Date(e.timestamp).toLocaleString('vi-VN')}\nGhi chú: ${e.note}`,
    arrows: { to: { enabled: true, scaleFactor: e.isFraud ? 0.9 : 0.5 } },
    color: e.isFraud
      ? { color: '#dc2626', opacity: 1, highlight: '#ef4444' }
      : { color: '#cbd5e1', opacity: 0.6, highlight: '#94a3b8' },
    width: e.isFraud ? 2.5 : 1,
    font: { color: '#dc2626', size: 10, strokeWidth: 2, strokeColor: '#ffffff' }
  })));

  const options = {
    physics: {
      enabled: true,
      stabilization: {
        enabled: true,
        iterations: 150,
        updateInterval: 25
      },
      barnesHut: {
        gravitationalConstant: -1600,
        springLength: 90,
        springConstant: 0.05,
        damping: 0.09
      }
    },
    interaction: {
      hover: true,
      tooltipDelay: 100,
      zoomView: true,
      dragView: true
    }
  };

  networkInstance = new vis.Network(container, { nodes: visNodes, edges: visEdges }, options);

  // Sau khi mạng lưới ổn định: fit() vừa vặn khung hình, zoom để chiếm >= 80% chiều rộng khung rồi TẮT PHYSICS (Yêu cầu 4)
  networkInstance.once('stabilizationIterationsDone', function () {
    networkInstance.fit();
    const curScale = networkInstance.getScale();
    networkInstance.moveTo({ scale: curScale * 1.35 });
    networkInstance.setOptions({ physics: { enabled: false } });
  });

  networkInstance.on('click', function (params) {
    if (params.nodes && params.nodes.length > 0) {
      const clickedAccountId = params.nodes[0];
      const lookupInput = document.getElementById('lookup-account-id');
      if (lookupInput) {
        lookupInput.value = clickedAccountId;
        lookupAccountDetail();
      }
    }
  });
}

// Nút Zoom chu trình tự căn khung mượt mà
function focusNodes(nodeIds) {
  if (!networkInstance) return;
  networkInstance.fit({
    nodes: nodeIds,
    animation: { duration: 600, easingFunction: 'easeInOutQuad' }
  });
  networkInstance.selectNodes(nodeIds);
}

// ================= 6. SỔ PHỤ & CRUD TÀI KHOẢN =================
async function lookupAccountDetail() {
  const accountId = document.getElementById('lookup-account-id').value.trim();
  if (!accountId) return;

  const box = document.getElementById('account-history-box');
  try {
    const [accRes, txRes] = await Promise.all([
      fetch(`/api/accounts/${accountId}`, { headers: getAdminHeaders() }),
      fetch(`/api/accounts/${accountId}/transactions`, { headers: getAdminHeaders() })
    ]);

    if (!accRes.ok) {
      box.innerHTML = `<p style="color:var(--danger)">Không tìm thấy tài khoản ${accountId}</p>`;
      return;
    }

    const acc = await accRes.json();
    const txData = await txRes.json();

    const rows = txData.transactions.map(t => `
      <tr>
        <td><code>${t.txId}</code></td>
        <td><span class="pill ${t.direction === 'OUTGOING' ? 'pill-warning' : 'pill-success'}">${t.direction === 'OUTGOING' ? 'Chuyển đi' : 'Nhận vào'}</span></td>
        <td><b>${t.fromAccount} → ${t.toAccount}</b></td>
        <td><b>${Number(t.amount).toLocaleString('vi-VN')} đ</b></td>
        <td>${new Date(t.timestamp).toLocaleString('vi-VN')}</td>
        <td>${t.note}</td>
      </tr>
    `).join('');

    box.innerHTML = `
      <div style="margin-bottom:8px; font-size:12px; display:flex; justify-content:space-between; flex-wrap:wrap;">
        <div>Tài khoản: <b>${acc.accountId}</b> — Chủ TK: <b>${acc.ownerName}</b></div>
        <div>Số dư: <b style="color:var(--success)">${Number(acc.balance).toLocaleString('vi-VN')} VNĐ</b> | Trạng thái: <b>${acc.status}</b></div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Mã GD</th>
            <th>Chiều</th>
            <th>Luồng tiền</th>
            <th>Số tiền</th>
            <th>Thời gian</th>
            <th>Nội dung</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="6" style="text-align:center;">Chưa có giao dịch phát sinh</td></tr>'}</tbody>
      </table>
    `;
  } catch (err) {
    box.innerHTML = `<p style="color:var(--danger)">Lỗi: ${err.message}</p>`;
  }
}

async function loadAllAccountsForDropdown() {
  const res = await fetch('/api/accounts', { headers: getAdminHeaders() });
  const data = await res.json();
  cachedAccounts = data.accounts || [];

  const fromSel = document.getElementById('full-tx-from');
  const toSel = document.getElementById('full-tx-to');
  if (!fromSel || !toSel) return;

  const optionsHtml = cachedAccounts.map(a =>
    `<option value="${a.accountId}">${a.accountId} — ${a.ownerName} (${Number(a.balance).toLocaleString('vi-VN')} đ)</option>`
  ).join('');

  fromSel.innerHTML = optionsHtml;
  toSel.innerHTML = optionsHtml;
  if (cachedAccounts.length > 31) {
    fromSel.value = 'ACC030';
    toSel.value = 'ACC031';
  }
}

async function loadAccountsCrudTable() {
  await loadRiskScores();
  const res = await fetch('/api/accounts', { headers: getAdminHeaders() });
  const data = await res.json();
  cachedAccounts = data.accounts || [];
  renderAccountsCrudRows(cachedAccounts);
}

function renderAccountsCrudRows(list) {
  const tbody = document.getElementById('accounts-crud-tbody');
  if (!tbody) return;
  tbody.innerHTML = list.map(a => {
    const statusPill = a.status === 'ACTIVE'
      ? `<span class="pill pill-success">ACTIVE</span>`
      : `<span class="pill pill-danger">${a.status}</span>`;

    const risk = cachedRiskScores[a.accountId] || { score: 0, level: 'LOW', factors: {} };
    let riskPill = `<span class="pill pill-muted" title="${formatRiskTooltip(risk)}">LOW (${risk.score})</span>`;
    if (risk.level === 'HIGH') {
      riskPill = `<span class="pill pill-danger" title="${formatRiskTooltip(risk)}">HIGH (${risk.score})</span>`;
    } else if (risk.level === 'MEDIUM') {
      riskPill = `<span class="pill pill-warning" title="${formatRiskTooltip(risk)}">MEDIUM (${risk.score})</span>`;
    }

    return `
      <tr>
        <td><b>${a.accountId}</b></td>
        <td>${a.ownerName}</td>
        <td style="color:var(--success); font-weight:600;">${Number(a.balance).toLocaleString('vi-VN')} VNĐ</td>
        <td>${statusPill}</td>
        <td>${riskPill}</td>
        <td>${new Date(a.createdAt).toLocaleDateString('vi-VN')}</td>
        <td style="display:flex; gap:6px;">
          <button class="btn-sm btn-outline" onclick="openEditAccountModal('${a.accountId}')">Sửa</button>
          <button class="btn-sm btn-outline" style="border-color:var(--warning); color:var(--warning);" onclick="toggleCloseAccount('${a.accountId}', '${a.status}')">${a.status === 'ACTIVE' ? 'Đóng TK' : 'Mở lại'}</button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAccountTable() {
  const q = document.getElementById('account-search-input').value.toLowerCase().trim();
  const filtered = cachedAccounts.filter(a =>
    a.accountId.toLowerCase().includes(q) || a.ownerName.toLowerCase().includes(q)
  );
  renderAccountsCrudRows(filtered);
}

function openCreateAccountModal() {
  document.getElementById('modal-mode').value = 'create';
  document.getElementById('modal-account-title').textContent = 'Mở Tài Khoản Mới';
  document.getElementById('modal-account-id').disabled = false;
  document.getElementById('modal-account-id').value = `ACC0${cachedAccounts.length + 1}`;
  document.getElementById('modal-owner-name').value = '';
  document.getElementById('modal-balance').value = 50000000;
  document.getElementById('account-modal').classList.add('open');
}

function openEditAccountModal(accountId) {
  const acc = cachedAccounts.find(a => a.accountId === accountId);
  if (!acc) return;
  document.getElementById('modal-mode').value = 'edit';
  document.getElementById('modal-account-title').textContent = `Cập Nhật Tài Khoản ${accountId}`;
  document.getElementById('modal-account-id').disabled = true;
  document.getElementById('modal-account-id').value = acc.accountId;
  document.getElementById('modal-owner-name').value = acc.ownerName;
  document.getElementById('modal-balance').value = acc.balance;
  document.getElementById('account-modal').classList.add('open');
}

function closeAccountModal() {
  document.getElementById('account-modal').classList.remove('open');
}

async function saveAccountModal() {
  const mode = document.getElementById('modal-mode').value;
  const accountId = document.getElementById('modal-account-id').value.trim();
  const ownerName = document.getElementById('modal-owner-name').value.trim();
  const balance = Number(document.getElementById('modal-balance').value);
  const password = document.getElementById('modal-password').value;

  if (!accountId || !ownerName) {
    showToast('Vui lòng nhập đầy đủ Mã TK và Họ tên!', 'warning');
    return;
  }

  const url = mode === 'create' ? '/api/accounts' : `/api/accounts/${accountId}`;
  const method = mode === 'create' ? 'POST' : 'PUT';

  const res = await fetch(url, {
    method,
    headers: getAdminHeaders(),
    body: JSON.stringify({ accountId, ownerName, balance, password })
  });
  const data = await res.json();

  if (res.ok) {
    showToast(data.message, 'success');
    closeAccountModal();
    await loadAccountsCrudTable();
    await scanFraudCycles();
  } else {
    showToast(data.error, 'danger');
  }
}

async function toggleCloseAccount(accountId, currentStatus) {
  if (currentStatus === 'ACTIVE') {
    const res = await fetch(`/api/accounts/${accountId}`, {
      method: 'DELETE',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    showToast(data.message, 'warning');
  } else {
    const res = await fetch(`/api/accounts/${accountId}`, {
      method: 'PUT',
      headers: getAdminHeaders(),
      body: JSON.stringify({ status: 'ACTIVE' })
    });
    const data = await res.json();
    showToast(`Đã kích hoạt lại tài khoản ${accountId}`, 'success');
  }
  await loadAccountsCrudTable();
}

async function resetDemoData() {
  if (!confirm('Khôi phục toàn bộ dữ liệu (50 Tài khoản, 3 Chu trình & bộ đếm Redis) về trạng thái ban đầu?')) return;
  try {
    const res = await fetch('/api/admin/seed-reset', {
      method: 'POST',
      headers: getAdminHeaders()
    });
    const data = await res.json();
    showToast(data.message, 'success');
    await checkSystemHealth();
    await loadSecurityStatus();
    await scanFraudCycles();
    await lookupAccountDetail();
    await loadAccountsCrudTable();
  } catch (err) {
    showToast('Lỗi reset dữ liệu: ' + err.message, 'danger');
  }
}

// ==================== NHẬT KÝ SỰ KIỆN TRỰC TIẾP (REDIS STREAM SSE) ====================
let isStreamPaused = false;
let streamEventCount = 0;
let sseReader = null;
let sseAbortController = null;

function toggleLiveEventsPanel() {
  const panel = document.getElementById('live-events-panel');
  const icon = document.getElementById('events-panel-toggle-icon');
  if (!panel) return;
  panel.classList.toggle('collapsed');
  if (icon) {
    icon.textContent = panel.classList.contains('collapsed') ? '▲' : '▼';
  }
}

function togglePauseStream(e) {
  if (e) e.stopPropagation();
  isStreamPaused = !isStreamPaused;
  const btn = document.getElementById('btn-pause-stream');
  if (btn) {
    btn.textContent = isStreamPaused ? 'Tiếp tục' : 'Tạm dừng';
    btn.className = isStreamPaused ? 'btn-sm btn-outline-warning' : 'btn-sm btn-outline';
  }
}

function formatEventTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts) || ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function renderEventBadge(type) {
  switch (type) {
    case 'LOGIN_FAIL':
      return { class: 'warning', text: 'Sai MK', icon: '⚠️' };
    case 'LOGIN_OK':
      return { class: 'success', text: 'Đăng nhập', icon: '✅' };
    case 'ACCOUNT_LOCKED':
      return { class: 'danger', text: 'Khóa TK', icon: '🔒' };
    case 'IP_BLOCKED':
      return { class: 'danger', text: 'Chặn IP', icon: '🛡️' };
    case 'ACCOUNT_FROZEN':
      return { class: 'danger', text: 'Phong tỏa', icon: '❄️' };
    case 'CYCLE_DETECTED':
      return { class: 'danger', text: 'Chu trình', icon: '🚨' };
    case 'TX_BLOCKED':
      return { class: 'danger', text: 'Chặn GD', icon: '🚫' };
    case 'SESSION_REVOKED':
      return { class: 'warning', text: 'Hủy phiên', icon: '🚪' };
    default:
      return { class: 'primary', text: type, icon: 'ℹ️' };
  }
}

function appendLiveEvent(eventData) {
  if (isStreamPaused || !eventData) return;

  const list = document.getElementById('live-events-list');
  if (!list) return;
  if (eventData.id && document.getElementById('ev-row-' + eventData.id)) return;

  // Xóa thông báo chờ ban đầu
  if (list.children.length === 1 && list.children[0].textContent.includes('Đang kết nối')) {
    list.innerHTML = '';
  }

  streamEventCount++;
  const badge = document.getElementById('events-count-badge');
  if (badge) badge.textContent = streamEventCount;

  const meta = renderEventBadge(eventData.type);
  const timeStr = formatEventTime(eventData.ts);

  const row = document.createElement('div');
  row.className = `event-item-row ${meta.class}`;
  row.innerHTML = `
    <span class="event-time">${timeStr}</span>
    <span style="font-weight:700;">${meta.icon} [${meta.text}]</span>
    <span class="event-body"><b>${eventData.accountId || ''}</b> ${eventData.detail || ''}</span>
  `;

  list.insertBefore(row, list.firstChild);

  while (list.children.length > 50) {
    list.removeChild(list.lastChild);
  }

  // Toast thông báo các sự kiện quan trọng
  if (eventData.type === 'ACCOUNT_LOCKED') {
    showToast(`Khóa tài khoản ${eventData.accountId}: ${eventData.detail}`, 'danger');
  } else if (eventData.type === 'IP_BLOCKED') {
    showToast(`Chặn IP ${eventData.ip}: ${eventData.detail}`, 'danger');
  } else if (eventData.type === 'CYCLE_DETECTED') {
    showToast(`Phát hiện chu trình: ${eventData.detail}`, 'danger');
  }
}

let lastPollEventId = null;
async function pollEventsFallback() {
  try {
    const res = await fetch('/api/events?limit=20', { headers: getAdminHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (data.events && Array.isArray(data.events)) {
      const newEvents = lastPollEventId
        ? data.events.filter(e => e.id > lastPollEventId)
        : data.events.slice(0, 5);

      if (data.events.length > 0) {
        lastPollEventId = data.events[0].id;
      }

      for (let i = newEvents.length - 1; i >= 0; i--) {
        appendLiveEvent(newEvents[i]);
      }
    }
  } catch (_) {}
}

async function initLiveEventsStream() {
  try {
    // Nạp ngay các sự kiện gần nhất từ Redis để bảng không bị chờ
    pollEventsFallback();
    if (sseAbortController) {
      sseAbortController.abort();
    }
    sseAbortController = new AbortController();

    const res = await fetch('/api/events/stream', {
      headers: getAdminHeaders(),
      signal: sseAbortController.signal
    });

    if (!res.ok) {
      throw new Error(`SSE status ${res.status}`);
    }

    const reader = res.body.getReader();
    sseReader = reader;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop();

      for (const block of blocks) {
        if (!block.trim() || block.startsWith(':')) continue;
        const lines = block.split('\n');
        let dataStr = '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            dataStr = line.substring(5).trim();
          }
        }
        if (dataStr) {
          try {
            const parsed = JSON.parse(dataStr);
            appendLiveEvent(parsed);
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.warn('SSE stream gián đoạn, chuyển sang chế độ Polling 3s:', err.message);
    pollEventsFallback();
  }
}

// ==================== MÔ PHỎNG DICTIONARY ATTACK (DEMO ATTACK) ====================
async function runDictionaryAttackSimulation() {
  const accInput = document.getElementById('attack-target-account');
  const modeSelect = document.getElementById('attack-mode');
  const attemptsInput = document.getElementById('attack-attempts');
  const delayInput = document.getElementById('attack-delay');
  const btn = document.getElementById('btn-run-attack');
  const summaryBox = document.getElementById('attack-summary-box');
  const chipsContainer = document.getElementById('attack-summary-chips');

  const accountId = (accInput ? accInput.value : '').trim();
  if (!accountId) {
    showToast('Vui lòng nhập tài khoản mục tiêu', 'warning');
    return;
  }

  const mode = modeSelect ? modeSelect.value : 'single';
  const attempts = Number(attemptsInput?.value) || 50;
  const delayMs = Number(delayInput?.value) || 50;

  setButtonLoading(btn, true, 'Đang tấn công...');
  if (summaryBox) summaryBox.style.display = 'none';
  const livePanel = document.getElementById('live-events-panel');
  if (livePanel && livePanel.classList.contains('collapsed')) {
    livePanel.classList.remove('collapsed');
  }

  try {
    const res = await fetch('/api/demo/attack', {
      method: 'POST',
      headers: getAdminHeaders(),
      body: JSON.stringify({ accountId, mode, attempts, delayMs })
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Lỗi khi chạy tấn công', 'danger');
      return;
    }

    if (summaryBox && chipsContainer) {
      summaryBox.style.display = 'block';
      chipsContainer.innerHTML = `
        <span class="pill pill-primary">Tổng thử: ${data.attempts}</span>
        <span class="pill pill-warning">401 Sai MK: ${data.status401}</span>
        <span class="pill pill-danger">429 Bị chặn: ${data.status429}</span>
        <span class="pill ${data.lockedAtAttempt ? 'pill-danger' : 'pill-success'}">Khóa TK: ${data.lockedAtAttempt ? `Lượt #${data.lockedAtAttempt}` : 'Chưa khóa'}</span>
        <span class="pill ${data.ipBlockedAtAttempt ? 'pill-danger' : 'pill-success'}">Chặn IP: ${data.ipBlockedAtAttempt ? `Lượt #${data.ipBlockedAtAttempt}` : 'Chưa chặn'}</span>
        <span class="pill pill-outline">Thời gian: ${data.durationMs}ms</span>
      `;
    }

    showToast(`Hoàn tất mô phỏng: 401 (${data.status401}), 429 (${data.status429})`, 'success');
    await loadSecurityStatus();
  } catch (err) {
    showToast('Lỗi gửi tấn công: ' + err.message, 'danger');
  } finally {
    setButtonLoading(btn, false);
  }
}

// ==================== GIẢI THÍCH TRUY VẤN (CYPHER PROFILE EXPLAIN) ====================
async function runCypherExplain() {
  const select = document.getElementById('explain-query-select');
  const query = select ? select.value : 'cycles3';
  const btn = document.getElementById('btn-run-explain');
  const container = document.getElementById('explain-results-container');

  setButtonLoading(btn, true, 'Đang PROFILE...');
  try {
    const res = await fetch(`/api/fraud/explain?query=${query}`, {
      headers: getAdminHeaders()
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Lỗi khi chạy PROFILE', 'danger');
      return;
    }

    if (container) container.style.display = 'flex';

    const chipTime = document.getElementById('explain-chip-time');
    const chipDbHits = document.getElementById('explain-chip-dbhits');
    const chipRows = document.getElementById('explain-chip-rows');
    const codeEl = document.getElementById('explain-cypher-code');
    const tbody = document.getElementById('explain-plan-tbody');

    if (chipTime) chipTime.textContent = `${data.durationMs} ms`;
    if (chipDbHits) chipDbHits.textContent = Number(data.dbHits || 0).toLocaleString();
    if (chipRows) chipRows.textContent = Number(data.rows || 0).toLocaleString();
    if (codeEl) codeEl.textContent = data.cypher || '';

    if (tbody) {
      const plan = data.plan || [];
      if (plan.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:var(--text-muted)">Không có toán tử nào trong kết quả PROFILE</td></tr>';
      } else {
        tbody.innerHTML = plan.map(op => `
          <tr>
            <td><code style="font-weight:600; color:var(--primary); font-size:11px;">${op.operator}</code></td>
            <td style="font-family:monospace; font-weight:600;">${Number(op.dbHits || 0).toLocaleString()}</td>
            <td style="font-family:monospace;">${Number(op.rows || 0).toLocaleString()}</td>
          </tr>
        `).join('');
      }
    }
    showToast(`Đã phân tích kế hoạch Cypher: ${data.name}`, 'success');
  } catch (err) {
    showToast('Lỗi chạy PROFILE: ' + err.message, 'danger');
  } finally {
    setButtonLoading(btn, false);
  }
}

// Chu kỳ làm mới tự động (cấu hình được qua window.REDIS_REFRESH_INTERVAL_MS, mặc định 10 giây)
window.REDIS_REFRESH_INTERVAL_MS = window.REDIS_REFRESH_INTERVAL_MS || 10000;
let securityStatusIntervalId = null;

function startSecurityStatusPolling() {
  if (securityStatusIntervalId) clearInterval(securityStatusIntervalId);
  securityStatusIntervalId = setInterval(() => {
    if (!document.hidden) {
      loadSecurityStatus();
    }
  }, window.REDIS_REFRESH_INTERVAL_MS);
}

function stopSecurityStatusPolling() {
  if (securityStatusIntervalId) {
    clearInterval(securityStatusIntervalId);
    securityStatusIntervalId = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopSecurityStatusPolling();
  } else {
    loadSecurityStatus();
    startSecurityStatusPolling();
  }
});

// Khởi chạy khi DOM sẵn sàng
window.addEventListener('DOMContentLoaded', () => {
  checkStaffSession();
  checkSystemHealth();
  loadFraudMode();
  loadRiskScores();
  loadFrozenAccounts();
  loadSecurityStatus();
  scanFraudCycles();
  lookupAccountDetail();
  loadAllAccountsForDropdown();
  initLiveEventsStream();
  startSecurityStatusPolling();
  setInterval(pollEventsFallback, 10000);
  setInterval(checkSystemHealth, 10000);
});
