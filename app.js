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

// ═══════════════════════════════════════════════════════════
// STATE  (unchanged from original)
// ═══════════════════════════════════════════════════════════
var DATA       = null;
var attendance = {};   // { "YYYY-MM-DD": { dbId: "present"|"absent" } }
var payments   = {};   // { "id_month_year": "Paid"|"Pending"|"Waived" }
var classDays  = [];
var activeDay  = null;
var attLoadedDates = {};   // tracks which dates have had attendance fetched from DB
var expanded   = { att:null, pay:null };
var scanLog    = [];
var scanStream = null, scanRaf = null;
var lastScanned = null, lastScannedAt = 0;
var detector   = null;

// Login rate limiting (S5)
var loginAttempts = 0;
var loginLockUntil = 0;

// Offline queue & connectivity (E1/E3)
var writeQueue = [];
var isOnline   = navigator.onLine;
var syncCount  = 0;           // number of in-flight sync requests
var currentUserEmail = '';    // set at login, used for activity logging

// Queue persistence keys
var QUEUE_KEY = 'ara_v4_writeQueue';
function saveQueue() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(writeQueue)); } catch(e) {}
}
function loadQueue() {
  try {
    var raw = localStorage.getItem(QUEUE_KEY);
    if (raw) { var q = JSON.parse(raw); if (Array.isArray(q)) writeQueue = q; }
  } catch(e) {}
}
function queueWrite(op) { writeQueue.push(op); saveQueue(); }

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
  timeoutMs = timeoutMs || 15000;
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
  el.innerHTML = '❌ ' + esc(msg)
    + '<br><br><button data-action="reload" style="background:var(--accent);color:white;border:none;'
    + 'border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)">'
    + '🔄 Reload</button>';
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
  btn.innerHTML = '🔓 &nbsp; Login';
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

      // Build full due_months list from join date → today
      var due_months = [];
      var mi = startMn, yi = startYr;
      while (yi < yr || (yi === yr && mi <= mn)) {
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

// ═══════════════════════════════════════════════════════════
// SUPABASE — WRITE ATTENDANCE
// ═══════════════════════════════════════════════════════════
async function writeAtt(studentId, date, status) {
  if (!sb) return;
  if (!isOnline) {
    queueWrite({ type: 'att', studentId: studentId, date: date, status: status });
    toast('📡 Offline — will sync when back online');
    return;
  }
  setSyncing(1);
  try {
    var token = await getToken();
    var headers = sbHeaders(token);
    var resp;
    if (status === null) {
      resp = await fetchWithTimeout(
        SUPABASE_URL + '/rest/v1/attendance?student_id=eq.' + encodeURIComponent(studentId) + '&date=eq.' + encodeURIComponent(date),
        { method: 'DELETE', headers: headers }
      );
    } else {
      resp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/attendance?on_conflict=student_id,date', {
        method:  'POST',
        headers: headers,
        body:    JSON.stringify({ student_id: studentId, date: date, status: status })
      });
    }
    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {}; });
      console.error('writeAtt failed:', resp.status);
      queueWrite({ type: 'att', studentId: studentId, date: date, status: status });
      toast('⚠️ Sync error — will retry automatically');
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      queueWrite({ type: 'att', studentId: studentId, date: date, status: status });
      toast('⚠️ Request timed out — will retry');
    } else if (e.message === 'Session expired') {
      // handled by getToken
    } else {
      console.error('writeAtt error:', e);
      queueWrite({ type: 'att', studentId: studentId, date: date, status: status });
      toast('⚠️ Sync error — will retry when online');
    }
  } finally {
    setSyncing(-1);
  }
}

// ═══════════════════════════════════════════════════════════
// SUPABASE — WRITE PAYMENT
// ═══════════════════════════════════════════════════════════
async function writePay(studentId, month, year, status, amount) {
  if (!sb) return;
  if (!isOnline) {
    queueWrite({ type: 'pay', studentId: studentId, month: month, year: year, status: status, amount: amount });
    toast('📡 Offline — will sync when back online');
    return;
  }
  setSyncing(1);
  try {
    var token = await getToken();
    var headers = sbHeaders(token);
    var resp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/payments?on_conflict=student_id,month,year', {
      method:  'POST',
      headers: headers,
      body:    JSON.stringify({
        student_id: studentId,
        month:      month,
        year:       year,
        amount:     amount,
        paid:       status === 'Paid',
        paid_date:  status === 'Paid' ? new Date().toISOString() : null,
        waived:     status === 'Waived',
        status:     (status === 'Paid' || status === 'Waived') ? 'final' : 'disputed'
      })
    });
    if (!resp.ok) {
      var err = await resp.json().catch(function() { return {}; });
      console.error('writePay failed:', resp.status);
      queueWrite({ type: 'pay', studentId: studentId, month: month, year: year, status: status, amount: amount });
      toast('⚠️ Sync error — will retry automatically');
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      queueWrite({ type: 'pay', studentId: studentId, month: month, year: year, status: status, amount: amount });
      toast('⚠️ Request timed out — will retry');
    } else if (e.message === 'Session expired') {
      // handled by getToken
    } else {
      console.error('writePay error:', e);
      queueWrite({ type: 'pay', studentId: studentId, month: month, year: year, status: status, amount: amount });
      toast('⚠️ Sync error — will retry when online');
    }
  } finally {
    setSyncing(-1);
  }
}

// ═══════════════════════════════════════════════════════════
// OFFLINE QUEUE — FLUSH ON RECONNECT
// ═══════════════════════════════════════════════════════════
async function flushWriteQueue() {
  if (!isOnline || writeQueue.length === 0) return;
  var pending = writeQueue.splice(0);
  var failed = [];
  for (var i = 0; i < pending.length; i++) {
    var op = pending[i];
    try {
      var token = await getToken();
      var headers = sbHeaders(token);
      var resp;
      if (op.type === 'att') {
        if (op.status === null) {
          resp = await fetchWithTimeout(
            SUPABASE_URL + '/rest/v1/attendance?student_id=eq.' + encodeURIComponent(op.studentId) + '&date=eq.' + encodeURIComponent(op.date),
            { method: 'DELETE', headers: headers }
          );
        } else {
          resp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/attendance?on_conflict=student_id,date', {
            method: 'POST', headers: headers,
            body: JSON.stringify({ student_id: op.studentId, date: op.date, status: op.status })
          });
        }
      } else if (op.type === 'pay') {
        resp = await fetchWithTimeout(SUPABASE_URL + '/rest/v1/payments?on_conflict=student_id,month,year', {
          method: 'POST', headers: headers,
          body: JSON.stringify({
            student_id: op.studentId, month: op.month, year: op.year, amount: op.amount,
            paid: op.status === 'Paid', paid_date: op.status === 'Paid' ? new Date().toISOString() : null,
            waived: op.status === 'Waived',
            status: (op.status === 'Paid' || op.status === 'Waived') ? 'final' : 'disputed'
          })
        });
      }
      if (resp && !resp.ok) { failed.push(op); }
    } catch(e) {
      failed.push(op);
    }
  }
  writeQueue = failed.concat(writeQueue);
  saveQueue();
  if (failed.length === 0 && pending.length > 0) {
    toast('✅ All queued changes synced');
    renderStatusSummary();
  } else if (failed.length > 0) {
    toast('⚠️ ' + failed.length + ' change(s) failed to sync');
    renderStatusSummary();
  }
}

function updateOfflineBanner() {
  var el = document.getElementById('offline-banner');
  if (el) el.style.display = isOnline ? 'none' : 'block';
  var pill = document.getElementById('topbar-status');
  if (pill) {
    pill.className = isOnline ? 'live' : 'offline';
    pill.innerHTML = '<span class="dot"></span>' + (isOnline ? 'Live' : 'Offline');
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
  tabs.forEach(function(t, i) {
    document.querySelectorAll('.tab')[i].classList.toggle('active', t === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });
  document.getElementById('tab-' + name).classList.add('active');
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
  var inp = document.getElementById('d-input');
  var today = todayISO();
  inp.value = today;
  onDateInput(today);
  document.getElementById('date-modal').style.display = 'flex';
  setTimeout(function() { inp.focus(); inp.select(); }, 80);
}
function closeDateModal() {
  document.getElementById('date-modal').style.display = 'none';
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
  var chips = classDays.map(function(d) {
    return '<div class="day-chip'+(d===activeDay?' active':'')+'" data-action="selectDay" data-day="'+d+'">'+fmtDate(d)+'</div>';
  }).join('');
  bar.innerHTML = chips + '<div class="day-chip add-btn" data-action="openDateModal">+ New Day</div>';
  var hasDays = classDays.length > 0;
  document.getElementById('no-day-msg').style.display  = hasDays ? 'none' : 'block';
  document.getElementById('att-body').style.display    = hasDays ? 'block' : 'none';
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
    if (el) el.classList.toggle('filter-on', attFilter === f);
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
  if (!stus.length) { list.innerHTML='<div class="empty"><div class="big">🔍</div>No students found</div>'; return; }
  list.innerHTML = stus.map(function(s) {
    var st=dm[s.id], cc=st==='present'?'present':st==='absent'?'absent':'', isO=expanded.att===s.id;
    var sl=st==='present'?'Present':st==='absent'?'Absent':'—', sc=st==='present'?'sp':st==='absent'?'sa':'sn';
    var ini=s.name.split(' ').map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase();
    return '<div class="student-card '+cc+(isO?' open':'')+'">'
      +'<div class="sc-main" data-action="togExp" data-type="att" data-id="'+s.id+'">'
        +'<div class="sc-av">'+ini+'</div>'
        +'<div class="sc-info"><div class="sc-name">'+esc(s.name)+'</div><div class="sc-sub">'+esc(s.student_id||'—')+'</div></div>'
        +'<div class="sc-st '+sc+'">'+sl+'</div>'
      +'</div>'
      +'<div class="sc-acts">'
        +'<button class="act a-present" data-action="setAtt" data-id="'+s.id+'" data-status="present">✅ Present</button>'
        +'<button class="act a-absent"  data-action="setAtt" data-id="'+s.id+'" data-status="absent">❌ Absent</button>'
        +'<button class="act a-ghost"   data-action="setAtt" data-id="'+s.id+'" data-status="" style="flex:.5">↩</button>'
      +'</div></div>';
  }).join('');
}

function getDueInfo(sid) {
  var s = DATA && DATA.students.filter(function(x){ return x.id === sid; })[0];
  if (!s) return null;
  var pending = (s.due_months || []).filter(function(m) {
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
  writeAtt(id, activeDay, val);   // fire-and-forget
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

function togExp(t, id) { expanded[t] = expanded[t]===id ? null : id; t==='att' ? renderAtt() : renderPay(); }

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
  if (showRetry) {
    el.innerHTML = esc(msg)
      + '<br><br><button data-action="retryCamera" style="background:var(--accent);color:white;border:none;'
      + 'border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font)">'
      + '📷 Retry Camera</button>';
  } else {
    el.textContent = msg;
  }
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
  if (!value || value.length > 100) { console.warn('QR value ignored (too long)'); return; }
  value = value.trim();
  if (!/^[a-zA-Z0-9\-_]+$/.test(value)) { console.warn('QR value ignored (invalid chars)'); return; }
  var now = Date.now();
  if (now - lastScannedAt < 1500) return;               // universal cooldown between any two scans
  if (value === lastScanned && now - lastScannedAt < 4000) return;
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
  writeAtt(s.id, activeDay, 'present');   // write to Supabase
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
    document.getElementById('scan-log-wrap').style.display='block';
    document.getElementById('scan-log').innerHTML=scanLog.slice(0,20).map(function(r) {
      return '<div style="display:flex;align-items:center;gap:10px;background:var(--surf);border:1px solid var(--border);border-radius:8px;padding:9px 12px;margin-bottom:6px">'
        +'<div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0"></div>'
        +'<div style="flex:1;font-size:14px;font-weight:600">'+esc(r.name)+'</div>'
        +'<div style="font-size:12px;color:var(--muted)">'+r.time+'</div></div>';
    }).join('');
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
    if (el) el.classList.toggle('filter-on', payFilter === f);
  });
  var totalEl = document.getElementById('fc-total');
  if (totalEl) totalEl.classList.remove('filter-on');
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
        return (payments[payKey(s.id,m.month,m.year)]||m.status)==='Pending';
      });
      if (payFilter === 'paid')    return !hasPending;
      if (payFilter === 'pending') return hasPending;
    }
    return true;
  });
  if (!stus.length) { list.innerHTML='<div class="empty"><div class="big">🔍</div>No students found</div>'; return; }

  list.innerHTML = stus.map(function(s) {
    var months = s.due_months || [];
    var isO    = expanded.pay === s.id;
    var ini    = s.name.split(' ').map(function(w){return w[0]||'';}).slice(0,2).join('').toUpperCase();
    var pendingCount = months.filter(function(m) {
      return (payments[payKey(s.id,m.month,m.year)]||m.status)==='Pending';
    }).length;
    var allPaid = pendingCount === 0;
    var totalAmt = months.filter(function(m) {
      return (payments[payKey(s.id,m.month,m.year)]||m.status)==='Pending';
    }).reduce(function(sum,m){ return sum+(m.amount||0); }, 0);
    var badge = allPaid
      ? '<div class="sc-st sk">All Paid</div>'
      : '<div class="sc-st sq">'+pendingCount+' unpaid</div>';
    var monthRows = months.map(function(m) {
      var key=payKey(s.id,m.month,m.year), st=payments[key]||m.status;
      var isPaid=st==='Paid', isWaived=st==='Waived';
      var rowColor=isPaid?'rgba(34,197,94,.06)':isWaived?'rgba(167,139,250,.06)':'rgba(245,158,11,.06)';
      var badge2=isPaid?'<span style="font-size:11px;font-weight:700;color:var(--green)">✅ Paid</span>'
                :isWaived?'<span style="font-size:11px;font-weight:700;color:#a78bfa">🎫 Waived</span>'
                :'<span style="font-size:11px;font-weight:700;color:var(--amber)">Pending</span>';
      var btn=isWaived?'':isPaid
        ?'<button data-action="setPay" data-id="'+s.id+'" data-month="'+m.month+'" data-year="'+m.year+'" data-status="Pending" style="background:var(--surf2);color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:var(--font);-webkit-appearance:none;">↩</button>'
        :'<button data-action="setPay" data-id="'+s.id+'" data-month="'+m.month+'" data-year="'+m.year+'" data-status="Paid" style="background:var(--green);color:white;border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;font-family:var(--font);-webkit-appearance:none;">Mark Paid</button>';
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:'+rowColor+';border-top:1px solid var(--border);">'
        +'<div style="flex:1;font-size:13px;font-weight:600;">'+m.month_name+' '+m.year+'</div>'
        +'<div style="font-size:12px;color:var(--muted);margin-right:4px;">Rs. '+Number(m.amount||0).toLocaleString()+'</div>'
        +badge2+'<div style="margin-left:4px;">'+btn+'</div></div>';
    }).join('');
    var footer=(!allPaid&&isO)
      ?'<div style="display:flex;justify-content:space-between;padding:8px 12px 10px;border-top:1px solid var(--border);background:rgba(245,158,11,.06);">'
        +'<span style="font-size:13px;font-weight:700;color:var(--amber)">Total Due</span>'
        +'<span style="font-size:13px;font-weight:700;color:var(--amber)">Rs. '+totalAmt.toLocaleString()+'</span></div>'
      :'';
    return '<div class="student-card '+(allPaid?'paid':'')+(isO?' open':'')+'">'
      +'<div class="sc-main" data-action="togExp" data-type="pay" data-id="'+s.id+'">'
        +'<div class="sc-av">'+ini+'</div>'
        +'<div class="sc-info"><div class="sc-name">'+esc(s.name)+'</div>'
        +'<div class="sc-sub">'+esc(s.student_id||'—')+'</div></div>'
        +badge+'</div>'
      +(isO ? monthRows + footer : '')
      +'</div>';
  }).join('');
}

// ── setPay: optimistic update → Supabase write ──
function setPay(sid, mn, yr, val) {
  var s = DATA && DATA.students.filter(function(x){ return x.id===sid; })[0];
  payments[payKey(sid, mn, yr)] = val;
  save(); renderPay();
  var m = s && (s.due_months||[]).filter(function(m){ return m.month===mn && m.year===yr; })[0];
  var amount = (m && m.amount) || (s && s.fee_amount) || 0;
  writePay(sid, mn, yr, val, amount);   // fire-and-forget
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
  DATA.students.forEach(function(s) {
    (s.due_months||[]).forEach(function(m) {
      totalMonths++;
      if ((payments[payKey(s.id,m.month,m.year)]||m.status)==='Paid') paidMonths++;
    });
  });
  var html = '<b>'+DATA.students.length+' students</b> · '+DATA.month_name+' '+DATA.year+'<br>';
  var dayLabel = (today === DATA.export_date) ? 'Today' : fmtDate(today);
  html += '📅 ' + dayLabel + ': <span style="color:var(--green)">'+p+'</span> present';
  html += ' · <span style="color:var(--red)">'+a+'</span> absent';
  if (u>0) html += ' · <span style="color:var(--amber)">'+u+'</span> unmarked';
  html += '<br>💰 <span style="color:var(--green)">'+paidMonths+'</span> months paid';
  html += ' · <span style="color:var(--amber)">'+(totalMonths-paidMonths)+'</span> pending<br>';
  html += '<br><span style="color:var(--muted);font-size:11px">Last loaded: ';
  html += new Date(DATA.exported_at).toLocaleTimeString() + '</span>';
  document.getElementById('export-summary').innerHTML = html;

  // Show pending queue status and retry button
  var queueArea = document.getElementById('sync-queue-area');
  if (queueArea) {
    if (writeQueue.length > 0) {
      queueArea.innerHTML = '<button data-action="manualFlush" class="btn-export" '
        + 'style="background:var(--amber);color:#1a1008;margin-top:0;font-size:14px">'
        + '🔄 Retry Sync (' + writeQueue.length + ' pending)</button>';
    } else {
      queueArea.innerHTML = '<div style="font-size:13px;color:var(--green);text-align:center;padding:4px 0">✅ All changes synced</div>';
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

// ═══════════════════════════════════════════════════════════
// UTILS  (unchanged)
// ═══════════════════════════════════════════════════════════
var audioCtx = null;
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
  if (btn) { btn.disabled = false; btn.innerHTML = '➕ &nbsp; Add Student'; }
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
  btn.innerHTML = 'Saving…';

  try {
    var payload = {
      name:        name,
      fee_amount:  fee,
      active:      true,
      achievements: '',
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
      btn.innerHTML = '➕ &nbsp; Add Student';
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
        joined_date: newS.joined_date, achievements: newS.achievements || '',
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
    errEl.textContent  = 'Unexpected error: ' + e.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '➕ &nbsp; Add Student';
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
    case 'retryCamera':  retryCamera(); break;
    case 'manualFlush':  manualFlushQueue(); break;
  }
});

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
    tab.addEventListener('click', function() { switchTab(tab.getAttribute('data-tab')); });
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
