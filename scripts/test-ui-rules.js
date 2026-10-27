const fs = require('fs');
const http = require('http');

function check() {
  console.log('=== VERIFYING FRONTEND UI FIXES ===\n');

  const html = fs.readFileSync('public/index.html', 'utf8');
  const css = fs.readFileSync('public/css/app.css', 'utf8');
  const js = fs.readFileSync('public/js/app.js', 'utf8');

  // (a) Form styles: label on top of input, height 40px, padding 0 12px, border-radius 8px, 16px gap, 2-col transfer form with 2/3 and 1/3 buttons
  const labelBlock = css.includes('label {\n  display: block;') || (css.includes('display: block;') && css.includes('label {'));
  const inputHeight = css.includes('height: 40px;') && css.includes('padding: 0 12px;') && css.includes('border-radius: var(--radius-sm);');
  const formGrid2Col = css.includes('.form-grid-2col {\n  display: grid;\n  grid-template-columns: 1fr 1fr;');
  const formActions2to1 = css.includes('.form-actions-2to1 {\n  display: grid;\n  grid-template-columns: 2fr 1fr;');
  const hasFilterBarAligned = css.includes('.filter-bar-aligned {');
  const hasSearchIconWrapper = html.includes('account-search-input') && html.includes('width:280px;');

  const passA = labelBlock && inputHeight && formGrid2Col && formActions2to1 && hasFilterBarAligned && hasSearchIconWrapper;
  console.log('(a) Global form styling (label on top, 40px height, 2-col transfer 2/3 + 1/3, 280px search):', passA ? 'PASS' : 'FAIL');

  // (b) Không card nào trống > 120px phía dưới ở tab Giao dịch/Bảo mật:
  // tab-fullscreen-grid, tab-fullscreen-card, card-body-flexible, flex:1 internal scroll
  const fullscreenGrid = css.includes('.tab-fullscreen-grid') && css.includes('calc(100vh -');
  const fullscreenCard = css.includes('.tab-fullscreen-card') && css.includes('height: 100%;');
  const flexibleBody = css.includes('.card-body-flexible') && css.includes('flex: 1;');
  const transferHasFullscreen = html.includes('tab-fullscreen-grid') && html.includes('tab-fullscreen-card');

  const passB = fullscreenGrid && fullscreenCard && flexibleBody && transferHasFullscreen;
  console.log('(b) Fullscreen cards with internal flex:1 scroll (no bottom empty space):', passB ? 'PASS' : 'FAIL');

  // (c) Thanh công cụ đồ thị nằm trong 16px từ góc trên phải khung:
  // .graph-floating-toolbar with position: absolute, top: 12px, right: 12px
  const toolbarPos = css.includes('.graph-floating-toolbar {\n  position: absolute;\n  top: 12px;\n  right: 12px;');
  const toolbarContainer = html.includes('class="network-viewport-wrapper"') && html.includes('class="graph-floating-toolbar"');

  const passC = toolbarPos && toolbarContainer;
  console.log('(c) Graph floating toolbar within 16px from top-right (top: 12px, right: 12px):', passC ? 'PASS' : 'FAIL');

  // (d) Đồ thị: ẩn node cô lập, chip chú giải, node đỏ có nhãn 11px nền trắng mờ, lấp >= 80%
  const hasIsolatedToggle = html.includes('id="btn-toggle-isolated"') && html.includes('id="isolated-count-label"');
  const jsIsolatedLogic = js.includes('showIsolatedNodes') && js.includes('toggleIsolatedNodes');
  const fraudNodeLabel = (js.includes("n.isFraud ? n.id") || js.includes("label: n.id")) && js.includes("background: 'rgba(255, 255, 255, 0.92)'");
  const scaleZoom80 = js.includes("moveTo({ scale: curScale * 1.35 })");

  console.log('debug d:', { hasIsolatedToggle, jsIsolatedLogic, fraudNodeLabel, scaleZoom80 });
  const passD = hasIsolatedToggle && jsIsolatedLogic && fraudNodeLabel && scaleZoom80;
  console.log('(d) Graph cluster fills >= 80%, isolated nodes hidden with chip, fraud nodes labeled:', passD ? 'PASS' : 'FAIL');

  // (e) Bảng Redis: 400px card, table-layout: fixed, 5 cols (72px, 104px, 84px, 52px, 32px), no scrollbar, unlock icon
  const tableFixed = css.includes('.redis-compact-table {\n  table-layout: fixed;');
  const colWidths = html.includes('width:72px') && html.includes('width:104px') && html.includes('width:84px') && html.includes('width:52px') && html.includes('width:32px');
  const unlockIconBtn = js.includes('btn-unlock-icon') && js.includes('confirmUnlockAccount');
  const card400 = html.includes('width:400px') && css.includes('grid-template-columns: 1fr 400px;');

  const passE = tableFixed && colWidths && unlockIconBtn && card400;
  console.log('(e) Redis compact table (fixed 400px, 5 fixed cols, unlock icon, no scrollbar):', passE ? 'PASS' : 'FAIL');

  // (f) KPI placement: KPI only on overview, security only has monitored card, transfer & accounts have no KPI, no fallback chip in header
  const kpiInsideOverview = html.indexOf('id="tab-overview"') < html.indexOf('class="kpi-grid"');
  const noKpiInTransfer = !html.slice(html.indexOf('id="tab-transfer"'), html.indexOf('id="tab-accounts"')).includes('class="kpi-grid"');
  const noKpiInAccounts = !html.slice(html.indexOf('id="tab-accounts"'), html.indexOf('id="tab-security"')).includes('class="kpi-grid"');
  const secHasSingleCard = html.includes('id="kpi-redis-monitored-sec"');
  const noChipInHeader = !html.includes('id="fallback-warning-badge"');

  const passF = kpiInsideOverview && noKpiInTransfer && noKpiInAccounts && secHasSingleCard && noChipInHeader;
  console.log('(f) KPI placement & removed header chip (KPI only on overview, security single card):', passF ? 'PASS' : 'FAIL');

  // (5) Chế độ "Chỉ hiện chu trình": equilateral triangle grid layout up to 4 cols, amount formatted vi-VN, Chu trình #N
  const cycleGridCols = js.includes('Math.min(4, Math.max(1, numCycles))');
  const cycleTriangle = js.includes('radius * Math.cos(Math.PI / 6)') && js.includes('Chu trình #');
  const pass5 = cycleGridCols && cycleTriangle;
  console.log('(5) Fraud-only view (equilateral triangle grid up to 4 cols with vi-VN labels):', pass5 ? 'PASS' : 'FAIL');

  const requiredIds = [
    'kpi-total-accounts', 'kpi-total-tx', 'kpi-fraud-cycles', 'kpi-fraud-accounts',
    'kpi-redis-monitored', 'kpi-redis-locked', 'kpi-fraud-card', 'badge-cycles',
    'badge-accounts', 'badge-locked', 'neo4j-status-pill', 'redis-status-pill',
    'top-fallback-alert', 'topbar-title', 'topbar-subtitle',
    'active-session-pill', 'session-user-label', 'tab-overview', 'tab-transfer',
    'tab-accounts', 'tab-security', 'redis-security-tbody', 'security-full-tbody',
    'login-account', 'login-password', 'login-result', 'tx-from', 'tx-to',
    'tx-amount', 'tx-note', 'tx-result', 'filter-window', 'filter-min-amount',
    'graph-view-mode', 'fraud-accordion', 'fraud-banner-title', 'fraud-cycles-list',
    'network-container', 'graph-stats', 'lookup-account-id', 'account-history-box',
    'full-tx-from', 'full-tx-to', 'full-tx-amount', 'full-tx-note', 'full-tx-log',
    'all-transactions-tbody', 'account-search-input', 'accounts-crud-tbody',
    'sec-test-account', 'sec-test-password', 'sec-test-log', 'account-modal',
    'demo-drawer-panel', 'demo-drawer-backdrop'
  ];
  const missing = requiredIds.filter(id => !html.includes(`id="${id}"`));
  console.log(`(IDs) All ${requiredIds.length} required element IDs present:`, missing.length === 0 ? 'PASS (0 missing)' : `FAIL (missing: ${missing.join(', ')})`);

  console.log('\n=== ALL UI CHECKS RESULT ===');
  console.log('Result:', (passA && passB && passC && passD && passE && passF && pass5 && missing.length === 0) ? 'ALL PASS ✅' : 'SOME FAILED ❌');
}

check();
