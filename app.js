'use strict';

// ═══════════════════════════════════════════════════════════
// SUPABASE CONFIG
// ═══════════════════════════════════════════════════════════
var SUPABASE_URL = '';
var SUPABASE_KEY = '';
var AUTH_TOKEN   = '';   // set at login, used for all writes
var sb = null;

var MONTHS = ['January','February','March','April','May','June',
              'July','August','September','October','November','December'];
var MABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var REQUEST_TIMEOUT_MS = 15000;
var QUEUE_LIMIT = 50;
var WRITE_BATCH_SIZE = 5;
var WRITE_RETRY_LIMIT = 3;
var SCAN_LOG_LIMIT = 20;
var QR_MAX_LENGTH = 100;
var SCAN_COOLDOWN_MS = 1500;
var DUP_SCAN_WINDOW_MS = 4000;
var ADVANCE_MONTHS = 3;

// ═══════════════════════════════════════════════════════════
// STATE  (unchanged from original)
// ═══════════════════════════════════════════════════════════
var DATA       = null;
var attendance = {};   // { "YYYY-MM-DD": { dbId: "present"|"absent" } }
var payments   = {};   // { "id_month_year": "Paid"|"Pending"|"Waived" }
var classDays  = [];
var activeDay  = null;
var attLoadedDates = {};   // tracks which dates have had attendance fetched from DB
var expanded   = { att:null, pay:null, payYear:{} };
var scanLog    = [];
var scanStream = null, scanRaf = null;
var lastScanned = null, lastScannedAt = 0;
var detector   = null;
var lastFocusedBeforeModal = null;

// Login rate limiting (S5)
var loginAttempts = 0;
var loginLockUntil = 0;

// Offline queue & connectivity (E1/E3)
var writeQueue = [];
var failedWriteOps = [];
var isOnline   = navigator.onLine;
var syncCount  = 0;           // number of in-flight sync requests
var currentUserEmail = '';    // set at login, used for activity logging

// Queue persistence keys
var QUEUE_KEY = 'ara_v4_writeQueue';
var FAILED_QUEUE_KEY = 'ara_v4_failedWriteOps';
function getWriteOpKey(op) {
  if (!op || !op.type) return 'unknown';
  if (op.type === 'att') return ['att', op.studentId, op.date].join(':');
  if (op.type === 'pay') return ['pay', op.studentId, op.month, op.year].join(':');
  return op.type;
}
function normalizeWriteOp(op) {
  var normalized = Object.assign({}, op || {});
  normalized.retries = Number(normalized.retries) || 0;
  normalized.queuedAt = normalized.queuedAt || new Date().toISOString();
  if (normalized.type === 'pay' && normalized.status === 'Paid') {
    normalized.paidDate = normalized.paidDate || new Date().toISOString();
  }
  return normalized;
}
function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(writeQueue)); } catch(e) {}
  try { localStorage.setItem(FAILED_QUEUE_KEY, JSON.stringify(failedWriteOps)); } catch(e) {}
}
function loadQueue() {
  try {
    var raw = localStorage.getItem(QUEUE_KEY);
    if (raw) {
      var q = JSON.parse(raw);
      if (Array.isArray(q)) writeQueue = q.map(normalizeWriteOp).slice(-QUEUE_LIMIT);
    }
  } catch(e) {}
  try {
    var failedRaw = localStorage.getItem(FAILED_QUEUE_KEY);
    if (failedRaw) {
      var failed = JSON.parse(failedRaw);
      if (Array.isArray(failed)) failedWriteOps = failed.map(normalizeWriteOp).slice(-QUEUE_LIMIT);
    }
  } catch(e) {}
}
function clearFailedWrite(op) {
  var key = getWriteOpKey(op);
  failedWriteOps = failedWriteOps.filter(function(existing) { return getWriteOpKey(existing) !== key; });
}
function markFailedWrite(op) {
  var normalized = normalizeWriteOp(op);
  clearFailedWrite(normalized);
  failedWriteOps.push(normalized);
  if (failedWriteOps.length > QUEUE_LIMIT) failedWriteOps = failedWriteOps.slice(failedWriteOps.length - QUEUE_LIMIT);
}
function queueWrite(op) {
  var normalized = normalizeWriteOp(op);
  var key = getWriteOpKey(normalized);
  var replaced = false;
  clearFailedWrite(normalized);
  writeQueue = writeQueue.filter(function(existing) {
    if (getWriteOpKey(existing) !== key) return true;
    replaced = true;
    return false;
  });
  writeQueue.push(normalized);
  if (writeQueue.length > QUEUE_LIMIT) writeQueue = writeQueue.slice(writeQueue.length - QUEUE_LIMIT);
  saveQueue();
  return { replaced: replaced, size: writeQueue.length };
}

function hasQueuedWriteOp(op) {
  var key = getWriteOpKey(op);
  return writeQueue.some(function(existing) { return getWriteOpKey(existing) === key; });
}

function hasFailedWriteOp(op) {
  var key = getWriteOpKey(op);
  return failedWriteOps.some(function(existing) { return getWriteOpKey(existing) === key; });
}

function getPendingAttendanceStatus(studentId, date) {
  var pendingOp = writeQueue.filter(function(op) {
    return op.type === 'att' && op.studentId === studentId && op.date === date;
  })[0];
  return pendingOp ? pendingOp.status : undefined;
}

function getFailedAttendanceStatus(studentId, date) {
  var failedOp = failedWriteOps.filter(function(op) {
    return op.type === 'att' && op.studentId === studentId && op.date === date;
  })[0];
  return failedOp ? failedOp.status : undefined;
}

function getPendingPaymentStatus(studentId, month, year) {
  var pendingOp = writeQueue.filter(function(op) {
    return op.type === 'pay' && op.studentId === studentId && op.month === month && op.year === year;
  })[0];
  return pendingOp ? pendingOp.status : undefined;
}

function getFailedPaymentStatus(studentId, month, year) {
  var failedOp = failedWriteOps.filter(function(op) {
    return op.type === 'pay' && op.studentId === studentId && op.month === month && op.year === year;
  })[0];
  return failedOp ? failedOp.status : undefined;
}

function getPendingPaymentCount(studentId) {
  return writeQueue.filter(function(op) {
    return op.type === 'pay' && op.studentId === studentId;
  }).length;
}

function getFailedPaymentCount(studentId) {
  return failedWriteOps.filter(function(op) {
    return op.type === 'pay' && op.studentId === studentId;
  }).length;
}

function refreshPendingViews() {
  if (!DATA) return;
  renderStatusSummary();
  if (document.getElementById('tab-attendance') && !document.getElementById('tab-attendance').hidden) renderAtt();
  if (document.getElementById('tab-payments') && !document.getElementById('tab-payments').hidden) renderPay();
}

// Sync indicator helpers
function setSyncing(delta) {
  syncCount = Math.max(0, syncCount + delta);
  var el = document.getElementById('sync-indicator');
  if (el) el.style.display = syncCount > 0 ? 'inline' : 'none';
}

// Card filter state
var attFilter = null;  // null | 'present' | 'absent' | 'unmarked'
var payFilter = null;  // null | 'paid' | 'pending'

// ═══════════════════════════════════════════════════════════
// UTILITY HELPERS
// ═══════════════════════════════════════════════════════════
function debounce(fn, ms) {
  var t;
  return function() { clearTimeout(t); t = setTimeout(fn, ms); };
}

function fetchWithTimeout(url, options, timeoutMs) {
  timeoutMs = timeoutMs || REQUEST_TIMEOUT_MS;
  var controller = new AbortController();
  var id = setTimeout(function() { controller.abort(); }, timeoutMs);
  options = options || {};
  options.signal = controller.signal;
  return fetch(url, options).finally(function() { clearTimeout(id); });
}

// ═══════════════════════════════════════════════════════════
// SCREEN HELPERS
// ═══════════════════════════════════════════════════════════
function showScreen(id) {
  ['connect-screen','loading-screen','app'].forEach(function(s) {
    var el = document.getElementById(s);
    el.style.display = s === id ? (s === 'app' ? 'flex' : 'flex') : 'none';
    if (s === 'app' && s === id) el.style.flexDirection = 'column';
  });
}

function showLoading(msg) {
  document.getElementById('loading-msg').textContent = msg || 'Loading…';
  showScreen('loading-screen');
}

function showConnectScreen() {
  showScreen('connect-screen');
  document.getElementById('connect-err').style.display = 'none';
}

function showApp() {
  showScreen('app');
  var dt = new Date();
  var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  document.getElementById('topbar-date').textContent = dt.getDate() + ' ' + mo[dt.getMonth()] + ' ' + dt.getFullYear();
  document.getElementById('topbar-meta').textContent = (DATA ? DATA.students.length : 0) + ' students · ' + (DATA ? DATA.month_name + ' ' + DATA.year : '');
  document.getElementById('conn-url-display').textContent = SUPABASE_URL;
  if (/iP(hone|ad|od)/i.test(navigator.userAgent)) {
    document.getElementById('ios-scan-note').style.display = 'block';
  }
  updateOfflineBanner();
  renderDayBar(); renderAtt(); renderPay();
  if (activeDay && activeDay !== todayISO() && !attLoadedDates[activeDay]) {
    fetchAttForDate(activeDay).then(function() { renderAtt(); });
  }
}

function showConnectErr(msg) {
  var el = document.getElementById('connect-err');
  el.style.display = 'block';
  el.textContent = '❌ ' + msg;
}
function showBootError(msg) {
  showConnectScreen();
  var el = document.getElementById('connect-err');
  el.style.display = 'block';
  el.textContent = '❌ ' + msg;
  el.appendChild(document.createElement('br'));
  el.appendChild(document.createElement('br'));
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inline-action-btn';
  btn.setAttribute('data-action', 'reload');
  btn.textContent = '🔄 Reload';
  el.appendChild(btn);
}

// ═══════════════════════════════════════════════════════════
// SUPABASE — AUTH LOGIN
// ═══════════════════════════════════════════════════════════
var ADMIN_EMAIL = ''; // set from login form input at runtime

function initSupabaseClient(url, key) {
  var factory = window.supabase && window.supabase.createClient;
  if (!factory) { showConnectErr('Supabase library failed to load. Check your internet connection.'); return false; }
  sb = factory(url, key);
  return true;
}

async function doLogin() {
  var now = Date.now();
  if (loginAttempts >= 5 && now < loginLockUntil) {
    var secs = Math.ceil((loginLockUntil - now) / 1000);
    showConnectErr('Too many attempts. Try again in ' + secs + ' seconds.');
    return;
  }
  var email = (document.getElementById('login-email').value || '').trim();
  if (!email) { showConnectErr('Please enter your email.'); return; }
  var pw = (document.getElementById('login-pw').value || '').trim();
  if (!pw) { showConnectErr('Please enter your password.'); return; }
  ADMIN_EMAIL = email;
  var btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  try {
    var result = await sb.auth.signInWithPassword({ email: ADMIN_EMAIL, password: pw });
    if (result.error) {
      loginAttempts++;
      if (loginAttempts >= 5) {
        loginLockUntil = Date.now() + 30000;
        showConnectErr('Too many failed attempts. Locked for 30 seconds.');
      } else {
        showConnectErr('Incorrect password. Please try again. (' + (5 - loginAttempts) + ' attempts left)');
      }
      document.getElementById('login-pw').value = '';
      document.getElementById('login-pw').focus();
    } else {
      loginAttempts = 0;
      AUTH_TOKEN = result.data.session.access_token;
      currentUserEmail = (result.data.session.user && result.data.session.user.email) || ADMIN_EMAIL;
      resetSessionTimer();
      showLoading('Loading students…');
      loadFromSupabase().then(function() {
        logActivity('login', currentUserEmail);
        if (writeQueue.length > 0 && isOnline) flushWriteQueue();
      });
    }
  } catch(e) {
    console.error('Login error:', e);
    showConnectErr('Connection error. Please check your internet and try again.');
  }
  btn.disabled = false;
  btn.textContent = '🔓 Login';
}

async function disconnectSupabase() {
  if (!confirm('Log out?')) return;
  try { logActivity('logout', currentUserEmail); } catch(e) {}
  try { await sb.auth.signOut(); } catch(e) {}
  try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
  try { localStorage.removeItem(QUEUE_KEY); } catch(e) {}
  DATA = null; attendance = {}; payments = {}; classDays = []; activeDay = null;
  writeQueue = []; currentUserEmail = ''; AUTH_TOKEN = '';
  stopScanner();
  showConnectScreen();
  document.getElementById('login-pw').value = '';
  document.getElementById('login-email').value = '';
  ADMIN_EMAIL = '';
}

// ═══════════════════════════════════════════════════════════
// SESSION TIMEOUT (auto-logout after 15 min inactivity)
// ═══════════════════════════════════════════════════════════
var SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
var sessionTimer = null;
function resetSessionTimer() {
  if (sessionTimer) clearTimeout(sessionTimer);
  if (!AUTH_TOKEN) return; // not logged in
  sessionTimer = setTimeout(function() {
    if (AUTH_TOKEN) {
      // Force logout without confirm prompt
      try { logActivity('session_timeout', currentUserEmail); } catch(e) {}
      sb.auth.signOut().catch(function(){});
      try { sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
      DATA = null; attendance = {}; payments = {}; classDays = []; activeDay = null;
      writeQueue = []; currentUserEmail = ''; AUTH_TOKEN = '';
      stopScanner();
      showConnectScreen();
      document.getElementById('login-pw').value = '';
      document.getElementById('login-email').value = '';
      ADMIN_EMAIL = '';
      toast('Session expired — please log in again');
    }
  }, SESSION_TIMEOUT_MS);
}
['click','keydown','touchstart','scroll'].forEach(function(evt) {
  document.addEventListener(evt, resetSessionTimer, { passive: true });
});

// ═══════════════════════════════════════════════════════════
// SUPABASE — LOAD DATA
// ═══════════════════════════════════════════════════════════
async function loadFromSupabase() {
  try {
    showLoading('Loading students…');
    var today = todayISO();
    var now   = new Date();
    var mn    = now.getMonth() + 1;
    var yr    = now.getFullYear();

    // 1. Active students
    var sRes = await sb.from('students')
      .select('id, student_id, name, fee_amount, created_at')
      .eq('active', true)
      .order('name');
    if (sRes.error) { console.error('students load error:', sRes.error.message); throw new Error('Failed to load students'); }
    var students = sRes.data || [];

    showLoading('Loading attendance…');

    // 2. Today's attendance
    var aRes = await sb.from('attendance')
      .select('student_id, status')
      .eq('date', today);
    if (aRes.error) { console.error('attendance load error:', aRes.error.message); throw new Error('Failed to load attendance'); }
    var attMap = {};
    (aRes.data || []).forEach(function(r) { attMap[r.student_id] = r.status; });

    showLoading('Loading payments…');

    // 3. Payments (filtered to recent years for performance)
    var pRes = await sb.from('payments')
      .select('student_id, month, year, amount, paid, waived')
      .gte('year', yr - 2);
    if (pRes.error) { console.error('payments load error:', pRes.error.message); throw new Error('Failed to load payments'); }
    var payLookup = {};
    (pRes.data || []).forEach(function(p) {
      payLookup[p.student_id + '_' + p.month + '_' + p.year] = p;
    });

    // 4. Build DATA object (same shape as the old JSON export)
    var studentList = students.map(function(s) {
      // Determine payment start month (student's join month)
      var created  = new Date(s.created_at);
      var startMn  = created.getMonth() + 1;
      var startYr  = created.getFullYear();

      // Build full due_months list from join date → current month + ADVANCE_MONTHS
      var due_months = [];
      var advMn = mn + ADVANCE_MONTHS, advYr = yr;
      while (advMn > 12) { advMn -= 12; advYr++; }
      var mi = startMn, yi = startYr;
      while (yi < advYr || (yi === advYr && mi <= advMn)) {
        var pKey = s.id + '_' + mi + '_' + yi;
        var p    = payLookup[pKey];
        var st   = p ? (p.waived ? 'Waived' : (p.paid ? 'Paid' : 'Pending')) : 'Pending';
        due_months.push({
          month:      mi,
          year:       yi,
          month_name: MONTHS[mi - 1],
          amount:     p ? (p.amount || s.fee_amount || 0) : (s.fee_amount || 0),
          status:     st
        });
        mi++;
        if (mi > 12) { mi = 1; yi++; }
      }

      // Current month pay status for the badge
      var curP   = payLookup[s.id + '_' + mn + '_' + yr];
      var pay_st = curP ? (curP.waived ? 'Waived' : (curP.paid ? 'Paid' : 'Pending')) : 'Pending';

      return {
        id:               s.id,
        student_id:       s.student_id || '',
        name:             s.name,
        fee_amount:       s.fee_amount || 0,
        attendance_today: attMap[s.id] || null,
        payment_status:   pay_st,
        due_months:       due_months
      };
    });

    DATA = {
      export_type:  'supabase_live',
      exported_at:  new Date().toISOString(),
      export_date:  today,
      month:        mn,
      year:         yr,
      month_name:   MONTHS[mn - 1],
      students:     studentList
    };

    // Seed local payments state from loaded data
    payments = {};
    DATA.students.forEach(function(s) {
      (s.due_months || []).forEach(function(m) {
        payments[payKey(s.id, m.month, m.year)] = m.status;
      });
    });

    // Seed today's attendance into local state
    attendance = {};
    attendance[today] = {};
    attLoadedDates = {};
    attLoadedDates[today] = true;
    DATA.students.forEach(function(s) {
      if (s.attendance_today) attendance[today][s.id] = s.attendance_today;
    });

    // Restore session (classDays, activeDay) if same date
    tryRestore();

    showApp();

  } catch(err) {
    console.error('loadFromSupabase error:', err);
    showConnectErr('Could not load data. Please check your internet connection and try again.');
    showConnectScreen();
  }
}

async function fetchAttForDate(date) {
  if (!sb || attLoadedDates[date]) return;
  try {
    var r = await sb.from('attendance').select('student_id, status').eq('date', date);
    if (r.error) return;
    if (!attendance[date]) attendance[date] = {};
    (r.data || []).forEach(function(row) {
      attendance[date][row.student_id] = row.status;
    });
    attLoadedDates[date] = true;
  } catch(e) {}
}

async function refreshData() {
  stopScanner();
  showLoading('Refreshing data…');
  await loadFromSupabase();
  toast('🔄 Data refreshed');
}

// ═══════════════════════════════════════════════════════════
// AUTH TOKEN HELPER — fixes iOS Safari session drop
// ═══════════════════════════════════════════════════════════
async function getToken() {
  try {
    var r = await sb.auth.getSession();
    if (r.data && r.data.session) {
      AUTH_TOKEN = r.data.session.access_token;
      return AUTH_TOKEN;
    }
  } catch(e) {}
  // Session expired — redirect to login
  toast('⚠️ Session expired — please log in again');
  AUTH_TOKEN = '';
  DATA = null;
  showConnectScreen();
  throw new Error('Session expired');
}

function sbHeaders(token, prefer) {
  return {
    'apikey':        SUPABASE_KEY,
    'Authorization': 'Bearer ' + token,
    'Content-Type':  'application/json',
    'Prefer':        prefer || 'resolution=merge-duplicates,return=minimal'
  };
}

function buildWriteRequest(op, headers) {
  if (op.type === 'att') {
    if (op.status === null) {
      return {
        url: SUPABASE_URL + '/rest/v1/attendance?student_id=eq.' + encodeURIComponent(op.studentId) + '&date=eq.' + encodeURIComponent(op.date),
        options: { method: 'DELETE', headers: headers }
      };
    }
    return {
      url: SUPABASE_URL + '/rest/v1/attendance?on_conflict=student_id,date',
      options: {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ student_id: op.studentId, date: op.date, status: op.status })
      }
    };
  }
  return {
    url: SUPABASE_URL + '/rest/v1/payments?on_conflict=student_id,month,year',
    options: {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        student_id: op.studentId,
        month: op.month,
        year: op.year,
        amount: op.amount,
        paid: op.status === 'Paid',
        paid_date: op.status === 'Paid' ? (op.paidDate || new Date().toISOString()) : null,
        waived: op.status === 'Waived',
        status: (op.status === 'Paid' || op.status === 'Waived') ? 'final' : 'disputed'
      })
    }
  };
}

async function sendWriteOp(op, token) {
  var request = buildWriteRequest(op, sbHeaders(token));
  var resp = await fetchWithTimeout(request.url, request.options);
  return { ok: !!(resp && resp.ok), status: resp ? resp.status : 0 };
}

async function performWrite(op) {
  if (!sb) return { ok: false, queued: false, reason: 'not-ready' };
  var normalized = normalizeWriteOp(op);
  if (!isOnline) {
    queueWrite(normalized);
    return { ok: false, queued: true, reason: 'offline' };
  }
  setSyncing(1);
  try {
    var token = await getToken();
    var result = await sendWriteOp(normalized, token);
    if (!result.ok) {
      queueWrite(normalized);
      saveQueue();
      return { ok: false, queued: true, reason: 'server' };
    }
    clearFailedWrite(normalized);
    saveQueue();
    return { ok: true, queued: false, reason: null };
  } catch(e) {
    if (e.message === 'Session expired') return { ok: false, queued: false, reason: 'session' };
    queueWrite(normalized);
    saveQueue();
    return { ok: false, queued: true, reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    setSyncing(-1);
  }
}

function notifyQueuedWrite(result) {
  if (!result || !result.queued) return;
  refreshPendingViews();
  if (result.reason === 'offline') toast('📡 Saved locally — sync will resume when online');
  else if (result.reason === 'timeout') toast('⏳ Saved locally — request timed out, will retry');
  else if (result.reason === 'server') toast('⚠️ Saved locally — sync retry queued');
  else if (result.reason === 'network') toast('📡 Saved locally — sync will retry automatically');
}

// ═══════════════════════════════════════════════════════════
// SUPABASE — WRITE ATTENDANCE
// ═══════════════════════════════════════════════════════════
async function writeAtt(studentId, date, status) {
  return performWrite({ type: 'att', studentId: studentId, date: date, status: status });
}

// ═══════════════════════════════════════════════════════════
// SUPABASE — WRITE PAYMENT
// ═══════════════════════════════════════════════════════════
async function writePay(studentId, month, year, status, amount) {
  return performWrite({ type: 'pay', studentId: studentId, month: month, year: year, status: status, amount: amount });
}

// ═══════════════════════════════════════════════════════════
// OFFLINE QUEUE — FLUSH ON RECONNECT
// ═══════════════════════════════════════════════════════════
async function flushWriteQueue() {
  if (!isOnline || writeQueue.length === 0) return;
  var pending = writeQueue.slice(0);
  writeQueue = [];
  var originalCount = pending.length;
  var failed = [];
  var exhausted = [];
  try {
    var token = await getToken();
    while (pending.length) {
      var batch = pending.splice(0, WRITE_BATCH_SIZE);
      setSyncing(batch.length);
      try {
        var batchResults = await Promise.all(batch.map(function(op) {
          return sendWriteOp(op, token).catch(function() { return { ok: false }; });
        }));
        batch.forEach(function(op, index) {
          if (!batchResults[index] || !batchResults[index].ok) {
            var retryOp = normalizeWriteOp(op);
            retryOp.retries += 1;
            if (retryOp.retries <= WRITE_RETRY_LIMIT) failed.push(retryOp);
            else exhausted.push(retryOp);
          } else {
            clearFailedWrite(op);
          }
        });
      } finally {
        setSyncing(-batch.length);
      }
    }
  } catch(e) {
    if (e.message === 'Session expired') {
      writeQueue = pending.concat(writeQueue);
      saveQueue();
      return;
    }
    failed = pending.concat(failed).map(function(op) {
      var retryOp = normalizeWriteOp(op);
      retryOp.retries += 1;
      return retryOp;
    }).filter(function(op) {
      if (op.retries <= WRITE_RETRY_LIMIT) return true;
      exhausted.push(op);
      return false;
    });
  }
  exhausted.forEach(markFailedWrite);
  writeQueue = failed.concat(writeQueue);
  if (writeQueue.length > QUEUE_LIMIT) writeQueue = writeQueue.slice(writeQueue.length - QUEUE_LIMIT);
  saveQueue();
  refreshPendingViews();
  if (failed.length === 0 && originalCount > 0) {
    toast('✅ All queued changes synced');
  } else if (failed.length > 0 || exhausted.length > 0) {
    toast('⚠️ ' + (failed.length + exhausted.length) + ' change(s) need attention');
  }
}

function retryFailedWrites() {
  if (failedWriteOps.length === 0) return 0;
  var ops = failedWriteOps.splice(0);
  ops.forEach(function(op) {
    op.retries = 0;
    queueWrite(op);
  });
  saveQueue();
  return ops.length;
}

function updateOfflineBanner() {
  var el = document.getElementById('offline-banner');
  if (el) el.style.display = isOnline ? 'none' : 'block';
  var pill = document.getElementById('topbar-status');
  if (pill) {
    pill.className = isOnline ? 'live' : 'offline';
    pill.textContent = '';
    var dot = document.createElement('span');
    dot.className = 'dot';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(isOnline ? 'Live' : 'Offline'));
  }
}
window.addEventListener('online', function() {
  isOnline = true;
  updateOfflineBanner();
  toast('📡 Back online — syncing…');
  flushWriteQueue();
});
window.addEventListener('offline', function() {
  isOnline = false;
  updateOfflineBanner();
  toast('📡 You are offline');
});

// ═══════════════════════════════════════════════════════════
// SESSION STORAGE  (saves classDays / activeDay across reload)
// ═══════════════════════════════════════════════════════════
var SESSION_KEY = 'ara_v4_session';
function save() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      xd:        DATA ? DATA.export_date : null,
      classDays: classDays,
      activeDay: activeDay
    }));
  } catch(e) {}
}
function tryRestore() {
  var today = todayISO();
  try {
    var raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      var s = JSON.parse(raw);
      if (s && DATA && s.xd === DATA.export_date) {
        classDays = s.classDays || [];
        activeDay = s.activeDay || null;
        classDays.forEach(function(d) {
          if (!attendance[d]) attendance[d] = {};
        });
      }
    }
  } catch(e) {}
  // Always ensure today is in classDays and is the active day on fresh load
  if (!classDays.includes(today)) {
    classDays.push(today);
    classDays.sort();
  }
  if (!attendance[today]) attendance[today] = {};
  // Only override activeDay if not already set to a valid day
  if (!activeDay || !classDays.includes(activeDay)) {
    activeDay = today;
  }
  save();
  return true;
}

// ═══════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════
function switchTab(name) {
  var tabs = ['attendance','scan','payments','addstudent','status'];
  if (!tabs.includes(name)) return;
  document.querySelectorAll('.tab[data-tab]').forEach(function(tab) {
    var isActive = tab.getAttribute('data-tab') === name;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tab.setAttribute('tabindex', isActive ? '0' : '-1');
  });
  document.querySelectorAll('.tab-content').forEach(function(tc) {
    var isActive = tc.id === 'tab-' + name;
    tc.classList.toggle('active', isActive);
    tc.hidden = !isActive;
  });
  if (name !== 'scan') stopScanner();
  if (name === 'scan')        updateScanBadge();
  if (name === 'status')      renderStatusSummary();
  if (name === 'addstudent')  clearAddStudentForm();
}

// ═══════════════════════════════════════════════════════════
// CLASS DAYS
// ═══════════════════════════════════════════════════════════
function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function pad(n) { return n < 10 ? '0'+n : ''+n; }
function fmtDate(iso) {
  var p = iso.split('-');
  return p[2] + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+p[1]-1];
}
function isValidISO(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  var parts = v.split('-');
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  if (m < 1 || m > 12 || d < 1) return false;
  var dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function openDateModal() {
  lastFocusedBeforeModal = document.activeElement;
  var inp = document.getElementById('d-input');
  var today = todayISO();
  inp.value = today;
  onDateInput(today);
  var modal = document.getElementById('date-modal');
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  setTimeout(function() { inp.focus(); inp.select(); }, 80);
}
function closeDateModal() {
  var modal = document.getElementById('date-modal');
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  if (lastFocusedBeforeModal && lastFocusedBeforeModal.focus) lastFocusedBeforeModal.focus();
}
function onDateInput(val) {
  var digits = val.replace(/\D/g, '');
  var fmt = digits;
  if (digits.length > 4) fmt = digits.slice(0,4) + '-' + digits.slice(4);
  if (digits.length > 6) fmt = digits.slice(0,4) + '-' + digits.slice(4,6) + '-' + digits.slice(6,8);
  var inp = document.getElementById('d-input');
  if (fmt !== val) inp.value = fmt;
  var validFormat = isValidISO(fmt);
  var isFuture = validFormat && fmt > todayISO();
  var ok = validFormat && !isFuture;
  document.getElementById('d-preview').textContent = isFuture ? '⚠️ Cannot use a future date' : (ok ? '📅 ' + fmtDate(fmt) : '');
  document.getElementById('d-preview').style.color = isFuture ? 'var(--red)' : 'var(--accent)';
  document.getElementById('d-confirm').disabled = !ok;
}
async function confirmDateModal() {
  var v = document.getElementById('d-input').value;
  if (!isValidISO(v)) return;
  closeDateModal();
  if (!classDays.includes(v)) { classDays.push(v); classDays.sort(); attendance[v] = attendance[v] || {}; }
  activeDay = v;
  save(); renderDayBar(); renderAtt();
  toast('📅 ' + fmtDate(v) + ' added');
  if (v !== todayISO() && !attLoadedDates[v]) {
    await fetchAttForDate(v);
    renderAtt();
  }
}
async function selectDay(d) {
  activeDay = d;
  save();
  renderDayBar();
  renderAtt();
  if (d !== todayISO() && !attLoadedDates[d]) {
    await fetchAttForDate(d);
    renderAtt();
  }
}

function renderDayBar() {
  var bar = document.getElementById('day-bar');
  clearChildren(bar);
  classDays.forEach(function(d) {
    var chip = createElem('button', 'day-chip' + (d === activeDay ? ' active' : ''), fmtDate(d));
    chip.type = 'button';
    chip.setAttribute('data-action', 'selectDay');
    chip.setAttribute('data-day', d);
    chip.setAttribute('aria-pressed', d === activeDay ? 'true' : 'false');
    bar.appendChild(chip);
  });
  var addBtn = createElem('button', 'day-chip add-btn', '+ New Day');
  addBtn.type = 'button';
  addBtn.setAttribute('data-action', 'openDateModal');
  bar.appendChild(addBtn);
  var hasDays = classDays.length > 0;
  document.getElementById('no-day-msg').style.display  = hasDays ? 'none' : 'block';
  document.getElementById('att-body').style.display    = hasDays ? 'block' : 'none';
}

function clearChildren(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
}

function createElem(tag, className, text) {
  var el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function setDatasetAttrs(el, attrs) {
  Object.keys(attrs || {}).forEach(function(key) {
    if (attrs[key] !== undefined && attrs[key] !== null) el.setAttribute('data-' + key, String(attrs[key]));
  });
}

function renderEmptyState(list, icon, text) {
  clearChildren(list);
  var wrap = createElem('div', 'empty');
  wrap.appendChild(createElem('div', 'big', icon));
  wrap.appendChild(document.createTextNode(text));
  list.appendChild(wrap);
}

function getInitials(name) {
  return String(name || '').split(' ').map(function(w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();
}

function createActionButton(label, className, action, attrs) {
  var btn = createElem('button', className, label);
  btn.type = 'button';
  btn.setAttribute('data-action', action);
  setDatasetAttrs(btn, attrs);
  return btn;
}

function createStudentCardShell(options) {
  var card = createElem('div', 'student-card');
  if (options.cardClass) card.classList.add(options.cardClass);
  if (options.open) card.classList.add('open');
  if (options.pending) card.classList.add('sync-pending');
  if (options.failed) card.classList.add('sync-failed');

  var main = createElem('div', 'sc-main');
  main.setAttribute('role', 'button');
  main.setAttribute('tabindex', '0');
  main.setAttribute('aria-expanded', options.open ? 'true' : 'false');
  main.setAttribute('data-action', 'togExp');
  setDatasetAttrs(main, { type: options.type, id: options.id });

  main.appendChild(createElem('div', 'sc-av', getInitials(options.name)));

  var info = createElem('div', 'sc-info');
  info.appendChild(createElem('div', 'sc-name', options.name));
  info.appendChild(createElem('div', 'sc-sub', options.subtext || '—'));
  main.appendChild(info);

  if (options.badge) main.appendChild(options.badge);
  if (options.pendingBadge) main.appendChild(options.pendingBadge);
  card.appendChild(main);
  return { card: card, main: main };
}

function createPendingBadge(text) {
  return createElem('div', 'sc-sync', text || 'Sync pending');
}

function buildAttendanceCard(student, status, open) {
  var pendingStatus = getPendingAttendanceStatus(student.id, activeDay);
  var failedStatus = getFailedAttendanceStatus(student.id, activeDay);
  var pending = pendingStatus !== undefined;
  var failed = failedStatus !== undefined;
  var cardClass = status === 'present' ? 'present' : status === 'absent' ? 'absent' : '';
  var badgeClass = status === 'present' ? 'sp' : status === 'absent' ? 'sa' : 'sn';
  var badgeText = status === 'present' ? 'Present' : status === 'absent' ? 'Absent' : '—';
  var badge = createElem('div', 'sc-st ' + badgeClass, badgeText);
  var shell = createStudentCardShell({
    cardClass: cardClass,
    open: open,
    pending: pending,
    failed: failed,
    type: 'att',
    id: student.id,
    name: student.name,
    subtext: student.student_id || '—',
    badge: badge,
    pendingBadge: failed ? createPendingBadge('Sync failed') : (pending ? createPendingBadge('Sync pending') : null)
  });

  var actions = createElem('div', 'sc-acts');
  actions.appendChild(createActionButton('✅ Present', 'act a-present', 'setAtt', { id: student.id, status: 'present' }));
  actions.appendChild(createActionButton('❌ Absent', 'act a-absent', 'setAtt', { id: student.id, status: 'absent' }));
  actions.appendChild(createActionButton('↩', 'act a-ghost act-compact', 'setAtt', { id: student.id, status: '' }));
  shell.card.appendChild(actions);
  return shell.card;
}

function createPayCell(sid, monthData) {
  var key = payKey(sid, monthData.month, monthData.year);
  var state = payments[key] || monthData.status;
  var pendingState = getPendingPaymentStatus(sid, monthData.month, monthData.year);
  var failedState = getFailedPaymentStatus(sid, monthData.month, monthData.year);
  var isPaid = state === 'Paid';
  var isWaived = state === 'Waived';
  var cls = isPaid ? 'pc-paid' : isWaived ? 'pc-waived' : 'pc-pending';
  var isFuture = DATA && ((monthData.year > DATA.year) || (monthData.year === DATA.year && monthData.month > DATA.month));
  var cell = createElem('div', 'pay-cell ' + cls);
  if (isFuture) cell.classList.add('pc-future');
  if (pendingState !== undefined) cell.classList.add('pc-sync-pending');
  if (failedState !== undefined) cell.classList.add('pc-sync-failed');
  if (isWaived) {
    cell.setAttribute('aria-disabled', 'true');
  } else {
    cell.setAttribute('role', 'button');
    cell.setAttribute('tabindex', '0');
    cell.setAttribute('data-action', 'setPay');
    setDatasetAttrs(cell, {
      id: sid,
      month: monthData.month,
      year: monthData.year,
      status: isPaid ? 'Pending' : 'Paid'
    });
  }
  cell.appendChild(createElem('span', 'pc-mon', MABBR[monthData.month - 1]));
  cell.appendChild(createElem('span', 'pc-ico', isPaid ? '✓' : isWaived ? '·' : ''));
  if (failedState !== undefined) cell.title = 'Sync failed';
  else if (pendingState !== undefined) cell.title = 'Queued for sync';
  return cell;
}

function buildPayGridNode(sid, months) {
  var grid = createElem('div', 'pay-grid');
  months.forEach(function(monthData) {
    grid.appendChild(createPayCell(sid, monthData));
  });
  return grid;
}

function createPayYearRow(studentId, year, countText, statusNode, isOpen) {
  var row = createElem('div', 'pay-year-row');
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  row.setAttribute('data-action', 'togYearExp');
  setDatasetAttrs(row, { id: studentId, year: year });

  var label = createElem('span', 'yr-label');
  label.appendChild(createElem('span', 'yr-chev', isOpen ? '▾' : '▸'));
  label.appendChild(document.createTextNode(year + ' — ' + countText));
  row.appendChild(label);

  var badge = createElem('span', 'yr-badge');
  badge.appendChild(statusNode);
  row.appendChild(badge);
  return row;
}

function buildPaymentCard(student, open) {
  var months = student.due_months || [];
  var pendingOps = getPendingPaymentCount(student.id);
  var failedOps = getFailedPaymentCount(student.id);
  var curMn = DATA ? DATA.month : 0, curYr = DATA ? DATA.year : 0;
  var dueMonths = months.filter(function(m) {
    return m.year < curYr || (m.year === curYr && m.month <= curMn);
  });
  var pendingCount = dueMonths.filter(function(m) {
    return (payments[payKey(student.id, m.month, m.year)] || m.status) === 'Pending';
  }).length;
  var allPaid = pendingCount === 0;
  var totalAmt = dueMonths.filter(function(m) {
    return (payments[payKey(student.id, m.month, m.year)] || m.status) === 'Pending';
  }).reduce(function(sum, m) { return sum + (m.amount || 0); }, 0);
  var badge = createElem('div', 'sc-st ' + (allPaid ? 'sk' : 'sq'), allPaid ? 'All Paid' : pendingCount + ' unpaid');
  var shell = createStudentCardShell({
    cardClass: allPaid ? 'paid' : '',
    open: open,
    pending: pendingOps > 0,
    failed: failedOps > 0,
    type: 'pay',
    id: student.id,
    name: student.name,
    subtext: student.student_id || '—',
    badge: badge,
    pendingBadge: failedOps > 0 ? createPendingBadge(failedOps + ' failed') : (pendingOps > 0 ? createPendingBadge(pendingOps + ' queued') : null)
  });

  if (!open) return shell.card;

  var yearMap = {};
  months.forEach(function(m) {
    if (!yearMap[m.year]) yearMap[m.year] = [];
    yearMap[m.year].push(m);
  });

  Object.keys(yearMap).map(Number).sort().forEach(function(year) {
    var yearMonths = yearMap[year];
    var paidCount = yearMonths.filter(function(m) {
      var state = payments[payKey(student.id, m.month, m.year)] || m.status;
      return state === 'Paid' || state === 'Waived';
    }).length;
    var totalCount = yearMonths.length;
    var yearAllPaid = paidCount === totalCount;
    var pendingYearCount = totalCount - paidCount;

    if (year === DATA.year) {
      shell.card.appendChild(createElem('div', 'pay-yr-hint', year + ' — tap to mark paid · faded = advance'));
      shell.card.appendChild(buildPayGridNode(student.id, yearMonths));
      return;
    }

    var countText = totalCount === 12 ? 'all 12 months' : totalCount + ' month' + (totalCount > 1 ? 's' : '');
    var statusNode = createElem('span', yearAllPaid ? 'summary-accent-good' : 'summary-accent-warn', yearAllPaid ? 'All paid ✓' : paidCount + ' paid, ' + pendingYearCount + ' unpaid');
    var yearKey = student.id + '_' + year;
    var openYear = !!expanded.payYear[yearKey];
    shell.card.appendChild(createPayYearRow(student.id, year, countText, statusNode, openYear));
    if (openYear) shell.card.appendChild(buildPayGridNode(student.id, yearMonths));
  });

  if (!allPaid) {
    var footer = createElem('div', 'pay-footer');
    footer.appendChild(createElem('span', '', 'Total due'));
    footer.appendChild(createElem('span', '', 'Rs. ' + totalAmt.toLocaleString()));
    shell.card.appendChild(footer);
  }
  return shell.card;
}

// ═══════════════════════════════════════════════════════════
// ATTENDANCE — FILTER TOGGLE
// ═══════════════════════════════════════════════════════════
function toggleAttFilter(type) {
  attFilter = attFilter === type ? null : type;
  renderAtt();
}
function updateAttFilterUI() {
  ['present','absent','unmarked'].forEach(function(f) {
    var el = document.getElementById('fc-' + f);
    if (el) {
      el.classList.toggle('filter-on', attFilter === f);
      el.setAttribute('aria-pressed', attFilter === f ? 'true' : 'false');
    }
  });
}

// ═══════════════════════════════════════════════════════════
// ATTENDANCE — RENDER
// ═══════════════════════════════════════════════════════════
function renderAtt() {
  if (!DATA) return;
  var dm  = attendance[activeDay] || {};
  var q   = ((document.getElementById('att-q') || {}).value || '').toLowerCase();
  var p=0, a=0;
  Object.values(dm).forEach(function(v){ if(v==='present')p++; else if(v==='absent')a++; });
  document.getElementById('a-present').textContent  = p;
  document.getElementById('a-absent').textContent   = a;
  document.getElementById('a-unmarked').textContent = DATA.students.length - p - a;
  updateAttFilterUI();

  var list = document.getElementById('att-list');
  var stus = DATA.students.filter(function(s) {
    if (q && s.name.toLowerCase().indexOf(q)<0 && (s.student_id||'').toLowerCase().indexOf(q)<0) return false;
    if (attFilter) {
      var st = dm[s.id];
      if (attFilter === 'present')  return st === 'present';
      if (attFilter === 'absent')   return st === 'absent';
      if (attFilter === 'unmarked') return !st;
    }
    return true;
  });
  if (!stus.length) { renderEmptyState(list, '🔍', 'No students found'); return; }
  clearChildren(list);
  var frag = document.createDocumentFragment();
  stus.forEach(function(s) {
    frag.appendChild(buildAttendanceCard(s, dm[s.id], expanded.att === s.id));
  });
  list.appendChild(frag);
}

function getDueInfo(sid) {
  var s = DATA && DATA.students.filter(function(x){ return x.id === sid; })[0];
  if (!s) return null;
  var dMn = DATA.month, dYr = DATA.year;
  var pending = (s.due_months || []).filter(function(m) {
    if (m.year > dYr || (m.year === dYr && m.month > dMn)) return false;
    return (payments[payKey(s.id, m.month, m.year)] || m.status) === 'Pending';
  });
  if (!pending.length) return null;
  var label = pending.length === 1
    ? pending[0].month_name + ' ' + pending[0].year + ' unpaid'
    : pending.length + ' months unpaid';
  return { count: pending.length, label: label };
}

// ── setAtt: optimistic update → Supabase write ──
function setAtt(id, val) {
  if (!activeDay) return;
  if (!attendance[activeDay]) attendance[activeDay] = {};
  if (val === null) delete attendance[activeDay][id]; else attendance[activeDay][id] = val;
  expanded.att = null;
  save(); renderAtt();
  writeAtt(id, activeDay, val).then(notifyQueuedWrite);
  var _attStudent = DATA && DATA.students.filter(function(x){ return x.id===id; })[0];
  logActivity('attendance', (_attStudent ? _attStudent.name : String(id)) + ' → ' + (val || 'cleared') + ' on ' + activeDay);
  if (val === 'present') {
    var due = getDueInfo(id);
    if (due) toast('✅ Present  ·  ⚠️ ' + due.label, 'due');
    else     toast('✅ Present');
  } else {
    toast(val === 'absent' ? '❌ Absent' : '↩ Cleared');
  }
}

function togExp(t, id) {
  expanded[t] = expanded[t]===id ? null : id;
  if (t==='pay' && expanded.pay!==id) {
    Object.keys(expanded.payYear).forEach(function(k) {
      if (k.indexOf(id+'_')===0) delete expanded.payYear[k];
    });
  }
  t==='att' ? renderAtt() : renderPay();
}

function togYearExp(sid, yr) {
  var key = sid + '_' + yr;
  expanded.payYear[key] = !expanded.payYear[key];
  renderPay();
}

// ═══════════════════════════════════════════════════════════
// QR SCANNER  (unchanged)
// ═══════════════════════════════════════════════════════════
function updateScanBadge() {
  var lbl=document.getElementById('scan-day-lbl'), noDay=document.getElementById('scan-no-day'), body=document.getElementById('scan-body');
  if (activeDay) { lbl.textContent=fmtDate(activeDay)+' '+activeDay.slice(0,4); noDay.style.display='none'; body.style.display='block'; }
  else           { noDay.style.display='block'; body.style.display='none'; }
}
async function startScanner() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var buf = audioCtx.createBuffer(1, 1, 22050);
    var src = audioCtx.createBufferSource();
    src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
  } catch(e) {}
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showScanErr('Camera not supported in this browser. Try Chrome on Android.'); return;
  }
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
  } catch(e) { showScanErr('Camera access denied. Enable camera permission in your browser settings, then tap Retry.', true); return; }
  var vid = document.getElementById('scan-video');
  vid.srcObject = scanStream; await vid.play();
  document.getElementById('scan-idle').style.display='none';
  document.getElementById('scan-live').style.display='block';
  if (window.BarcodeDetector) {
    try { detector = new BarcodeDetector({ formats:['qr_code'] }); } catch(e) { detector=null; }
  }
  resumeScanning();
}

function resumeScanning() {
  if (!scanStream) return;
  var vid = document.getElementById('scan-video');
  var cvs = document.getElementById('scan-canvas');
  var ctx = cvs.getContext('2d');
  function loop() {
    if (!scanStream) return;
    if (vid.readyState < 2) { scanRaf = requestAnimationFrame(loop); return; }
    cvs.width = vid.videoWidth; cvs.height = vid.videoHeight;
    ctx.drawImage(vid, 0, 0);
    if (detector) {
      detector.detect(cvs).then(function(codes) {
        if (codes.length) handleQRScan(codes[0].rawValue.trim());
      }).catch(function(){}).finally(function() { if (scanStream) scanRaf = requestAnimationFrame(loop); });
    } else if (window.jsQR) {
      var imageData = ctx.getImageData(0, 0, cvs.width, cvs.height);
      var code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) handleQRScan(code.data.trim());
      scanRaf = requestAnimationFrame(loop);
    } else {
      showScanErr('QR library not loaded. Check your internet connection and reload the page.', false);
      // Try reloading jsQR dynamically
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
      sc.onload = function() { resumeScanning(); };
      sc.onerror = function() {
        showScanErr('QR library unavailable. Check your internet and use the Attendance tab manually.', false);
      };
      document.head.appendChild(sc);
    }
  }
  scanRaf = requestAnimationFrame(loop);
}
function showScanErr(msg, showRetry) {
  var el = document.getElementById('scan-err');
  el.style.display = 'block';
  el.textContent = msg;
  if (!showRetry) return;
  el.appendChild(document.createElement('br'));
  el.appendChild(document.createElement('br'));
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'inline-action-btn';
  btn.setAttribute('data-action', 'retryCamera');
  btn.textContent = '📷 Retry Camera';
  el.appendChild(btn);
}
function retryCamera() {
  var errEl = document.getElementById('scan-err');
  if (errEl) errEl.style.display = 'none';
  startScanner();
}
function stopScanner() {
  if (scanRaf)    { cancelAnimationFrame(scanRaf); scanRaf=null; }
  if (scanStream) { scanStream.getTracks().forEach(function(t){t.stop();}); scanStream=null; }
  detector=null;
  var live=document.getElementById('scan-live'), idle=document.getElementById('scan-idle');
  if (live) live.style.display='none';
  if (idle) idle.style.display='block';
  var err=document.getElementById('scan-err');
  if (err) err.style.display='none';
}
function handleQRScan(value) {
  if (!DATA || !activeDay) return;
  // Sanitize: ignore blank, suspiciously long, or non-alphanumeric values
  if (!value || value.length > QR_MAX_LENGTH) { console.warn('QR value ignored (too long)'); return; }
  value = value.trim();
  if (!/^[a-zA-Z0-9\-_]+$/.test(value)) { console.warn('QR value ignored (invalid chars)'); return; }
  var now = Date.now();
  if (now - lastScannedAt < SCAN_COOLDOWN_MS) return;
  if (value === lastScanned && now - lastScannedAt < DUP_SCAN_WINDOW_MS) return;
  lastScanned = value; lastScannedAt = now;
  var s = DATA.students.filter(function(s) {
    return (s.student_id||'').trim().toLowerCase() === value.toLowerCase() || String(s.id) === value;
  })[0];
  var frame = document.getElementById('scan-frame');
  if (!s) {
    frame.style.borderColor = 'var(--red)';
    frame.style.boxShadow   = '0 0 0 9999px rgba(0,0,0,.5), 0 0 24px rgba(239,68,68,.6)';
    if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = null; }
    toast('❓ Unknown: ' + value);
    setTimeout(function() {
      frame.style.borderColor = 'var(--accent)';
      frame.style.boxShadow   = '0 0 0 9999px rgba(0,0,0,.5)';
      resumeScanning();
    }, 800);
    return;
  }
  if (scanRaf) { cancelAnimationFrame(scanRaf); scanRaf = null; }
  frame.style.borderColor = 'var(--green)';
  frame.style.boxShadow   = '0 0 0 9999px rgba(0,0,0,.5), 0 0 32px rgba(34,197,94,.7)';
  frame.style.transform   = 'scale(1.08)';
  frame.style.transition  = 'all .15s ease';
  beep();
  if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
  if (!attendance[activeDay]) attendance[activeDay] = {};
  attendance[activeDay][s.id] = 'present';
  save();
  writeAtt(s.id, activeDay, 'present').then(notifyQueuedWrite);
  logActivity('qr_scan', s.name + ' — marked Present on ' + activeDay);
  setTimeout(function() {
    frame.style.borderColor = 'var(--accent)';
    frame.style.boxShadow   = '0 0 0 9999px rgba(0,0,0,.5)';
    frame.style.transform   = 'scale(1)';
    var result = document.getElementById('scan-result');
    result.style.opacity   = '0';
    result.style.transform = 'translateY(8px)';
    result.style.transition= 'opacity .25s ease, transform .25s ease';
    result.style.display   = 'block';
    document.getElementById('sr-name').textContent = s.name;
    document.getElementById('sr-id').textContent   = s.student_id || '—';
    var due = getDueInfo(s.id);
    var dueEl = document.getElementById('sr-due');
    if (due) { dueEl.style.display='block'; dueEl.textContent='⚠️ ' + due.label; }
    else { dueEl.style.display='none'; }
    setTimeout(function() { result.style.opacity='1'; result.style.transform='translateY(0)'; }, 20);
    var t=new Date(), ts=pad(t.getHours())+':'+pad(t.getMinutes())+':'+pad(t.getSeconds());
    scanLog.unshift({ name:s.name, time:ts });
    scanLog = scanLog.slice(0, SCAN_LOG_LIMIT);
    document.getElementById('scan-log-wrap').style.display='block';
    renderScanLog();
    renderAtt();
    setTimeout(function() {
      result.style.opacity='0'; result.style.transform='translateY(8px)';
      setTimeout(function() { result.style.display='none'; }, 250);
      resumeScanning();
    }, 1200);
  }, 900);
}

// ═══════════════════════════════════════════════════════════
// PAYMENTS — FILTER TOGGLE
// ═══════════════════════════════════════════════════════════
function togglePayFilter(type) {
  payFilter = payFilter === type ? null : type;
  renderPay();
}
function updatePayFilterUI() {
  ['paid','pending'].forEach(function(f) {
    var el = document.getElementById('fc-' + f);
    if (el) {
      el.classList.toggle('filter-on', payFilter === f);
      el.setAttribute('aria-pressed', payFilter === f ? 'true' : 'false');
    }
  });
  var totalEl = document.getElementById('fc-total');
  if (totalEl) {
    totalEl.classList.remove('filter-on');
    totalEl.setAttribute('aria-pressed', 'false');
  }
}

// ═══════════════════════════════════════════════════════════
// PAYMENTS — RENDER
// ═══════════════════════════════════════════════════════════
function payKey(sid, mn, yr) { return sid + '_' + mn + '_' + yr; }

function renderPay() {
  if (!DATA) return;
  var q = ((document.getElementById('pay-q') || {}).value || '').toLowerCase();
  var curMn = DATA.month, curYr = DATA.year;
  var paidNow=0, pendingNow=0;
  DATA.students.forEach(function(s) {
    var key = payKey(s.id, curMn, curYr);
    var st  = payments[key] || 'Pending';
    if (st === 'Paid') paidNow++; else if (st === 'Pending') pendingNow++;
  });
  document.getElementById('p-paid').textContent    = paidNow;
  document.getElementById('p-pending').textContent = pendingNow;
  document.getElementById('p-total').textContent   = DATA.students.length;
  updatePayFilterUI();

  var list = document.getElementById('pay-list');
  var stus = DATA.students.filter(function(s) {
    if (q && s.name.toLowerCase().indexOf(q)<0 && (s.student_id||'').toLowerCase().indexOf(q)<0) return false;
    if (payFilter) {
      var hasPending = (s.due_months||[]).some(function(m) {
        if (m.year > curYr || (m.year === curYr && m.month > curMn)) return false;
        return (payments[payKey(s.id,m.month,m.year)]||m.status)==='Pending';
      });
      if (payFilter === 'paid')    return !hasPending;
      if (payFilter === 'pending') return hasPending;
    }
    return true;
  });
  if (!stus.length) { renderEmptyState(list, '🔍', 'No students found'); return; }

  clearChildren(list);
  var frag = document.createDocumentFragment();
  stus.forEach(function(s) {
    frag.appendChild(buildPaymentCard(s, expanded.pay === s.id));
  });
  list.appendChild(frag);
}

// ── setPay: optimistic update → Supabase write ──
function setPay(sid, mn, yr, val) {
  var s = DATA && DATA.students.filter(function(x){ return x.id===sid; })[0];
  payments[payKey(sid, mn, yr)] = val;
  save(); renderPay();
  var m = s && (s.due_months||[]).filter(function(m){ return m.month===mn && m.year===yr; })[0];
  var amount = (m && m.amount) || (s && s.fee_amount) || 0;
  writePay(sid, mn, yr, val, amount).then(notifyQueuedWrite);
  logActivity('payment', (s ? s.name : String(sid)) + ' — ' + MONTHS[mn-1] + ' ' + yr + ' → ' + val);
  toast(val==='Paid' ? '✅ Marked Paid' : '↩ Marked Pending');
}

// ═══════════════════════════════════════════════════════════
// STATUS TAB
// ═══════════════════════════════════════════════════════════
function renderStatusSummary() {
  if (!DATA) return;
  var today = activeDay || DATA.export_date;
  var dm    = attendance[today] || {};
  var p=0, a=0;
  Object.values(dm).forEach(function(v){ if(v==='present')p++; else if(v==='absent')a++; });
  var u = DATA.students.length - p - a;
  var totalMonths=0, paidMonths=0;
  var pendingSyncCount = writeQueue.length;
  var failedSyncCount = failedWriteOps.length;
  var sMn = DATA.month, sYr = DATA.year;
  DATA.students.forEach(function(s) {
    (s.due_months||[]).forEach(function(m) {
      if (m.year > sYr || (m.year === sYr && m.month > sMn)) return;
      totalMonths++;
      if ((payments[payKey(s.id,m.month,m.year)]||m.status)==='Paid') paidMonths++;
    });
  });
  var dayLabel = (today === DATA.export_date) ? 'Today' : fmtDate(today);
  var summary = document.getElementById('export-summary');
  if (summary) {
    summary.textContent = '';
    appendSummaryLine(summary, [
      { text: DATA.students.length + ' students', className: 'summary-strong' },
      { text: ' · ' + DATA.month_name + ' ' + DATA.year }
    ]);
    var attendanceLine = [
      { text: '📅 ' + dayLabel + ': ' },
      { text: p + ' present', className: 'summary-accent-good' },
      { text: ' · ' },
      { text: a + ' absent', className: 'summary-accent-danger' }
    ];
    if (u > 0) {
      attendanceLine.push({ text: ' · ' });
      attendanceLine.push({ text: u + ' unmarked', className: 'summary-accent-warn' });
    }
    appendSummaryLine(summary, attendanceLine);
    appendSummaryLine(summary, [
      { text: '💰 ' },
      { text: paidMonths + ' months paid', className: 'summary-accent-good' },
      { text: ' · ' },
      { text: (totalMonths - paidMonths) + ' pending', className: 'summary-accent-warn' }
    ]);
    appendSummaryLine(summary, [
      { text: '☁️ Sync: ' },
      { text: pendingSyncCount + ' queued', className: pendingSyncCount > 0 ? 'summary-accent-warn' : 'summary-meta' },
      { text: ' · ' },
      { text: failedSyncCount + ' failed', className: failedSyncCount > 0 ? 'summary-accent-danger' : 'summary-meta' }
    ]);
    appendSummaryLine(summary, [
      { text: 'Last loaded: ' + new Date(DATA.exported_at).toLocaleTimeString(), className: 'summary-meta' }
    ]);
  }

  // Show pending queue status and retry button
  var queueArea = document.getElementById('sync-queue-area');
  if (queueArea) {
    queueArea.textContent = '';
    if (writeQueue.length > 0) {
      var retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-export btn-export-warn';
      retryBtn.setAttribute('data-action', 'manualFlush');
      retryBtn.textContent = '🔄 Retry Sync (' + writeQueue.length + ' pending)';
      queueArea.appendChild(retryBtn);
    } else if (failedWriteOps.length > 0) {
      var failedBtn = document.createElement('button');
      failedBtn.type = 'button';
      failedBtn.className = 'btn-export btn-export-danger-soft';
      failedBtn.setAttribute('data-action', 'retryFailed');
      failedBtn.textContent = '⚠ Retry Failed Sync (' + failedWriteOps.length + ')';
      queueArea.appendChild(failedBtn);
    } else {
      var ok = document.createElement('div');
      ok.className = 'sync-status-ok';
      ok.textContent = '✅ All changes synced';
      queueArea.appendChild(ok);
    }
  }
}
async function manualFlushQueue() {
  if (!isOnline) { toast('📡 Still offline — cannot sync'); return; }
  if (writeQueue.length === 0) { toast('✅ Nothing to sync'); return; }
  toast('🔄 Retrying sync…');
  await flushWriteQueue();
  renderStatusSummary();
}

async function retryFailedQueue() {
  if (!isOnline) { toast('📡 Still offline — cannot retry failed sync'); return; }
  var moved = retryFailedWrites();
  if (moved === 0) { toast('✅ No failed sync items'); return; }
  toast('🔄 Retrying failed sync…');
  await flushWriteQueue();
  renderStatusSummary();
}

// ═══════════════════════════════════════════════════════════
// UTILS  (unchanged)
// ═══════════════════════════════════════════════════════════
var audioCtx = null;
function appendSummaryLine(container, parts) {
  var line = document.createElement('div');
  line.className = 'summary-line';
  parts.forEach(function(part) {
    var span = document.createElement('span');
    if (part.className) span.className = part.className;
    span.textContent = part.text;
    line.appendChild(span);
  });
  container.appendChild(line);
}

function renderScanLog() {
  var wrap = document.getElementById('scan-log');
  if (!wrap) return;
  wrap.textContent = '';
  var frag = document.createDocumentFragment();
  scanLog.forEach(function(r) {
    var row = document.createElement('div');
    row.className = 'scan-log-item';

    var dot = document.createElement('div');
    dot.className = 'scan-log-dot';
    row.appendChild(dot);

    var name = document.createElement('div');
    name.className = 'scan-log-name';
    name.textContent = r.name;
    row.appendChild(name);

    var time = document.createElement('div');
    time.className = 'scan-log-time';
    time.textContent = r.time;
    row.appendChild(time);

    frag.appendChild(row);
  });
  wrap.appendChild(frag);
}

function initAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch(e) {}
}
function beep() {
  try {
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    var osc=audioCtx.createOscillator(), gain=audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.type='sine'; osc.frequency.setValueAtTime(1046, audioCtx.currentTime);
    gain.gain.setValueAtTime(0.4, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime+0.18);
    osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime+0.18);
  } catch(e) {}
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

// ═══════════════════════════════════════════════════════════
// ACTIVITY LOGGING  (non-blocking — requires activity_logs table in Supabase)
// CREATE TABLE activity_logs (id uuid default gen_random_uuid() primary key,
//   created_at timestamptz default now(), action text, detail text, performed_by text);
// ═══════════════════════════════════════════════════════════
async function logActivity(action, detail) {
  if (!sb || !SUPABASE_URL || !currentUserEmail) return;
  try {
    var r = await sb.auth.getSession();
    var token = r.data && r.data.session ? r.data.session.access_token : null;
    if (!token) return;
    await fetchWithTimeout(SUPABASE_URL + '/rest/v1/activity_logs', {
      method:  'POST',
      headers: sbHeaders(token, 'return=minimal'),
      body:    JSON.stringify({ action: action, detail: detail, performed_by: currentUserEmail })
    }, 8000);
  } catch(e) {
    console.warn('logActivity failed (non-blocking):', e.message);
  }
}
var toastT;
function toast(msg, type) {
  var el=document.getElementById('toast');
  el.textContent=msg;
  el.style.borderColor = type==='due'?'rgba(245,158,11,.5)':'';
  el.style.background  = type==='due'?'#1c1a0f':'';
  el.style.color       = type==='due'?'var(--amber)':'';
  el.classList.add('show');
  clearTimeout(toastT);
  toastT=setTimeout(function(){ el.classList.remove('show'); }, type==='due'?4000:2500);
}

// ═══════════════════════════════════════════════════════════
// ADD STUDENT
// ═══════════════════════════════════════════════════════════
function clearAddStudentForm() {
  ['ns-name','ns-sid','ns-phone','ns-email','ns-fee','ns-joined'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) { if (id === 'ns-fee') el.value = '1000'; else el.value = ''; }
  });
  var clsEl = document.getElementById('ns-class');
  if (clsEl) clsEl.value = 'Academy';
  var grEl = document.getElementById('ns-grade');
  if (grEl) grEl.value = '';
  document.getElementById('ns-err').style.display = 'none';
  document.getElementById('ns-ok').style.display  = 'none';
  var btn = document.getElementById('ns-btn');
  if (btn) { btn.disabled = false; btn.textContent = '➕ Add Student'; }
}

async function addStudent() {
  var name   = (document.getElementById('ns-name').value   || '').trim();
  var sid    = (document.getElementById('ns-sid').value    || '').trim();
  var phone  = (document.getElementById('ns-phone').value  || '').trim();
  var email  = (document.getElementById('ns-email').value  || '').trim();
  var joined = (document.getElementById('ns-joined').value || '').trim();
  var cls    = (document.getElementById('ns-class').value  || 'Academy').trim();
  var grade  = (document.getElementById('ns-grade').value  || '').trim();

  var errEl = document.getElementById('ns-err');
  var okEl  = document.getElementById('ns-ok');
  errEl.style.display = 'none';
  okEl.style.display  = 'none';

  if (!name) {
    errEl.textContent   = 'Full name is required.';
    errEl.style.display = 'block';
    document.getElementById('ns-name').focus();
    return;
  }
  if (name.length < 2 || name.length > 80) {
    errEl.textContent   = 'Name must be 2–80 characters.';
    errEl.style.display = 'block';
    document.getElementById('ns-name').focus();
    return;
  }
  if (!/^[a-zA-Z\s.\-']+$/.test(name)) {
    errEl.textContent   = 'Name can only contain letters, spaces, hyphens, apostrophes, and dots.';
    errEl.style.display = 'block';
    document.getElementById('ns-name').focus();
    return;
  }
  if (!sid) {
    errEl.textContent   = 'Student ID is required.';
    errEl.style.display = 'block';
    document.getElementById('ns-sid').focus();
    return;
  }
  if (!/^\d{5}$/.test(sid)) {
    errEl.textContent   = 'Student ID must be exactly 5 digits (e.g. 10045).';
    errEl.style.display = 'block';
    document.getElementById('ns-sid').focus();
    return;
  }
  if (!phone) {
    errEl.textContent   = 'Phone number is required.';
    errEl.style.display = 'block';
    document.getElementById('ns-phone').focus();
    return;
  }
  if (!/^0\d{9}$/.test(phone)) {
    errEl.textContent   = 'Phone must be 10 digits starting with 0 (e.g. 0771234567).';
    errEl.style.display = 'block';
    document.getElementById('ns-phone').focus();
    return;
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent   = 'Please enter a valid email address.';
    errEl.style.display = 'block';
    document.getElementById('ns-email').focus();
    return;
  }
  var fee = parseFloat(document.getElementById('ns-fee').value);
  if (isNaN(fee) || fee <= 0 || fee > 100000) {
    errEl.textContent   = 'Monthly fee must be between 1 and 100,000.';
    errEl.style.display = 'block';
    document.getElementById('ns-fee').focus();
    return;
  }
  if (joined && joined > todayISO()) {
    errEl.textContent   = 'Joined date cannot be in the future.';
    errEl.style.display = 'block';
    document.getElementById('ns-joined').focus();
    return;
  }

  var btn = document.getElementById('ns-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    var payload = {
      name:        name,
      fee_amount:  fee,
      active:      true,
      class:       cls,
      grade:       grade || null
    };
    if (sid)    payload.student_id  = sid;
    if (phone)  payload.phone       = phone;
    if (email)  payload.email       = email;
    if (joined) payload.joined_date = joined;

    // Use stored token — fixes iOS Safari auth drop issue
    var token = await getToken();

    var insertResp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/students', {
      method:  'POST',
      headers: sbHeaders(token, 'return=representation'),
      body: JSON.stringify(payload)
    });

    var data  = null;
    var error = null;
    if (insertResp.ok) {
      data = await insertResp.json();
    } else {
      var errBody = await insertResp.json().catch(function(){ return {}; });
      error = { code: errBody.code || '', message: errBody.message || ('HTTP ' + insertResp.status) };
    }

    if (error) {
      console.error('addStudent error:', error.code, error.message);
      if (error.code === '23505') {
        errEl.textContent = 'Student ID "' + sid + '" already exists. Use a different ID.';
      } else {
        errEl.textContent = 'Could not add student. Please check your connection and try again.';
      }
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = '➕ Add Student';
      return;
    }

    // Success — add to local DATA so they appear immediately without full refresh
    if (data && data.length > 0) {
      var newS = data[0];
      var today = todayISO();
      var now   = new Date();
      var mn    = now.getMonth() + 1;
      var yr    = now.getFullYear();
      var created = newS.created_at || today;
      var startDate = new Date(created);
      var due = [];
      var cur_mn = startDate.getMonth() + 1;
      var cur_yr = startDate.getFullYear();
      while (cur_yr < yr || (cur_yr === yr && cur_mn <= mn)) {
        var key = newS.id + '_' + cur_mn + '_' + cur_yr;
        due.push({ month: cur_mn, year: cur_yr, month_name: MONTHS[cur_mn - 1], status: 'Pending', amount: fee });
        payments[key] = 'Pending';
        cur_mn++;
        if (cur_mn > 12) { cur_mn = 1; cur_yr++; }
      }
      var studentEntry = {
        id: newS.id, student_id: newS.student_id, name: newS.name,
        phone: newS.phone, email: newS.email, fee_amount: newS.fee_amount,
        active: newS.active, created_at: newS.created_at,
        joined_date: newS.joined_date,
        class: newS.class || cls, grade: newS.grade || grade,
        attendance_today: null, due_months: due
      };
      if (DATA && DATA.students) {
        DATA.students.push(studentEntry);
        DATA.students.sort(function(a,b){ return a.name.localeCompare(b.name); });
      }
    }

    logActivity('add_student', name + ' (ID: ' + sid + ')');
    okEl.textContent   = '✓ ' + name + ' added successfully!';
    okEl.style.display = 'block';
    toast('✅ ' + name + ' added!');
    clearAddStudentForm();

  } catch(e) {
    errEl.textContent  = 'Unexpected error. Please try again.';
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = '➕ Add Student';
  }
}

// ═══════════════════════════════════════════════════════════
// BOOT  (waits for DOMContentLoaded so deferred scripts are loaded)
// ═══════════════════════════════════════════════════════════
function boot() {
  // NOTE: The Supabase anon key below is intentionally public — it is safe to embed
  // as long as Row Level Security (RLS) is enabled on all tables in Supabase.
  var url = 'https://yssmwhsjxrhoodrzbead.supabase.co';
  var key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlzc213aHNqeHJob29kcnpiZWFkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NzMzNTgsImV4cCI6MjA4OTA0OTM1OH0.IO4F6Ug5NlHfY0hdQPgoim45OgXiGDVWeEq0MGzA3Ms';
  SUPABASE_URL = url;
  SUPABASE_KEY = key;
  if (!initSupabaseClient(url, key)) return;
  // Restore any offline queue from previous session
  loadQueue();
  // Check for an existing Supabase Auth session
  sb.auth.getSession().then(function(result) {
    if (result.data && result.data.session) {
      AUTH_TOKEN = result.data.session.access_token;
      currentUserEmail = (result.data.session.user && result.data.session.user.email) || ADMIN_EMAIL;
      resetSessionTimer();
      showLoading('Loading students…');
      loadFromSupabase().then(function() {
        // Flush any pending offline writes now that we're authenticated
        if (writeQueue.length > 0 && isOnline) flushWriteQueue();
      });
    } else {
      showConnectScreen();
    }
  }).catch(function(e) {
    console.error('Boot session check failed:', e);
    showBootError('Could not connect to server. Check your internet and try again.');
  });

  // Debounced search inputs (O2)
  var attQ = document.getElementById('att-q');
  var payQ = document.getElementById('pay-q');
  if (attQ) attQ.addEventListener('input', debounce(renderAtt, 180));
  if (payQ) payQ.addEventListener('input', debounce(renderPay, 180));
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDINGS (CSP-safe — no inline handlers)
// ═══════════════════════════════════════════════════════════

// Global event delegation for dynamically generated elements
document.addEventListener('click', function(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.getAttribute('data-action');
  switch (action) {
    case 'reload':       location.reload(); break;
    case 'selectDay':    selectDay(el.getAttribute('data-day')); break;
    case 'openDateModal':openDateModal(); break;
    case 'togExp':       togExp(el.getAttribute('data-type'), Number(el.getAttribute('data-id'))); break;
    case 'setAtt':       setAtt(Number(el.getAttribute('data-id')), el.getAttribute('data-status') || null); break;
    case 'setPay':       setPay(Number(el.getAttribute('data-id')), Number(el.getAttribute('data-month')), Number(el.getAttribute('data-year')), el.getAttribute('data-status')); break;
    case 'togYearExp':   togYearExp(Number(el.getAttribute('data-id')), Number(el.getAttribute('data-year'))); break;
    case 'retryCamera':  retryCamera(); break;
    case 'manualFlush':  manualFlushQueue(); break;
    case 'retryFailed':  retryFailedQueue(); break;
  }
});

document.addEventListener('keydown', function(e) {
  var modal = document.getElementById('date-modal');
  if (e.key === 'Escape' && modal && modal.style.display === 'flex') {
    closeDateModal();
    return;
  }
  if (modal && modal.style.display === 'flex' && e.key === 'Tab') {
    trapFocus(e, modal);
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  var target = e.target.closest('[data-action], [data-filter], [data-payfilter]');
  if (!target) return;
  if (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  e.preventDefault();
  target.click();
});

function trapFocus(e, modal) {
  var focusable = modal.querySelectorAll('button:not([disabled]), input:not([disabled])');
  if (!focusable.length) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Static element bindings
function bindStaticEvents() {
  // Login
  var loginEmail = document.getElementById('login-email');
  var loginPw = document.getElementById('login-pw');
  var loginBtn = document.getElementById('login-btn');
  if (loginEmail) loginEmail.addEventListener('keydown', function(e) { if (e.key === 'Enter') loginPw.focus(); });
  if (loginPw) loginPw.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
  if (loginBtn) loginBtn.addEventListener('click', doLogin);

  // Logout buttons
  var topbarLogout = document.getElementById('topbar-logout');
  if (topbarLogout) topbarLogout.addEventListener('click', disconnectSupabase);
  var logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', disconnectSupabase);

  // Tab bar
  document.querySelectorAll('.tab[data-tab]').forEach(function(tab) {
    tab.id = 'tab-' + tab.getAttribute('data-tab') + '-btn';
    tab.addEventListener('click', function() { switchTab(tab.getAttribute('data-tab')); });
    tab.addEventListener('keydown', function(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab[data-tab]'));
      var index = tabs.indexOf(tab);
      var nextIndex = e.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : (index - 1 + tabs.length) % tabs.length;
      tabs[nextIndex].focus();
      switchTab(tabs[nextIndex].getAttribute('data-tab'));
    });
  });

  // Attendance filter cards
  document.querySelectorAll('[data-filter]').forEach(function(card) {
    card.addEventListener('click', function() { toggleAttFilter(card.getAttribute('data-filter')); });
  });

  // Payment filter cards
  document.querySelectorAll('[data-payfilter]').forEach(function(card) {
    card.addEventListener('click', function() { togglePayFilter(card.getAttribute('data-payfilter') || null); });
  });

  // Scan tab
  var scanChangeDayBtn = document.getElementById('scan-change-day-btn');
  if (scanChangeDayBtn) scanChangeDayBtn.addEventListener('click', function() { switchTab('attendance'); });
  var startBtn = document.getElementById('start-btn');
  if (startBtn) startBtn.addEventListener('click', startScanner);
  var stopBtn = document.getElementById('stop-btn');
  if (stopBtn) stopBtn.addEventListener('click', stopScanner);

  // Add student
  var nsBtn = document.getElementById('ns-btn');
  if (nsBtn) nsBtn.addEventListener('click', addStudent);

  // Refresh data
  var refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshData);

  // Date modal
  var dateModal = document.getElementById('date-modal');
  var dateModalSheet = document.getElementById('date-modal-sheet');
  if (dateModal) dateModal.addEventListener('click', closeDateModal);
  if (dateModalSheet) dateModalSheet.addEventListener('click', function(e) { e.stopPropagation(); });
  var dInput = document.getElementById('d-input');
  if (dInput) dInput.addEventListener('input', function() { onDateInput(dInput.value); });
  if (dInput) dInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !document.getElementById('d-confirm').disabled) confirmDateModal();
  });
  var dCancel = document.getElementById('d-cancel');
  if (dCancel) dCancel.addEventListener('click', closeDateModal);
  var dConfirm = document.getElementById('d-confirm');
  if (dConfirm) dConfirm.addEventListener('click', confirmDateModal);
}

// Wait for deferred CDN scripts to load before booting
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { bindStaticEvents(); boot(); });
} else {
  bindStaticEvents();
  boot();
}
