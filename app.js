/* ==================================================================
   مصروفي — منطق التطبيق الرئيسي
   - يعمل 100% بدون إنترنت (LocalStorage)
   - يزامن مع Google Sheets عبر JSONP + إعادة حساب الرصيد من الخادم
   ================================================================== */

'use strict';

/* ============================================================
   1. الثوابت والإعدادات
   ============================================================ */

const LS_KEYS = {
  ACCOUNTS: 'mishwar_accounts',
  TRANSACTIONS: 'mishwar_transactions',
  SETTINGS: 'mishwar_settings',
  DELETED: 'mishwar_deleted',
  META: 'mishwar_meta'
};

const SHEETS = {
  ACCOUNTS: 'ملخص_الحسابات',
  TRANSACTIONS: 'سجل_المعاملات'
};

const COLUMNS = {
  ACCOUNTS: ['رقم_الحساب', 'اسم_الشخص', 'المبلغ_الافتتاحي',
             'إجمالي_الإيرادات', 'إجمالي_المصروفات', 'المبلغ_المتبقي',
             'تاريخ_التحديث'],
  TRANSACTIONS: ['رقم_المعاملة', 'اسم_الشخص', 'نوع_المعاملة', 'القيمة',
                 'التاريخ_والوقت', 'ملاحظات']
};

/* ============================================================
   2. أدوات مساعدة
   ============================================================ */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const uid = (prefix = 'ID') =>
  prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const fmtMoney = (n) => {
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const toLocalInputValue = (d = new Date()) => {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const nowISO = () => new Date().toISOString();

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.error('خطأ في الكتابة', e); return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast is-visible' + (type ? ' toast--' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('is-visible'); }, 2600);
}

/* ============================================================
   3. طبقة البيانات
   ============================================================ */

const DB = {
  getAccounts() { return store.read(LS_KEYS.ACCOUNTS, []); },
  saveAccounts(list) { store.write(LS_KEYS.ACCOUNTS, list); },

  getTransactions() { return store.read(LS_KEYS.TRANSACTIONS, []); },
  saveTransactions(list) { store.write(LS_KEYS.TRANSACTIONS, list); },

  getDeleted() { return store.read(LS_KEYS.DELETED, { accounts: [], transactions: [] }); },
  saveDeleted(d) { store.write(LS_KEYS.DELETED, d); },

  getSettings() {
    return Object.assign({
      scriptUrl: '',
      scriptToken: '',
      autoSync: true,
      theme: 'light',
      lastSync: null
    }, store.read(LS_KEYS.SETTINGS, {}));
  },
  saveSettings(s) { store.write(LS_KEYS.SETTINGS, s); },

  findAccount(personName) {
    return DB.getAccounts().find(a => a['اسم_الشخص'] === personName);
  },

  /* 🔑 إعادة حساب ملخص حساب واحد بناءً على معاملاته */
  recalcAccount(personName) {
    const accounts = DB.getAccounts();
    const txs = DB.getTransactions().filter(t => t['اسم_الشخص'] === personName);
    const idx = accounts.findIndex(a => a['اسم_الشخص'] === personName);
    if (idx < 0) return;

    const opening = Number(accounts[idx]['المبلغ_الافتتاحي']) || 0;
    let income = 0, expense = 0;

    txs.forEach(t => {
      const v = Number(t['القيمة']) || 0;
      const type = String(t['نوع_المعاملة'] || '').trim();
      if (type === 'إيراد') income += v;
      else if (type === 'مصروف') expense += v;
    });

    accounts[idx]['إجمالي_الإيرادات'] = +income.toFixed(2);
    accounts[idx]['إجمالي_المصروفات'] = +expense.toFixed(2);
    accounts[idx]['المبلغ_المتبقي']   = +(opening + income - expense).toFixed(2);
    accounts[idx]['تاريخ_التحديث']    = nowISO();
    DB.saveAccounts(accounts);
  },

  /* 🔑 إعادة حساب جميع الحسابات */
  recalcAllAccounts() {
    const persons = DB.getAccounts().map(a => a['اسم_الشخص']);
    persons.forEach(p => DB.recalcAccount(p));
  },

  ensureAccount(personName, opening = 0) {
    const accounts = DB.getAccounts();
    if (accounts.find(a => a['اسم_الشخص'] === personName)) return;
    accounts.push({
      'رقم_الحساب': uid('ACC'),
      'اسم_الشخص': personName,
      'المبلغ_الافتتاحي': +opening || 0,
      'إجمالي_الإيرادات': 0,
      'إجمالي_المصروفات': 0,
      'المبلغ_المتبقي': +opening || 0,
      'تاريخ_التحديث': nowISO()
    });
    DB.saveAccounts(accounts);
  },

  addTransaction({ person, type, amount, datetime, notes }) {
    const txs = DB.getTransactions();
    const tx = {
      'رقم_المعاملة': uid('TX'),
      'اسم_الشخص': person,
      'نوع_المعاملة': type,
      'القيمة': +Number(amount).toFixed(2),
      'التاريخ_والوقت': datetime,
      'ملاحظات': notes || ''
    };
    txs.unshift(tx);
    DB.saveTransactions(txs);
    DB.recalcAccount(person);
    return tx;
  },

  deleteTransaction(id) {
    const txs = DB.getTransactions();
    const tx = txs.find(t => t['رقم_المعاملة'] === id);
    if (!tx) return;
    DB.saveTransactions(txs.filter(t => t['رقم_المعاملة'] !== id));
    const del = DB.getDeleted();
    del.transactions.push(id);
    DB.saveDeleted(del);
    DB.recalcAccount(tx['اسم_الشخص']);
  }
};

/* ============================================================
   4. المزامنة مع Google Sheets (JSONP)
   ============================================================ */

const Sync = {
  isOnline() { return navigator.onLine; },

  updateBadge() {
    const badge = $('#net-badge');
    if (Sync.isOnline()) {
      badge.textContent = 'متصل';
      badge.className = 'badge badge--on';
    } else {
      badge.textContent = 'غير متصل';
      badge.className = 'badge badge--off';
    }
  },

  buildPayload() {
    return {
      token: DB.getSettings().scriptToken || '',
      action: 'sync',
      data: {
        [SHEETS.ACCOUNTS]: DB.getAccounts(),
        [SHEETS.TRANSACTIONS]: DB.getTransactions()
      },
      deleted: DB.getDeleted()
    };
  },

  /* الدفع (POST) */
  async push() {
    const settings = DB.getSettings();
    if (!settings.scriptUrl) throw new Error('لم يتم إعداد رابط المزامنة');
    if (!navigator.onLine) throw new Error('لا يوجد اتصال بالإنترنت');

    await fetch(settings.scriptUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Sync.buildPayload())
    });
  },

  /* السحب (GET) عبر JSONP */
  async pull() {
    const settings = DB.getSettings();
    if (!settings.scriptUrl) throw new Error('لم يتم إعداد رابط المزامنة');
    if (!navigator.onLine) throw new Error('لا يوجد اتصال بالإنترنت');

    if (settings.scriptUrl.includes('/dev')) {
      throw new Error('الرابط المستخدم هو /dev — استخدم /exec من صفحة النشر');
    }
    if (!settings.scriptUrl.includes('script.google.com/macros/s/')) {
      throw new Error('الرابط لا يبدو صحيحاً — يجب أن يبدأ بـ https://script.google.com/macros/s/');
    }

    const url = settings.scriptUrl
      + (settings.scriptUrl.includes('?') ? '&' : '?')
      + 'action=pull'
      + '&token=' + encodeURIComponent(settings.scriptToken || '')
      + '&_=' + Date.now();

    const result = await Sync.jsonpRequest(url);

    if (!result || result.ok !== true) {
      throw new Error((result && result.error) || 'استجابة غير صحيحة من الخادم');
    }
    return result.data;
  },

  jsonpRequest(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const callbackName = 'mishwar_jsonp_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      const scriptEl = document.createElement('script');
      let isDone = false;

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        try { delete window[callbackName]; } catch { window[callbackName] = undefined; }
        if (scriptEl.parentNode) scriptEl.parentNode.removeChild(scriptEl);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('انتهت مهلة الاتصال (15 ثانية)'));
      }, timeoutMs);

      window[callbackName] = (data) => {
        cleanup();
        resolve(data);
      };

      scriptEl.onerror = () => {
        cleanup();
        reject(new Error('فشل تحميل السكربت. تحقق من: (1) النشر كـ Anyone (2) استخدام /exec (3) الاتصال'));
      };

      scriptEl.src = url + '&callback=' + callbackName;
      document.head.appendChild(scriptEl);
    });
  },

  /* ============================================================
     🔑 المزامنة الجديدة: دفع → انتظار → سحب → تطبيق → إعادة حساب
     ============================================================ */
  async syncNow(silent = false) {
    if (!Sync.isOnline()) {
      if (!silent) toast('لا يوجد اتصال بالإنترنت', 'error');
      return false;
    }
    const settings = DB.getSettings();
    if (!settings.scriptUrl) {
      if (!silent) toast('لم يتم إعداد رابط المزامنة', 'error');
      return false;
    }

    try {
      if (!silent) toast('جارٍ المزامنة...');

      // 1️⃣ ادفع كل البيانات المحلية (بما فيها المعاملات الجديدة)
      await Sync.push();

      // 2️⃣ انتظر حتى يعالج الخادم ويعيد حساب الملخص
      await new Promise(r => setTimeout(r, 1500));

      // 3️⃣ اسحب الحالة النهائية من الخادم
      try {
        const remote = await Sync.pull();
        Sync.applyServerState(remote);
      } catch (e) {
        console.warn('فشل السحب — البيانات المحلية محدّثة أصلاً', e);
      }

      // 4️⃣ مسح سجل الحذف (تم)
      DB.saveDeleted({ accounts: [], transactions: [] });

      // 5️⃣ تحديث وقت المزامنة
      const s = DB.getSettings();
      s.lastSync = nowISO();
      DB.saveSettings(s);

      if (!silent) toast('تمت المزامنة بنجاح', 'success');
      UI.renderAll();
      return true;
    } catch (e) {
      console.error(e);
      if (!silent) toast('فشلت المزامنة: ' + e.message, 'error');
      return false;
    }
  },

  /* ============================================================
     🔑 تطبيق الحالة القادمة من الخادم
     - الخادم مرجعي للحسابات والمعاملات
     - نُبقي الحسابات والمعاملات المحلية فقط إن لم تكن موجودة على الخادم
     - في النهاية نُعيد حساب كل الأرصدة محلياً لضمان التناسق
     ============================================================ */
  applyServerState(remote) {
    if (!remote) return;

    // --- 1. دمج المعاملات (اتحاد) ---
    if (Array.isArray(remote[SHEETS.TRANSACTIONS])) {
      const serverTxs = remote[SHEETS.TRANSACTIONS];
      const serverIds = new Set(serverTxs.map(t => String(t['رقم_المعاملة'])));
      const localOnly = DB.getTransactions().filter(
        t => !serverIds.has(String(t['رقم_المعاملة']))
      );
      DB.saveTransactions([...serverTxs, ...localOnly]);
    }

    // --- 2. دمج الحسابات ---
    if (Array.isArray(remote[SHEETS.ACCOUNTS])) {
      const serverAccounts = remote[SHEETS.ACCOUNTS];
      const serverPersons = new Set(
        serverAccounts.map(a => String(a['اسم_الشخص']).trim())
      );
      const localOnly = DB.getAccounts().filter(
        a => !serverPersons.has(String(a['اسم_الشخص']).trim())
      );
      DB.saveAccounts([...serverAccounts, ...localOnly]);
    }

    // --- 3. 🔑 إعادة حساب جميع الأرصدة محلياً من المعاملات ---
    // (يضمن التناسق حتى لو كان الخادم متأخراً)
    DB.recalcAllAccounts();
  },

  /* اختبار الاتصال المفصّل */
  async testConnection() {
    const settings = DB.getSettings();

    if (!settings.scriptUrl) {
      return { ok: false, step: '1', msg: 'الرابط فارغ. الصق رابط Web App من صفحة النشر.' };
    }

    if (settings.scriptUrl.includes('/dev')) {
      return { ok: false, step: '2', msg: 'الرابط يحتوي /dev — استخدم رابط /exec من Deploy → Manage deployments.' };
    }

    if (!settings.scriptUrl.startsWith('https://script.google.com/macros/s/')) {
      return { ok: false, step: '2', msg: 'الرابط غير صحيح — يجب أن يبدأ بـ https://script.google.com/macros/s/' };
    }

    if (!navigator.onLine) {
      return { ok: false, step: '3', msg: 'لا يوجد اتصال بالإنترنت حالياً.' };
    }

    try {
      const url = settings.scriptUrl
        + (settings.scriptUrl.includes('?') ? '&' : '?')
        + 'action=ping'
        + '&token=' + encodeURIComponent(settings.scriptToken || '')
        + '&_=' + Date.now();

      const result = await Sync.jsonpRequest(url, 12000);

      if (result && result.ok) {
        return { ok: true, msg: 'الاتصال ناجح ✓ — الخادم يستجيب بشكل صحيح.' };
      }
      if (result && result.error === 'صلاحية مرفوضة') {
        return { ok: false, step: '4', msg: 'الرمز (Token) غير صحيح.' };
      }
      return { ok: false, step: '4', msg: 'استجابة غير متوقعة: ' + JSON.stringify(result) };
    } catch (e) {
      return { ok: false, step: '4', msg: e.message + '\n\nتحقق من: (1) النشر كـ Anyone (2) زيارة الرابط في المتصفح أول مرة.' };
    }
  }
};

/* ============================================================
   5. الرسوم البيانية
   ============================================================ */

let overviewChart = null;

const Charts = {
  render(person) {
    const canvas = $('#chart-overview');
    const fallback = $('#chart-fallback');
    if (typeof Chart === 'undefined') {
      canvas.hidden = true;
      fallback.hidden = false;
      fallback.textContent = 'الرسم البياني غير متوفر (Chart.js غير محمّل).';
      return;
    }
    canvas.hidden = false;
    fallback.hidden = true;

    const acc = DB.findAccount(person);
    const income  = acc ? Number(acc['إجمالي_الإيرادات'])  || 0 : 0;
    const expense = acc ? Number(acc['إجمالي_المصروفات']) || 0 : 0;

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#e2e8f0' : '#0f172a';

    if (overviewChart) overviewChart.destroy();

    overviewChart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['إيرادات', 'مصروفات'],
        datasets: [{
          data: [income, expense],
          backgroundColor: ['#16a34a', '#dc2626'],
          borderWidth: 0,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: textColor,
              font: { family: 'Segoe UI, Tahoma, sans-serif', size: 13, weight: '700' },
              padding: 16,
              usePointStyle: true,
              pointStyle: 'circle'
            }
          },
          tooltip: {
            rtl: true,
            textDirection: 'rtl',
            callbacks: {
              label: (ctx) => ' ' + ctx.label + ': ' + fmtMoney(ctx.parsed || 0)
            }
          }
        }
      }
    });
  }
};

/* ============================================================
   6. واجهة المستخدم
   ============================================================ */

const UI = {
  currentView: 'dashboard',
  currentPerson: '',

  switchView(name) {
    UI.currentView = name;
    $$('.view').forEach(v => v.classList.toggle('view--active', v.id === 'view-' + name));
    $$('.tabbar__btn').forEach(b => b.classList.toggle('is-active', b.dataset.view === name));

    const titles = {
      dashboard: 'الرئيسية',
      transactions: 'المعاملات',
      reports: 'التقارير',
      settings: 'الإعدادات'
    };
    $('#appbar-title').textContent = titles[name] || 'مصروفي';

    if (name === 'dashboard')    UI.renderDashboard();
    if (name === 'transactions') UI.renderTransactions();
    if (name === 'reports')      UI.renderReports();
    if (name === 'settings')     UI.renderSettings();
  },

  fillPersonSelects() {
    const accounts = DB.getAccounts();
    const names = accounts.map(a => a['اسم_الشخص']);

    const fill = (sel, includeAll) => {
      const current = sel.value;
      sel.innerHTML = includeAll ? '<option value="">الكل</option>' : '';
      names.forEach(n => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
      if (names.includes(current)) sel.value = current;
    };

    fill($('#person-select'), false);
    fill($('#tx-filter-person'), true);
    fill($('#report-person'), true);

    if (!UI.currentPerson && names.length) {
      UI.currentPerson = names[0];
      $('#person-select').value = UI.currentPerson;
    }
    if (names.length && !names.includes(UI.currentPerson)) {
      UI.currentPerson = names[0];
      $('#person-select').value = UI.currentPerson;
    }
  },

  renderDashboard() {
    UI.fillPersonSelects();
    const person = $('#person-select').value || UI.currentPerson;
    UI.currentPerson = person;

    const acc = DB.findAccount(person);
    const opening = acc ? Number(acc['المبلغ_الافتتاحي']) || 0 : 0;
    const income  = acc ? Number(acc['إجمالي_الإيرادات'])  || 0 : 0;
    const expense = acc ? Number(acc['إجمالي_المصروفات']) || 0 : 0;
    const balance = opening + income - expense;

    $('#stat-opening').textContent = fmtMoney(opening);
    $('#stat-income').textContent  = fmtMoney(income);
    $('#stat-expense').textContent = fmtMoney(expense);
    $('#stat-balance').textContent = fmtMoney(balance);

    Charts.render(person);

    if (!$('#tx-datetime').value) $('#tx-datetime').value = toLocalInputValue();
  },

  renderTransactions() {
    const person = $('#tx-filter-person').value;
    const type   = $('#tx-filter-type').value;
    const q      = ($('#tx-search').value || '').trim().toLowerCase();

    let txs = DB.getTransactions();
    if (person) txs = txs.filter(t => t['اسم_الشخص'] === person);
    if (type)   txs = txs.filter(t => t['نوع_المعاملة'] === type);
    if (q) {
      txs = txs.filter(t =>
        (t['ملاحظات'] || '').toLowerCase().includes(q) ||
        (t['اسم_الشخص'] || '').toLowerCase().includes(q)
      );
    }

    txs.sort((a, b) => new Date(b['التاريخ_والوقت']) - new Date(a['التاريخ_والوقت']));

    const list = $('#tx-list');
    if (!txs.length) {
      list.innerHTML = `
        <div class="tx-empty">
          <div class="tx-empty__icon">📭</div>
          <div>لا توجد معاملات مطابقة</div>
        </div>`;
      return;
    }

    list.innerHTML = txs.map(t => {
      const isIncome = t['نوع_المعاملة'] === 'إيراد';
      const cls = isIncome ? '' : 'tx-item--expense';
      const amountCls = isIncome ? 'pos' : 'neg';
      const sign = isIncome ? '+' : '−';
      const dt = new Date(t['التاريخ_والوقت']);
      const dateStr = dt.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
      const timeStr = dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

      return `
        <div class="tx-item ${cls}">
          <div class="tx-item__icon">${isIncome ? '↓' : '↑'}</div>
          <div class="tx-item__body">
            <div class="tx-item__title">${escapeHtml(t['ملاحظات'] || (isIncome ? 'إيراد' : 'مصروف'))}</div>
            <div class="tx-item__meta">
              <span>${escapeHtml(t['اسم_الشخص'])}</span>
              <span>·</span>
              <span>${dateStr} ${timeStr}</span>
            </div>
          </div>
          <div class="tx-item__amount ${amountCls}">${sign} ${fmtMoney(t['القيمة'])}</div>
          <div class="tx-item__actions">
            <button type="button" data-del="${t['رقم_المعاملة']}" title="حذف">🗑</button>
          </div>
        </div>`;
    }).join('');
  },

  reportPeriod: 'daily',

  getReportRange(period) {
    const now = new Date();
    let start, end = new Date(now);
    end.setHours(23, 59, 59, 999);

    if (period === 'daily') {
      start = new Date(now); start.setHours(0, 0, 0, 0);
    } else if (period === 'weekly') {
      const day = now.getDay();
      start = new Date(now);
      start.setDate(now.getDate() - day);
      start.setHours(0, 0, 0, 0);
    } else if (period === 'monthly') {
      start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    } else {
      start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    }
    return { start, end };
  },

  renderReports() {
    const person = $('#report-person').value;
    const period = UI.reportPeriod;
    const { start, end } = UI.getReportRange(period);

    const fmt = (d) => d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
    $('#report-range').textContent = `الفترة: من ${fmt(start)} إلى ${fmt(end)}`;

    let txs = DB.getTransactions().filter(t => {
      const d = new Date(t['التاريخ_والوقت']);
      return d >= start && d <= end;
    });
    if (person) txs = txs.filter(t => t['اسم_الشخص'] === person);

    const income  = txs.filter(t => t['نوع_المعاملة'] === 'إيراد')
                       .reduce((s, t) => s + Number(t['القيمة'] || 0), 0);
    const expense = txs.filter(t => t['نوع_المعاملة'] === 'مصروف')
                       .reduce((s, t) => s + Number(t['القيمة'] || 0), 0);
    const balance = income - expense;

    $('#report-summary').innerHTML = `
      <div class="report-summary__item">
        <span>عدد المعاملات</span>
        <strong>${txs.length}</strong>
      </div>
      <div class="report-summary__item">
        <span>صافي الفترة</span>
        <strong class="${balance >= 0 ? 'pos' : 'neg'}">${fmtMoney(balance)}</strong>
      </div>
      <div class="report-summary__item">
        <span>إجمالي الإيرادات</span>
        <strong class="pos">${fmtMoney(income)}</strong>
      </div>
      <div class="report-summary__item">
        <span>إجمالي المصروفات</span>
        <strong class="neg">${fmtMoney(expense)}</strong>
      </div>
    `;

    const container = $('#report-table');
    if (!txs.length) {
      container.innerHTML = `<div class="tx-empty" style="padding:20px 0;">لا توجد بيانات في هذه الفترة</div>`;
      return;
    }

    const sorted = txs.slice().sort((a, b) =>
      new Date(b['التاريخ_والوقت']) - new Date(a['التاريخ_والوقت']));

    container.innerHTML = `
      <div class="report-table__header">
        <span>التاريخ والوصف</span>
        <span>القيمة</span>
      </div>
      ${sorted.map(t => {
        const isIncome = t['نوع_المعاملة'] === 'إيراد';
        const dt = new Date(t['التاريخ_والوقت']);
        const dstr = dt.toLocaleDateString('ar-EG', { month: '2-digit', day: '2-digit' })
                   + ' ' + dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        return `
          <div class="report-table__row">
            <div>
              <div style="font-weight:700;">${escapeHtml(t['ملاحظات'] || (isIncome ? 'إيراد' : 'مصروف'))}</div>
              <div style="font-size:11px;color:var(--c-text-2);margin-top:2px;">
                ${escapeHtml(t['اسم_الشخص'])} · ${dstr}
              </div>
            </div>
            <strong class="${isIncome ? 'pos' : 'neg'}">
              ${isIncome ? '+' : '−'} ${fmtMoney(t['القيمة'])}
            </strong>
          </div>`;
      }).join('')}
    `;
  },

  renderSettings() {
    const s = DB.getSettings();
    $('#set-script-url').value = s.scriptUrl || '';
    $('#set-script-token').value = s.scriptToken || '';
    $('#set-auto-sync').checked = !!s.autoSync;

    const info = $('#sync-info');
    if (s.lastSync) {
      info.textContent = 'آخر مزامنة: ' + new Date(s.lastSync).toLocaleString('ar-EG');
    } else {
      info.textContent = 'لم تتم المزامنة بعد.';
    }

    const people = $('#people-list');
    const accounts = DB.getAccounts();
    if (!accounts.length) {
      people.innerHTML = `<p class="hint">لا يوجد أشخاص بعد.</p>`;
    } else {
      people.innerHTML = accounts.map(a => `
        <div class="list-item">
          <div class="list-item__body">
            <div class="list-item__title">${escapeHtml(a['اسم_الشخص'])}</div>
            <div class="list-item__meta">
              افتتاحي: ${fmtMoney(a['المبلغ_الافتتاحي'])} · رصيد: ${fmtMoney(a['المبلغ_المتبقي'])}
            </div>
          </div>
          <div class="list-item__actions">
            <button type="button" data-edit-acc="${a['رقم_الحساب']}" title="تعديل">✎</button>
            <button type="button" data-del-acc="${a['اسم_الشخص']}" title="حذف">🗑</button>
          </div>
        </div>`).join('');
    }
  },

  renderAll() {
    UI.fillPersonSelects();
    if (UI.currentView === 'dashboard')    UI.renderDashboard();
    if (UI.currentView === 'transactions') UI.renderTransactions();
    if (UI.currentView === 'reports')      UI.renderReports();
    if (UI.currentView === 'settings')     UI.renderSettings();
  }
};

/* ============================================================
   7. النافذة المنبثقة
   ============================================================ */

const Modal = {
  submitHandler: null,
  open({ title, bodyHtml, onSubmit, submitText = 'حفظ' }) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    $('#modal-submit').textContent = submitText;
    $('#modal-submit').className = 'btn btn--primary';
    Modal.submitHandler = onSubmit;
    $('#modal').hidden = false;
  },
  close() {
    $('#modal').hidden = true;
    $('#modal-form').reset();
    Modal.submitHandler = null;
    const btn = $('#modal-submit');
    btn.className = 'btn btn--primary';
    btn.textContent = 'حفظ';
  }
};

const Confirm = {
  show({ title, message, confirmText = 'تأكيد', danger = false, onConfirm }) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML =
      `<p style="text-align:center;line-height:1.9;color:var(--c-text-2);font-size:15px;">
        ${escapeHtml(message)}
      </p>`;

    const submitBtn = $('#modal-submit');
    submitBtn.textContent = confirmText;
    submitBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');

    Modal.submitHandler = () => {
      Modal.close();
      if (typeof onConfirm === 'function') onConfirm();
    };

    $('#modal').hidden = false;
  }
};

/* ============================================================
   8. معالجات الأحداث
   ============================================================ */

function bindEvents() {

  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    const s = DB.getSettings(); s.theme = next; DB.saveSettings(s);
    $('#btn-theme').textContent = next === 'dark' ? '☀️' : '🌙';
    if (UI.currentView === 'dashboard') Charts.render($('#person-select').value);
  });

  $('#btn-sync').addEventListener('click', () => Sync.syncNow(false));

  $$('.tabbar__btn').forEach(btn => {
    btn.addEventListener('click', () => UI.switchView(btn.dataset.view));
  });

  $('#person-select').addEventListener('change', (e) => {
    UI.currentPerson = e.target.value;
    UI.renderDashboard();
  });

  const openAddPerson = () => {
    Modal.open({
      title: 'إضافة شخص جديد',
      bodyHtml: `
        <label class="field">
          <span class="field__label">اسم الشخص</span>
          <input name="name" type="text" required maxlength="60" />
        </label>
        <label class="field">
          <span class="field__label">المبلغ الافتتاحي</span>
          <input name="opening" type="number" step="0.01" value="0" required />
        </label>`,
      onSubmit: (form) => {
        const name = form.name.value.trim();
        const opening = parseFloat(form.opening.value) || 0;
        if (!name) { toast('الرجاء إدخال اسم الشخص', 'error'); return; }
        if (DB.findAccount(name)) { toast('هذا الاسم موجود مسبقاً', 'error'); return; }
        DB.ensureAccount(name, opening);
        Modal.close();
        toast('تمت إضافة الشخص', 'success');
        UI.currentPerson = name;
        UI.renderAll();

        if (DB.getSettings().autoSync && navigator.onLine) Sync.syncNow(true);
      }
    });
  };
  $('#btn-add-person').addEventListener('click', openAddPerson);
  $('#btn-add-person-2').addEventListener('click', openAddPerson);

  $$('#tx-type-switch .segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#tx-type-switch .segmented__btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      $('#tx-type').value = btn.dataset.type;
    });
  });

  $('#tx-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const person = $('#person-select').value;
    if (!person) { toast('الرجاء إضافة شخص أولاً', 'error'); return; }

    const amount = parseFloat($('#tx-amount').value);
    if (!amount || amount <= 0) { toast('الرجاء إدخال قيمة صحيحة', 'error'); return; }

    const datetime = $('#tx-datetime').value || toLocalInputValue();
    const type = $('#tx-type').value;
    const notes = $('#tx-notes').value.trim();

    DB.addTransaction({
      person, type, amount,
      datetime: new Date(datetime).toISOString(),
      notes
    });

    $('#tx-amount').value = '';
    $('#tx-notes').value = '';
    $('#tx-datetime').value = toLocalInputValue();

    toast('تم حفظ المعاملة', 'success');
    UI.renderDashboard();

    if (DB.getSettings().autoSync && navigator.onLine) {
      Sync.syncNow(true);
    }
  });

  $('#tx-filter-person').addEventListener('change', UI.renderTransactions);
  $('#tx-filter-type').addEventListener('change', UI.renderTransactions);
  $('#tx-search').addEventListener('input', UI.renderTransactions);

  $('#tx-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    Confirm.show({
      title: 'حذف المعاملة',
      message: 'هل تريد حذف هذه المعاملة؟ لا يمكن التراجع.',
      confirmText: 'حذف',
      danger: true,
      onConfirm: () => {
        DB.deleteTransaction(btn.dataset.del);
        toast('تم الحذف', 'success');
        UI.renderTransactions();
        if (DB.getSettings().autoSync && navigator.onLine) Sync.syncNow(true);
      }
    });
  });

  $$('#report-period .segmented__btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('#report-period .segmented__btn').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      UI.reportPeriod = btn.dataset.period;
      UI.renderReports();
    });
  });
  $('#report-person').addEventListener('change', UI.renderReports);

  $('#btn-export-csv').addEventListener('click', () => {
    const person = $('#report-person').value;
    const { start, end } = UI.getReportRange(UI.reportPeriod);
    let txs = DB.getTransactions().filter(t => {
      const d = new Date(t['التاريخ_والوقت']);
      return d >= start && d <= end;
    });
    if (person) txs = txs.filter(t => t['اسم_الشخص'] === person);

    const header = COLUMNS.TRANSACTIONS.join(',');
    const rows = txs.map(t =>
      COLUMNS.TRANSACTIONS.map(c => `"${String(t[c] || '').replace(/"/g, '""')}"`).join(',')
    );
    const csv = '\uFEFF' + [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `تقرير_${UI.reportPeriod}_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('تم التصدير', 'success');
  });

  $('#set-script-url').addEventListener('change', (e) => {
    const s = DB.getSettings(); s.scriptUrl = e.target.value.trim(); DB.saveSettings(s);
  });
  $('#set-script-token').addEventListener('change', (e) => {
    const s = DB.getSettings(); s.scriptToken = e.target.value.trim(); DB.saveSettings(s);
  });
  $('#set-auto-sync').addEventListener('change', (e) => {
    const s = DB.getSettings(); s.autoSync = e.target.checked; DB.saveSettings(s);
  });
  $('#btn-sync-now').addEventListener('click', () => Sync.syncNow(false));

  $('#btn-sync-test').addEventListener('click', async () => {
    const info = $('#sync-info');
    info.textContent = 'جارٍ اختبار الاتصال...';
    info.style.color = 'var(--c-text-2)';

    const result = await Sync.testConnection();

    if (result.ok) {
      info.textContent = '✅ ' + result.msg;
      info.style.color = 'var(--c-success)';
      toast('الاتصال ناجح', 'success');
    } else {
      info.textContent = `❌ فشل في الخطوة ${result.step || '?'}: ${result.msg}`;
      info.style.color = 'var(--c-danger)';
      toast('فشل الاختبار', 'error');
    }
  });

  $('#people-list').addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-acc]');
    const delBtn  = e.target.closest('[data-del-acc]');

    if (editBtn) {
      const accounts = DB.getAccounts();
      const acc = accounts.find(a => a['رقم_الحساب'] === editBtn.dataset.editAcc);
      if (!acc) return;
      Modal.open({
        title: 'تعديل الحساب',
        bodyHtml: `
          <label class="field">
            <span class="field__label">اسم الشخص</span>
            <input name="name" type="text" required value="${escapeHtml(acc['اسم_الشخص'])}" />
          </label>
          <label class="field">
            <span class="field__label">المبلغ الافتتاحي</span>
            <input name="opening" type="number" step="0.01" value="${acc['المبلغ_الافتتاحي']}" required />
          </label>`,
        onSubmit: (form) => {
          const newName = form.name.value.trim();
          const opening = parseFloat(form.opening.value) || 0;
          if (!newName) return;
          if (newName !== acc['اسم_الشخص'] && DB.findAccount(newName)) {
            toast('الاسم موجود مسبقاً', 'error'); return;
          }
          const idx = accounts.findIndex(a => a['رقم_الحساب'] === acc['رقم_الحساب']);
          const oldName = accounts[idx]['اسم_الشخص'];
          accounts[idx]['اسم_الشخص'] = newName;
          accounts[idx]['المبلغ_الافتتاحي'] = opening;
          DB.saveAccounts(accounts);

          if (newName !== oldName) {
            const txs = DB.getTransactions();
            txs.forEach(t => { if (t['اسم_الشخص'] === oldName) t['اسم_الشخص'] = newName; });
            DB.saveTransactions(txs);
          }
          DB.recalcAccount(newName);
          Modal.close();
          toast('تم التعديل', 'success');
          UI.currentPerson = newName;
          UI.renderAll();

          if (DB.getSettings().autoSync && navigator.onLine) Sync.syncNow(true);
        }
      });
    }

    if (delBtn) {
      const name = delBtn.dataset.delAcc;
      Confirm.show({
        title: 'حذف الشخص',
        message: `سيتم حذف "${name}" وجميع معاملاته المرتبطة نهائياً.`,
        confirmText: 'حذف نهائي',
        danger: true,
        onConfirm: () => {
          DB.saveAccounts(DB.getAccounts().filter(a => a['اسم_الشخص'] !== name));
          DB.saveTransactions(DB.getTransactions().filter(t => t['اسم_الشخص'] !== name));
          UI.currentPerson = '';
          UI.renderAll();
          toast('تم الحذف', 'success');

          if (DB.getSettings().autoSync && navigator.onLine) Sync.syncNow(true);
        }
      });
    }
  });

  $('#btn-export-json').addEventListener('click', () => {
    const data = {
      accounts: DB.getAccounts(),
      transactions: DB.getTransactions(),
      settings: DB.getSettings(),
      exportedAt: nowISO()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `نسخة_احتياطية_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('تم حفظ النسخة', 'success');
  });

  $('#btn-import-json').addEventListener('click', () => $('#import-file').click());

  $('#import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        Confirm.show({
          title: 'استيراد البيانات',
          message: 'سيتم استبدال البيانات الحالية بالبيانات المستوردة. متابعة؟',
          confirmText: 'استيراد',
          danger: true,
          onConfirm: () => {
            if (Array.isArray(data.accounts))     DB.saveAccounts(data.accounts);
            if (Array.isArray(data.transactions)) DB.saveTransactions(data.transactions);
            if (data.settings) DB.saveSettings(Object.assign(DB.getSettings(), data.settings));
            DB.recalcAllAccounts();
            toast('تم الاستيراد بنجاح', 'success');
            UI.renderAll();
          }
        });
      } catch {
        toast('ملف غير صالح', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    Confirm.show({
      title: '⚠️ تحذير خطير',
      message: 'سيتم حذف جميع البيانات نهائياً: الأشخاص، المعاملات، والإعدادات. لا يمكن التراجع!',
      confirmText: 'متابعة',
      danger: true,
      onConfirm: () => {
        Confirm.show({
          title: 'تأكيد أخير',
          message: 'هل أنت متأكد تماماً؟ سيتم فقدان كل شيء.',
          confirmText: 'نعم، احذف الكل',
          danger: true,
          onConfirm: () => {
            Object.values(LS_KEYS).forEach(k => store.remove(k));
            toast('تم الحذف، جارٍ إعادة التشغيل...', 'success');
            setTimeout(() => location.reload(), 900);
          }
        });
      }
    });
  });

  $('#modal').addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) Modal.close();
  });
  $('#modal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (typeof Modal.submitHandler === 'function') {
      Modal.submitHandler(e.target.elements);
    }
  });

  window.addEventListener('online', () => {
    Sync.updateBadge();
    toast('تم الاتصال بالإنترنت', 'success');
    if (DB.getSettings().autoSync) Sync.syncNow(true);
  });
  window.addEventListener('offline', () => {
    Sync.updateBadge();
    toast('انقطع الاتصال — ستبقى بياناتك محفوظة محلياً');
  });
}

/* ============================================================
   9. الإقلاع
   ============================================================ */

(function init() {
  const s = DB.getSettings();
  document.documentElement.setAttribute('data-theme', s.theme || 'light');
  $('#btn-theme').textContent = (s.theme === 'dark') ? '☀️' : '🌙';

  // بيانات أولية
  if (!DB.getAccounts().length) {
    DB.ensureAccount('أحمد', 1000);
    DB.ensureAccount('سارة', 500);
  }

  // 🔑 إعادة حساب الأرصدة عند الإقلاع (ضمان التناسق)
  DB.recalcAllAccounts();

  bindEvents();

  $('#tx-datetime').value = toLocalInputValue();

  UI.switchView('dashboard');
  Sync.updateBadge();

  if (DB.getSettings().autoSync && navigator.onLine) {
    setTimeout(() => Sync.syncNow(true), 1200);
  }
})();