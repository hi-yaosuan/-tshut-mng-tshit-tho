import { LocalStore, DELETE, createFirebaseStore, newTripId } from './store.js';
import { sample } from './sample.js';
import { templates, templateDocs, CATEGORIES } from './templates.js';
import { firebaseConfig } from './firebase-config.js';

// 每次上版改這裡，並在 CHANGELOG.md 記錄；「我的」最下面會顯示，用來確認線上是不是最新版
const APP_VERSION = '1.1.0';

const SLOTS = ['早餐', '午餐', '晚餐', '宵夜'];
const SOURCE = { rent: '租借', own: '自有', buy: '要買' };
const WEEK = '日一二三四五六';

// 有 Firebase 設定就用雲端；網址 ?t=行程代碼 決定開哪一趟。
// 'demo' 是上雲端前存在這台裝置的行程，'sample' 是示範資料，兩個都只存在本機。
const CLOUD = !!firebaseConfig?.projectId;
let tripId = new URLSearchParams(location.search).get('t');
if (!CLOUD && !tripId) tripId = 'demo';
const isLocal = (id) => !CLOUD || id === 'demo' || id === 'sample';
const tripUrl = (id) => location.origin + location.pathname + (id ? '?t=' + id : '');
let store = null;

const S = { trip: {}, loaded: false, units: [], gear: [], meals: [], items: [], expenses: [] };
const ui = {
  mode: tripId ? 'trip' : 'home',
  tab: load('tab') || 'gear',
  me: load('me'),
  gearFilter: 'all',
  shopMode: 'buy',
  shopGroup: 'unit',
};

function load(k) { try { return localStorage.getItem('camp:' + tripId + ':' + k); } catch { return null; } }
function keep(k, v) { try { localStorage.setItem('camp:' + tripId + ':' + k, v ?? ''); } catch {} }

// ---------- 小工具 ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Math.round(n).toLocaleString('zh-TW');
const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const unit = (id) => S.units.find((u) => u.id === id);
const unitIdx = (id) => S.units.findIndex((u) => u.id === id);
const uName = (id) => unit(id)?.name ?? '未分配';
const uCls = (id) => (unitIdx(id) >= 0 ? 'u' + (unitIdx(id) % 6) : '');
const badge = (id) => (unit(id) ? `<span class="ubadge ${uCls(id)}">${esc(uName(id))}</span>` : '<span class="ubadge none">未分配</span>');
const heads = (ids) => (ids?.length ? ids : S.units.map((u) => u.id)).reduce((s, id) => s + (unit(id)?.size || 0), 0);

const parseDate = (s) => { const d = new Date((s || '') + 'T00:00'); return isNaN(d) ? null : d; };
function tripDays() {
  const a = parseDate(S.trip.startDate), b = parseDate(S.trip.endDate);
  if (a && b && b >= a) return Math.min(14, Math.round((b - a) / 864e5) + 1);
  return Math.max(1, +S.trip.days || 1);
}

function dayLabel(d) {
  const start = S.trip.startDate ? new Date(S.trip.startDate + 'T00:00') : null;
  if (!start || isNaN(start)) return `第 ${d} 天`;
  const dt = new Date(start); dt.setDate(dt.getDate() + d - 1);
  return `第 ${d} 天 · ${dt.getMonth() + 1}/${dt.getDate()}（${WEEK[dt.getDay()]}）`;
}
function shortDate(d) {
  const start = new Date(S.trip.startDate + 'T00:00');
  if (isNaN(start)) return '';
  const dt = new Date(start); dt.setDate(dt.getDate() + d - 1);
  return `${dt.getMonth() + 1}/${dt.getDate()}（${WEEK[dt.getDay()]}）`;
}

// 認領內容如果開頭是數字就算那個數量，否則算 1
const claimCount = (note) => { const m = String(note ?? '').trim().match(/^\d+/); return m ? +m[0] : 1; };
// 「每人一份」的裝備，需要數量跟著人數走
const gearNeed = (g) => (g.perPerson ? g.perPerson * heads() : g.need);
function gearStatus(g) {
  if (g.source === 'rent') return `<span class="tag rent">租 ${money((g.price || 0) * (g.qty || 1))}</span>`;
  if (g.source === 'buy') return g.payer ? '<span class="tag ok">有人買了</span>' : '<span class="tag short">待認領</span>';
  const have = Object.values(g.claims || {}).reduce((s, n) => s + claimCount(n), 0);
  const need = gearNeed(g);
  if (need == null || need === '') return have ? '<span class="tag ok">有人帶</span>' : '<span class="tag short">待認領</span>';
  return have >= need ? `<span class="tag ok">已齊 ${have}/${need}</span>` : `<span class="tag short">還缺 ${need - have}</span>`;
}
const gearShort = (g) => /short/.test(gearStatus(g));

const mealOf = (it) => S.meals.find((m) => m.id === it.mealId);
const itemUnit = (it) => it.unitId || mealOf(it)?.unitId || null;
const mealLabel = (m) => (m ? `${shortDate(m.day) || '第' + m.day + '天'}${m.slot}・${m.title}` : '共用備品');
const normName = (s) => String(s).replace(/[\s（(].*$/, '').replace(/[*xX×]\s*\d+$/, '').trim();
const mealSort = (a, b) => (a.day - b.day) || (SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));

// ---------- 分帳 ----------
function allExpenses() {
  const fromGear = S.gear
    .filter((g) => (g.source === 'rent' || g.source === 'buy') && g.price)
    .map((g) => ({ id: g.id, fromGear: true, title: g.name, amount: (g.price || 0) * (g.qty || 1), payer: g.payer, sharedBy: g.sharedBy || [] }));
  return [...fromGear, ...S.expenses];
}
function settle() {
  const net = Object.fromEntries(S.units.map((u) => [u.id, { paid: 0, share: 0 }]));
  let total = 0;
  for (const x of allExpenses()) {
    if (!x.amount || !unit(x.payer)) continue;
    total += +x.amount;
    net[x.payer].paid += +x.amount;
    const ids = x.sharedBy?.length ? x.sharedBy.filter(unit) : S.units.map((u) => u.id);
    const h = heads(ids);
    ids.forEach((id) => { net[id].share += x.amount * (unit(id).size || 0) / (h || 1); });
  }
  // 讓轉帳次數最少：最大債務人付給最大債權人
  const bal = S.units.map((u) => ({ id: u.id, v: net[u.id].paid - net[u.id].share }));
  const transfers = [];
  for (let guard = 0; guard < 50; guard++) {
    bal.sort((a, b) => a.v - b.v);
    const from = bal[0], to = bal[bal.length - 1];
    if (!from || Math.round(-from.v) < 1 || Math.round(to.v) < 1) break;
    const amt = Math.min(-from.v, to.v);
    transfers.push({ from: from.id, to: to.id, amount: amt });
    from.v += amt; to.v -= amt;
  }
  return { net, total, transfers };
}

// ---------- 畫面 ----------
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');

// 首頁、建立行程、載入中這類整頁畫面；同一頁不重畫，填到一半的表單才不會被資料更新洗掉
let page = null;
function showPage(name, html, mount) {
  document.body.classList.add('setup');
  $('#top').innerHTML = '';
  if (page === name) return;
  page = name;
  view.innerHTML = html;
  mount?.();
  scrollTo(0, 0);
}

// 從貼上的文字找出行程代碼：完整連結（…?t=代碼）或只有代碼
function parseTripCode(text) {
  const s = String(text || '').trim();
  const m = s.match(/[?&]t=([a-z0-9]+)/i) || s.match(/^([a-z0-9]{8,32})$/i);
  return m ? m[1].toLowerCase() : null;
}

function mountHome() {
  const form = $('#open-trip');
  if (!form) return;
  form.onsubmit = (e) => {
    e.preventDefault();
    const inp = form.elements.link;
    const code = parseTripCode(inp.value);
    if (!code) {
      inp.setCustomValidity('看起來不是行程連結，請貼上像 …?t=abc123 這樣的網址');
      inp.reportValidity();
      inp.oninput = () => inp.setCustomValidity('');
      return;
    }
    location.href = tripUrl(code);
  };
}

function render() {
  if (ui.mode === 'home') return ui.creating ? showPage('setup', viewSetup(), mountSetup) : showPage('home', viewHome(), mountHome);
  if (!S.loaded) return showPage('loading', `<div class="hero"><div class="hero-icon"><i class="ti ti-loader-2 spin"></i></div><p>載入中…</p><p class="hint">如果一直停在這裡，請檢查網路連線。</p></div>`);
  if (!S.trip.name) {
    return isLocal(tripId) ? showPage('setup', viewSetup(), mountSetup)
      : showPage('missing', `<div class="hero"><div class="hero-icon"><i class="ti ti-map-search"></i></div><h1>找不到這趟行程</h1>
          <p>連結可能不完整，或行程已經被刪除。</p></div><a class="btn primary block" href="${esc(tripUrl())}">回到首頁</a>`);
  }
  page = null;
  document.body.classList.remove('setup');
  renderHeader();
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ui.tab));
  $('#fab').hidden = ui.tab === 'me';
  view.innerHTML = { gear: viewGear, meals: viewMeals, shop: viewShop, pay: viewPay, me: viewMe }[ui.tab]();
}

function renderHeader() {
  const t = S.trip;
  const people = heads();
  const days = tripDays();
  const range = days > 1 ? `${shortDate(1)} – ${shortDate(days)}` : shortDate(1);
  const info = [t.location, range, people ? people + ' 人' : ''].filter(Boolean).map(esc).join(' · ');
  $('#top').innerHTML = `
    <button class="trip" data-act="edit-trip">
      <div class="trip-name">${esc(t.name)}</div>
      <div class="trip-date">${info}</div>
    </button>
    ${isLocal(tripId) ? '' : '<button class="icon-btn" data-act="share" aria-label="分享行程連結"><i class="ti ti-share"></i></button>'}
    <button class="who ${unit(ui.me) ? uCls(ui.me) : 'unset'}" data-act="pick-me">
      ${unit(ui.me) ? `我是 <span class="u" style="color:var(--uc)">${esc(uName(ui.me))}</span>` : '選擇你是誰'} <i class="ti ti-chevron-down"></i>
    </button>`;
}

function claimChips(g) {
  const chips = S.units.filter((u) => g.claims?.[u.id] != null).map((u) =>
    `<button class="claim ${uCls(u.id)}" data-act="claim" data-id="${g.id}" data-unit="${u.id}"><b>${esc(u.name)}</b> ${esc(g.claims[u.id])}</button>`).join('');
  const mine = g.claims?.[ui.me] != null;
  return `<div class="claims">${chips}${mine ? '' : `<button class="claim-add" data-act="claim" data-id="${g.id}" data-unit="${ui.me || ''}"><i class="ti ti-plus"></i> 我帶</button>`}</div>`;
}

function gearCard(g) {
  let sub = '';
  if (g.source === 'rent') {
    const shared = g.sharedBy?.length && g.sharedBy.length < S.units.length ? g.sharedBy.map(uName).join('、') + ' 分攤' : '大家分攤';
    sub = [g.model, g.shop, `${money(g.price || 0)} × ${g.qty || 1}`, g.payer ? uName(g.payer) + ' 付' : '未填誰付', shared].filter(Boolean).map(esc).join(' · ');
  } else if (g.source === 'own' && g.perPerson) {
    sub = `每人 ${g.perPerson} 個`;
  } else if (g.source === 'buy') {
    sub = [g.price ? `${money(g.price)} × ${g.qty || 1}` : '', g.payer ? uName(g.payer) + ' 買' : ''].filter(Boolean).map(esc).join(' · ');
  }
  return `<div class="card tap" data-act="edit-gear" data-id="${g.id}">
    <div class="row"><div class="grow title">${esc(g.name)}</div>${gearStatus(g)}</div>
    ${sub ? `<div class="sub">${sub}</div>` : ''}
    ${g.note ? `<div class="note">${esc(g.note)}</div>` : ''}
    ${g.source === 'own' ? claimChips(g) : ''}
  </div>`;
}

function viewGear() {
  const f = ui.gearFilter;
  const list = S.gear.filter((g) => f === 'all' || (f === 'short' ? gearShort(g) && g.source !== 'rent' : f === 'mine' ? g.claims?.[ui.me] != null || g.payer === ui.me : g.source === f));
  const shortN = S.gear.filter((g) => gearShort(g) && g.source !== 'rent').length;
  const chips = [['all', '全部'], ['short', `還缺${shortN ? ' ' + shortN : ''}`], ['mine', '我帶的'], ['rent', '租借'], ['own', '自有'], ['buy', '要買']]
    .map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-act="gear-filter" data-v="${k}">${l}</button>`).join('');
  let html = `<div class="chips">${chips}</div>`;
  // 自有裝備依類別分組；租借、要買各一組
  const own = list.filter((x) => x.source === 'own');
  const cats = [...CATEGORIES, ...new Set(own.map((x) => x.cat).filter((c) => c && !CATEGORIES.includes(c)))];
  const groups = [
    ...cats.map((c) => [c, own.filter((x) => x.cat === c), 'own', c]),
    [cats.some((c) => own.some((x) => x.cat === c)) ? '未分類' : '自有裝備', own.filter((x) => !x.cat), 'own', ''],
    ['要買', list.filter((x) => x.source === 'buy'), 'buy', ''],
    ['租借', list.filter((x) => x.source === 'rent'), 'rent', ''],
  ];
  for (const [label, g, src, cat] of groups) {
    if (!g.length) continue;
    g.sort((a, b) => gearShort(b) - gearShort(a));
    const shortN = g.filter((x) => gearShort(x) && x.source !== 'rent').length;
    const extra = label === '租借' ? `共 ${money(g.reduce((s, x) => s + (x.price || 0) * (x.qty || 1), 0))}`
      : shortN ? `<span class="neg">缺 ${shortN}</span> / ${g.length} 項` : `${g.length} 項`;
    html += `<div class="section-title"><span>${esc(label)}</span><small>${extra}</small></div>` + g.map(gearCard).join('') +
      (f === 'all' || f === src ? `<button class="add-line add-gear" data-act="new-gear" data-src="${src}" data-cat="${esc(cat)}"><i class="ti ti-plus"></i> 新增${src === 'own' ? `到${esc(label)}` : label === '租借' ? '租借裝備' : '要買的裝備'}</button>` : '');
  }
  // 沒有任何要買／租借的裝備時，也給一個入口
  if (S.gear.length && f === 'all') {
    const missing = [['buy', '要買的裝備'], ['rent', '租借裝備']].filter(([s]) => !S.gear.some((x) => x.source === s));
    if (missing.length) html += `<div class="add-row">${missing.map(([s, l]) => `<button class="add-line" data-act="new-gear" data-src="${s}" data-cat=""><i class="ti ti-plus"></i> 新增${l}</button>`).join('')}</div>`;
  }
  if (!list.length) {
    html += !S.gear.length
      ? `<div class="card" style="text-align:center;padding:24px 16px"><div class="title">還沒有裝備</div>
          <div class="sub" style="margin:4px 0 12px">可以套用範本，或自己一樣一樣加。</div>
          <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
            <button class="btn small" data-act="apply-template"><i class="ti ti-list-check"></i> 套用露營基本清單</button>
            <button class="btn small" data-act="new-gear" data-src="own" data-cat=""><i class="ti ti-plus"></i> 新增裝備</button>
          </div></div>`
      : `<div class="empty">${f === 'short' ? '裝備都齊了。' : '沒有符合的裝備。'}</div>`;
  }
  return html;
}

function viewMeals() {
  // 日期改短時，超出的那幾天如果已經排了餐，還是要顯示出來
  const days = Math.max(tripDays(), ...S.meals.map((m) => m.day || 1));
  let html = '';
  for (let d = 1; d <= days; d++) {
    html += `<div class="day"><div class="day-head">${dayLabel(d)}</div><div class="card">`;
    for (const slot of SLOTS) {
      const ms = S.meals.filter((m) => m.day === d && m.slot === slot);
      html += `<div class="slot"><div class="slot-name">${slot}</div><div class="slot-body">`;
      for (const m of ms) {
        const its = S.items.filter((i) => i.mealId === m.id);
        const buy = its.filter((i) => i.mode === 'buy').length, bring = its.length - buy;
        html += `<div class="meal" data-act="edit-meal" data-id="${m.id}">
          <div class="row"><div class="grow title">${esc(m.title || '（還沒決定菜色）')}</div>${badge(m.unitId)}</div>
          ${m.note ? `<div class="note">${esc(m.note)}</div>` : ''}
          ${its.length ? `<div class="counts">${buy ? `<span><i class="ti ti-shopping-cart"></i> 買 ${buy}</span>` : ''}${bring ? `<span><i class="ti ti-home"></i> 帶 ${bring}</span>` : ''}</div>` : ''}
        </div>`;
      }
      html += `<button class="add-line" data-act="new-meal" data-day="${d}" data-slot="${slot}"><i class="ti ti-plus"></i> ${ms.length ? '再加一道' : '安排'}</button>`;
      html += '</div></div>';
    }
    html += '</div></div>';
  }
  return html;
}

function itemRow(it) {
  const m = mealOf(it);
  return `<div class="item ${it.done ? 'done' : ''}">
    <button class="check" data-act="toggle-item" data-id="${it.id}" aria-label="勾選"><i class="ti ti-check"></i></button>
    <div class="grow" data-act="edit-item" data-id="${it.id}" style="cursor:pointer">
      <div class="title">${esc(it.name)}${it.qty ? `<span class="qty">${esc(it.qty)}</span>` : ''}</div>
      <div class="sub">${esc(mealLabel(m))}${ui.shopGroup === 'meal' ? ' · ' + esc(uName(itemUnit(it))) : ''}</div>
    </div>
  </div>`;
}

function dupNames() {
  const map = {};
  for (const it of S.items) (map[normName(it.name)] ??= []).push(it);
  return Object.entries(map).filter(([, v]) => v.length > 1);
}

function viewShop() {
  const mode = ui.shopMode;
  const list = S.items.filter((i) => i.mode === mode);
  const done = list.filter((i) => i.done).length;
  const nBuy = S.items.filter((i) => i.mode === 'buy').length;
  let html = `<div class="seg">
      <button class="${mode === 'buy' ? 'on' : ''}" data-act="shop-mode" data-v="buy">要買 ${nBuy}</button>
      <button class="${mode === 'bring' ? 'on' : ''}" data-act="shop-mode" data-v="bring">家裡帶 ${S.items.length - nBuy}</button>
    </div>
    <div class="progress"><div style="width:${list.length ? done / list.length * 100 : 0}%"></div></div>
    <div class="sub">${mode === 'buy' ? '已買' : '已打包'} ${done} / ${list.length}</div>`;

  const dups = dupNames();
  if (dups.length) {
    html += `<div class="callout"><i class="ti ti-alert-triangle"></i> 可能重複：${dups.map(([n, v]) =>
      `<b>${esc(n)}</b>（${v.map((i) => (i.mode === 'bring' ? uName(itemUnit(i)) + '帶' : mealOf(i)?.title || '共用')).map(esc).join('、')}）`).join('，')}</div>`;
  }

  html += `<div class="chips" style="margin-top:8px">
    <button class="${ui.shopGroup === 'unit' ? 'on' : ''}" data-act="shop-group" data-v="unit">依負責人</button>
    <button class="${ui.shopGroup === 'meal' ? 'on' : ''}" data-act="shop-group" data-v="meal">依餐</button></div>`;

  const groups = [];
  if (ui.shopGroup === 'unit') {
    for (const u of [...S.units, { id: null, name: '未分配' }]) {
      const g = list.filter((i) => (itemUnit(i) || null) === u.id);
      if (g.length) groups.push([u.id ? badge(u.id) : badge(null), g]);
    }
    if (unit(ui.me)) groups.sort((a, b) => (b[1][0] && itemUnit(b[1][0]) === ui.me) - (a[1][0] && itemUnit(a[1][0]) === ui.me));
  } else {
    for (const m of [...S.meals].sort(mealSort)) {
      const g = list.filter((i) => i.mealId === m.id);
      if (g.length) groups.push([`${esc(mealLabel(m))} ${badge(m.unitId)}`, g]);
    }
    const common = list.filter((i) => !mealOf(i));
    if (common.length) groups.push(['共用備品', common]);
  }
  for (const [title, g] of groups) {
    const left = g.filter((i) => !i.done).length;
    html += `<div class="section-title"><span>${title}</span><small>${left ? `剩 ${left}` : '完成'}</small></div>
      <div class="card">${g.sort((a, b) => a.done - b.done).map(itemRow).join('')}</div>`;
  }
  if (!list.length) html += `<div class="empty">在「餐食」裡打開某一餐就能加食材，或按 ＋ 加共用備品。</div>`;
  return html;
}

function viewPay() {
  const { net, total, transfers } = settle();
  const people = heads();
  let html = `<div class="stats">
    <div class="stat"><div class="sub">總花費</div><div class="num money">${money(total)}</div></div>
    <div class="stat"><div class="sub">每人平均（${people} 人）</div><div class="num money">${money(people ? total / people : 0)}</div></div>
  </div>`;
  html += `<div class="section-title"><span>要轉帳</span><small>依人頭分攤</small></div><div class="card">`;
  html += transfers.length ? transfers.map((t) => `<div class="transfer">${badge(t.from)}<i class="ti ti-arrow-right"></i>${badge(t.to)}<div class="grow"></div><b class="money">${money(t.amount)}</b></div>`).join('')
    : '<div class="empty">目前不用轉帳。</div>';
  html += '</div>';

  html += `<div class="section-title"><span>各單位</span><small>先付 − 應分攤</small></div><div class="card">`;
  html += S.units.map((u) => {
    const n = net[u.id], d = n.paid - n.share;
    return `<div class="transfer">${badge(u.id)}<span class="sub">${u.size} 人</span><div class="grow sub money">先付 ${money(n.paid)} · 分攤 ${money(n.share)}</div>
      <b class="money ${Math.round(d) > 0 ? 'pos' : Math.round(d) < 0 ? 'neg' : ''}">${Math.round(d) > 0 ? '應收 ' + money(d) : Math.round(d) < 0 ? '應付 ' + money(-d) : '已平'}</b></div>`;
  }).join('') + '</div>';

  html += `<div class="section-title"><span>費用明細</span><small>${allExpenses().length} 筆</small></div>`;
  html += allExpenses().map((x) => {
    const ids = x.sharedBy?.length ? x.sharedBy : null;
    return `<div class="card tap ${!unit(x.payer) ? 'warn' : ''}" data-act="${x.fromGear ? 'edit-gear' : 'edit-expense'}" data-id="${x.id}">
      <div class="row"><div class="grow title">${esc(x.title)}</div><b class="money">${money(x.amount || 0)}</b></div>
      <div class="sub">${unit(x.payer) ? esc(uName(x.payer)) + ' 付' : '<span class="neg">還沒填誰付的</span>'} · ${ids && ids.length < S.units.length ? esc(ids.map(uName).join('、')) + ' 分攤' : '大家分攤'}${x.fromGear ? ' · <span class="tag rent">裝備</span>' : ''}</div>
    </div>`;
  }).join('');
  return html;
}

function viewMe() {
  const me = ui.me;
  let html = `<div class="section-title"><span>我是</span></div><div class="me-pick">${S.units.map((u) =>
    `<button class="${uCls(u.id)} ${u.id === me ? 'on' : ''}" data-act="set-me" data-id="${u.id}">${esc(u.name)}</button>`).join('')}</div>`;
  if (unit(me)) {
    const gear = S.gear.filter((g) => g.claims?.[me] != null);
    const pay = S.gear.filter((g) => g.source !== 'own' && g.payer === me);
    const meals = S.meals.filter((m) => m.unitId === me).sort(mealSort);
    const buy = S.items.filter((i) => i.mode === 'buy' && itemUnit(i) === me);
    const bring = S.items.filter((i) => i.mode === 'bring' && itemUnit(i) === me);
    const { net, transfers } = settle();
    const d = net[me].paid - net[me].share;

    html += `<div class="section-title"><span>我要帶的裝備</span><small>${gear.length} 項</small></div><div class="card">`;
    html += gear.length ? gear.map((g) => `<div class="transfer tap" data-act="claim" data-id="${g.id}" data-unit="${me}" style="cursor:pointer"><div class="grow">${esc(g.name)}</div><span class="sub">${esc(g.claims[me])}</span></div>`).join('') : '<div class="empty">還沒認領裝備。</div>';
    html += '</div>';
    if (pay.length) {
      html += `<div class="section-title"><span>我負責租／買</span></div><div class="card">` +
        pay.map((g) => `<div class="transfer tap" data-act="edit-gear" data-id="${g.id}" style="cursor:pointer"><div class="grow">${esc(g.name)}</div><span class="tag ${g.source}">${SOURCE[g.source]}</span></div>`).join('') + '</div>';
    }
    html += `<div class="section-title"><span>我負責的餐</span></div><div class="card">`;
    html += meals.length ? meals.map((m) => `<div class="transfer tap" data-act="edit-meal" data-id="${m.id}" style="cursor:pointer"><span class="sub">${esc(shortDate(m.day))}${m.slot}</span><div class="grow">${esc(m.title)}</div></div>`).join('') : '<div class="empty">還沒有負責的餐。</div>';
    html += '</div>';
    html += `<div class="section-title"><span>我要買的</span><small>${buy.filter((i) => !i.done).length} 樣沒買</small></div><div class="card">${buy.length ? buy.map(itemRow).join('') : '<div class="empty">沒有要買的東西。</div>'}</div>`;
    html += `<div class="section-title"><span>我從家裡帶</span></div><div class="card">${bring.length ? bring.map(itemRow).join('') : '<div class="empty">沒有要從家裡帶的。</div>'}</div>`;
    const mine = transfers.filter((t) => t.from === me || t.to === me);
    html += `<div class="section-title"><span>我的帳</span><b class="money ${Math.round(d) > 0 ? 'pos' : Math.round(d) < 0 ? 'neg' : ''}">${Math.round(d) > 0 ? '應收 ' + money(d) : Math.round(d) < 0 ? '應付 ' + money(-d) : '已平'}</b></div><div class="card">`;
    html += mine.length ? mine.map((t) => `<div class="transfer">${badge(t.from)}<i class="ti ti-arrow-right"></i>${badge(t.to)}<div class="grow"></div><b class="money">${money(t.amount)}</b></div>`).join('') : '<div class="empty">不用轉帳。</div>';
    html += '</div>';
  } else {
    html += '<div class="empty">選好你是誰，這裡就會列出你要帶、要買、要付的東西。</div>';
  }

  const t = S.trip, days = tripDays();
  html += `<div class="section-title"><span>行程資訊</span></div>
    <div class="card tap" data-act="edit-trip">
      <div class="row"><div class="grow title">${esc(t.name)}</div><i class="ti ti-pencil" style="color:var(--muted)"></i></div>
      <div class="info-row"><i class="ti ti-map-pin"></i>${esc(t.location || '還沒填地點')}</div>
      <div class="info-row"><i class="ti ti-calendar"></i>${esc(days > 1 ? `${shortDate(1)} – ${shortDate(days)}（${days} 天）` : shortDate(1) || '還沒填日期')}</div>
    </div>
    <div class="section-title"><span>參與單位</span><small>${heads()} 人</small></div>
    <div class="card">
      ${S.units.map((u) => `<div class="transfer tap" data-act="edit-unit" data-id="${u.id}" style="cursor:pointer">${badge(u.id)}<div class="grow sub">${u.size} 人</div><i class="ti ti-chevron-right"></i></div>`).join('') || '<div class="empty">還沒有參與單位。</div>'}
      <button class="add-line" style="width:100%;margin-top:6px" data-act="new-unit"><i class="ti ti-plus"></i> 新增單位</button>
    </div>
    ${isLocal(tripId) ? '' : `<div class="section-title"><span>分享</span></div>
    <div class="card tap" data-act="share"><div class="row"><i class="ti ti-share"></i><div class="grow">分享行程連結<div class="sub">拿到連結的人都能一起編輯 · 行程代碼 <span class="trip-code">${esc(tripId)}</span></div></div><i class="ti ti-chevron-right"></i></div></div>`}
    <div class="section-title"><span>資料</span></div>
    ${CLOUD ? `<a class="card tap trip-link" href="${esc(tripUrl())}"><div class="row"><i class="ti ti-list"></i><div class="grow">所有行程／建立新行程</div><i class="ti ti-chevron-right"></i></div></a>` : ''}
    <div class="card tap" data-act="restart"><div class="row"><i class="ti ti-trash neg"></i><div class="grow neg">${isLocal(tripId) ? '清空資料，重新開始' : '刪除這趟行程'}</div></div></div>
    <p class="version">露營分工 v${APP_VERSION}</p>`;
  return html;
}

// ---------- 第一次使用：建立行程 ----------
function viewSetup() {
  const t = templates[0];
  const counts = CATEGORIES.map((c) => [c, t.gear.filter(([cat]) => cat === c).length]).filter(([, n]) => n);
  return `<form id="setup" class="setup" novalidate>
    <div class="hero">
      <div class="hero-icon"><i class="ti ti-tent"></i></div>
      <h1>開始規劃一趟露營</h1>
      <p>先填基本資訊，之後再分配裝備、餐食和分帳。</p>
    </div>
    <div class="card">${tripFields({})}</div>

    <div class="section-title"><span>參與單位</span><small>一個人或一個家庭都算一個單位</small></div>
    <div class="card">
      <div class="unit-head"><span>名稱</span><span>人數</span><span></span></div>
      <div id="setup-units"></div>
      <button type="button" class="add-line" style="width:100%;margin-top:8px" id="setup-add"><i class="ti ti-plus"></i> 再加一個單位</button>
    </div>

    <div class="section-title"><span>從哪裡開始</span></div>
    <label class="choice">
      <input type="radio" name="start" value="${t.id}" checked>
      <div class="choice-body">
        <div class="row"><div class="grow title">${esc(t.name)}</div><span class="tag ok">推薦</span></div>
        <div class="sub">${esc(t.desc)}</div>
        <div class="choice-cats">${counts.map(([c, n]) => `<span class="tag plain">${esc(c)} ${n}</span>`).join('')}</div>
      </div>
    </label>
    <label class="choice">
      <input type="radio" name="start" value="blank">
      <div class="choice-body"><div class="title">空白開始</div><div class="sub">什麼都不放，自己一樣一樣加。</div></div>
    </label>

    <button type="submit" class="btn primary block">建立行程</button>
    ${ui.mode === 'home' ? '<button type="button" class="link-btn" data-act="home-back">返回</button>' : ''}
    <button type="button" class="link-btn" data-act="demo">先看看示範（上次武陵農場的資料）</button>
  </form>`;
}

// ---------- 首頁（雲端版才有）----------
function recentTrips() {
  try { return JSON.parse(localStorage.getItem('camp:recent') || '[]'); } catch { return []; }
}
function saveRecent(entry) {
  const list = recentTrips().filter((r) => r.id !== entry.id);
  list.unshift(entry);
  try { localStorage.setItem('camp:recent', JSON.stringify(list.slice(0, 30))); } catch {}
}
function forgetRecent(id) {
  try { localStorage.setItem('camp:recent', JSON.stringify(recentTrips().filter((r) => r.id !== id))); } catch {}
}
// 上雲端之前存在這台裝置的行程，可以一鍵上傳
function localTrip() {
  try {
    if (localStorage.getItem('camp:demo:uploaded')) return null;
    const d = JSON.parse(localStorage.getItem('camp:demo') || 'null');
    return d?.meta?.trip?.name ? d : null;
  } catch { return null; }
}

function viewHome() {
  const list = recentTrips().sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
  const local = localTrip();
  const range = (r) => {
    const fmt = (s) => { const d = parseDate(s); return d ? `${d.getMonth() + 1}/${d.getDate()}` : ''; };
    return [fmt(r.startDate), r.endDate !== r.startDate ? fmt(r.endDate) : ''].filter(Boolean).join(' – ');
  };
  return `<div class="hero">
      <div class="hero-icon"><i class="ti ti-tent"></i></div>
      <h1>露營分工</h1>
      <p>裝備、餐食、採買、分帳，一個連結大家一起編輯。</p>
    </div>
    ${local ? `<div class="card upload-card">
      <div class="title"><i class="ti ti-device-mobile"></i> 這台裝置上的行程</div>
      <div class="sub" style="margin:2px 0 10px">「${esc(local.meta.trip.name)}」只存在這台裝置，其他人看不到。上傳到雲端後就能分享。</div>
      <div class="row" style="gap:8px"><button class="btn small primary" data-act="upload-local"><i class="ti ti-cloud-upload"></i> 上傳並分享</button>
      <a class="btn small" href="${esc(tripUrl('demo'))}">先打開看看</a></div>
    </div>` : ''}
    ${list.length ? `<div class="section-title"><span>我的行程</span><small>${list.length} 趟</small></div>` +
      list.map((r) => `<a class="card tap trip-link" href="${esc(tripUrl(r.id))}">
        <div class="row"><div class="grow"><div class="title">${esc(r.name)}</div>
        <div class="sub">${esc([r.location, range(r)].filter(Boolean).join(' · '))}</div></div><i class="ti ti-chevron-right"></i></div></a>`).join('') : ''}
    <button class="btn primary block" data-act="home-new"><i class="ti ti-plus"></i> 建立新行程</button>

    <div class="section-title"><span>打開別人分享的行程</span></div>
    <form class="card open-trip" id="open-trip" novalidate>
      <div class="row" style="gap:8px">
        <input name="link" placeholder="貼上行程連結或代碼" autocomplete="off" aria-label="行程連結或代碼">
        <button type="submit" class="btn small">打開</button>
      </div>
      <div class="hint">「我的行程」只會列出在這台裝置上打開過的行程。換手機或換瀏覽器時，貼上連結打開一次，之後就會出現在清單裡。</div>
    </form>
    <button type="button" class="link-btn" data-act="demo">先看看示範（上次武陵農場的資料）</button>
    <p class="version">v${APP_VERSION}</p>`;
}

// 把 LocalStore 格式的資料（{ 集合: { id: 資料 } }）寫進某個 store；meta 最後寫
async function writeAll(st, data) {
  for (const [col, docs] of Object.entries(data)) {
    if (col === 'meta') continue;
    for (const [id, d] of Object.entries(docs || {})) await st.add(col, d, id);
  }
  for (const [id, d] of Object.entries(data.meta || {})) await st.add('meta', d, id);
}

async function openNewCloudTrip(data, me) {
  const id = newTripId();
  const st = await createFirebaseStore(firebaseConfig, id);
  await writeAll(st, data);
  await st.flush();
  if (me) try { localStorage.setItem(`camp:${id}:me`, me); } catch {}
  saveRecent({ id, name: data.meta.trip.name, location: data.meta.trip.location || '', startDate: data.meta.trip.startDate, endDate: data.meta.trip.endDate });
  location.href = tripUrl(id) + '&new=1';
}

async function uploadLocal(btn) {
  const d = localTrip();
  if (!d) return;
  btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> 上傳中…';
  try { localStorage.setItem('camp:demo:uploaded', '1'); } catch {}
  let me = null;
  try { me = localStorage.getItem('camp:demo:me'); } catch {}
  await openNewCloudTrip(d, me);
}

function mountSetup() {
  const form = $('#setup');
  const box = $('#setup-units', form);
  const addRow = (name = '', size = 1) => {
    const row = document.createElement('div');
    row.className = 'unit-row';
    row.innerHTML = `<input name="uname" value="${esc(name)}" placeholder="${box.children.length ? '姚藍' : 'Erin'}" aria-label="單位名稱">
      <input name="usize" type="number" min="1" value="${size}" inputmode="numeric" aria-label="人數">
      <button type="button" class="icon-btn" aria-label="移除"><i class="ti ti-x"></i></button>`;
    row.querySelector('button').onclick = () => { if (box.children.length > 1) row.remove(); else row.querySelector('input').value = ''; };
    box.appendChild(row);
    return row;
  };
  addRow(); addRow();
  $('#setup-add', form).onclick = () => addRow().querySelector('input').focus();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const trip = readTrip(form);
    if (!trip) return;
    const units = [...box.children].map((r) => ({ name: r.children[0].value.trim(), size: Math.max(1, +r.children[1].value || 1) })).filter((u) => u.name);
    if (!units.length) { const first = box.querySelector('input'); first.setCustomValidity('至少填一個單位'); first.reportValidity(); first.oninput = () => first.setCustomValidity(''); return; }
    const start = form.querySelector('input[name="start"]:checked').value;
    const tpl = templates.find((x) => x.id === start);

    // 先組好整趟行程的資料，再一次寫進去
    const rid = () => Math.random().toString(36).slice(2, 10);
    const data = { meta: { trip }, units: {}, gear: {}, items: {} };
    units.forEach((u, i) => { data.units['u' + rid()] = { ...u, order: i }; });
    if (tpl) {
      const docs = templateDocs(tpl);
      docs.gear.forEach((g) => { data.gear['g' + rid()] = g; });
      docs.items.forEach((it) => { data.items['i' + rid()] = it; });
    }
    keep('tab', 'gear');

    if (ui.mode === 'home') {
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin"></i> 建立中…';
      return openNewCloudTrip(data);
    }
    ui.tab = 'gear';
    await store.reset();
    await writeAll(store, data);
    pickMe();
  };
}

async function addTemplate(tpl) {
  const docs = templateDocs(tpl);
  for (const g of docs.gear) await store.add('gear', g);
  const have = new Set(S.items.map((i) => i.name));
  for (const it of docs.items) if (!have.has(it.name)) await store.add('items', it);
}

async function shareTrip() {
  const url = tripUrl(tripId);
  const title = `${S.trip.name}｜露營分工`;
  if (navigator.share) {
    try { await navigator.share({ title, text: `一起來分配「${S.trip.name}」要帶的東西`, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('已複製行程連結，貼到群組就好'); return; } catch {}
  openSheet({
    title: '分享行程',
    body: field('行程連結', `<input value="${esc(url)}" readonly onfocus="this.select()">`, '複製這個連結貼到群組，拿到連結的人都能編輯。'),
    saveText: '完成',
    onSave: () => {},
  });
}

// ---------- 底部表單 ----------
const sheet = $('#sheet');
let sheetCtx = null;

// 不用瀏覽器內建的 confirm/alert：有些內嵌瀏覽器會直接當成「取消」，手機上也不好看。
// 刪除改成立刻刪、跳出可以復原的提示。
function openSheet({ title, body, onSave, onDelete, saveText = '儲存', deleteText = '刪除', destructive = false, onMount }) {
  sheet.innerHTML = `<form method="dialog" novalidate>
    <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="關閉"><i class="ti ti-x"></i></button></div>
    <div class="sheet-body"><div class="form-err" role="alert" hidden></div>${body}</div>
    <div class="sheet-foot">
      ${onDelete ? `<button type="button" class="btn danger" data-delete><i class="ti ti-trash"></i> ${esc(deleteText)}</button>` : ''}
      <button type="submit" class="btn primary ${destructive ? 'destructive' : ''}">${esc(saveText)}</button>
    </div></form>`;
  const form = $('form', sheet);
  form.oninput = () => { $('.form-err', form).hidden = true; };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const ok = await onSave(form);
    if (ok !== false) sheet.close();
  };
  $('[data-close]', sheet).onclick = () => sheet.close();
  const del = $('[data-delete]', sheet);
  if (del) del.onclick = async () => { sheet.close(); await onDelete(); };
  onMount?.(form);
  sheet.showModal();
}

function formError(form, msg) {
  const el = $('.form-err', form);
  el.textContent = msg; el.hidden = false;
  el.scrollIntoView({ block: 'nearest' });
  return false;
}

// 先把會被改到的資料存一份，刪完跳出「復原」
async function withUndo(msg, affected, mutate) {
  const snap = affected.map(([col, id]) => {
    const d = S[col].find((x) => x.id === id);
    if (!d) return null;
    const { id: _, ...data } = d;
    return [col, id, structuredClone(data)];
  }).filter(Boolean);
  await mutate();
  toast(msg, '復原', async () => {
    for (const [col, id, data] of snap) await store.add(col, data, id);
  });
}
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });

const field = (label, input, hint = '') => `<label class="f"><span>${label}</span>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</label>`;
const input = (name, val = '', attrs = '') => `<input name="${name}" value="${esc(val)}" ${attrs}>`;
const select = (name, opts, val) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const unitOpts = (none = '未分配') => [['', none], ...S.units.map((u) => [u.id, u.name])];
const unitPick = (name, selected) => `<div class="pick">${S.units.map((u) =>
  `<label><input type="checkbox" name="${name}" value="${u.id}" ${selected.includes(u.id) ? 'checked' : ''}><span>${esc(u.name)}</span></label>`).join('')}</div>`;
const val = (form, n) => form.elements[n]?.value.trim() ?? '';
const num = (form, n) => { const v = val(form, n); return v === '' ? null : +v; };
const picked = (form, n) => {
  const ids = [...form.querySelectorAll(`input[name="${n}"]:checked`)].map((x) => x.value);
  return ids.length === S.units.length ? [] : ids;
};
function bad(form, n, msg) {
  const el = form.elements[n];
  el.setCustomValidity(msg); el.reportValidity();
  el.oninput = () => el.setCustomValidity('');
  return false;
}

const tripFields = (t) => field('行程名稱', input('name', t.name, 'placeholder="武陵農場 3 天 2 夜"')) +
  field('地點', input('location', t.location, 'placeholder="武陵農場露營區"')) +
  `<div class="f-row">${field('出發日', input('startDate', t.startDate, 'type="date"'))}${field('回程日', input('endDate', t.endDate, 'type="date"'))}</div>`;

function readTrip(f) {
  if (!val(f, 'name')) return bad(f, 'name', '請填行程名稱') && null;
  const a = parseDate(val(f, 'startDate')), b = parseDate(val(f, 'endDate'));
  if (!a) return bad(f, 'startDate', '請選出發日') && null;
  if (b && b < a) return bad(f, 'endDate', '回程日不能早於出發日') && null;
  if (b && (b - a) / 864e5 > 13) return bad(f, 'endDate', '最多 14 天') && null;
  const endDate = b ? val(f, 'endDate') : val(f, 'startDate');
  return { name: val(f, 'name'), location: val(f, 'location'), startDate: val(f, 'startDate'), endDate, days: Math.round((parseDate(endDate) - a) / 864e5) + 1 };
}

function editTrip() {
  const t = S.trip;
  openSheet({
    title: '行程資訊',
    body: tripFields(t),
    onSave: (f) => {
      const data = readTrip(f);
      if (!data) return false;
      store.update('meta', 'trip', data);
    },
  });
}

// 刪掉某個單位時，跟他有關的資料
function unitRefs(id) {
  const has = (arr) => arr?.includes(id);
  return {
    claims: S.gear.filter((g) => g.claims?.[id] != null),
    gear: S.gear.filter((g) => g.claims?.[id] != null || g.payer === id || has(g.sharedBy)),
    meals: S.meals.filter((m) => m.unitId === id),
    items: S.items.filter((i) => i.unitId === id),
    expenses: S.expenses.filter((x) => x.payer === id || has(x.sharedBy)),
    paid: [...S.gear.filter((g) => g.payer === id), ...S.expenses.filter((x) => x.payer === id)],
  };
}

function deleteUnit(id) {
  const name = uName(id), r = unitRefs(id);
  const drop = (arr) => (arr || []).filter((x) => x !== id);
  return withUndo(`已刪除「${name}」`, [
    ['units', id],
    ...r.gear.map((g) => ['gear', g.id]), ...r.meals.map((m) => ['meals', m.id]),
    ...r.items.map((i) => ['items', i.id]), ...r.expenses.map((x) => ['expenses', x.id]),
  ], async () => {
    for (const g of r.gear) {
      const patch = { ['claims.' + id]: DELETE };
      if (g.payer === id) patch.payer = null;
      if (g.sharedBy?.includes(id)) patch.sharedBy = drop(g.sharedBy);
      await store.update('gear', g.id, patch);
    }
    for (const m of r.meals) await store.update('meals', m.id, { unitId: null });
    for (const i of r.items) await store.update('items', i.id, { unitId: null });
    for (const x of r.expenses) {
      const patch = {};
      if (x.payer === id) patch.payer = null;
      if (x.sharedBy?.includes(id)) patch.sharedBy = drop(x.sharedBy);
      await store.update('expenses', x.id, patch);
    }
    await store.remove('units', id);
  });
}

function editUnit(id) {
  const u = unit(id) || { name: '', size: 1 };
  let warn = '';
  if (id) {
    const r = unitRefs(id);
    const parts = [r.claims.length && `${r.claims.length} 項裝備認領`, r.meals.length && `負責 ${r.meals.length} 餐`, r.paid.length && `代墊 ${r.paid.length} 筆費用`].filter(Boolean);
    if (parts.length) warn = `<div class="hint warn-hint"><i class="ti ti-info-circle"></i> 刪除後，${esc(u.name)} 的${parts.join('、')}會變成未分配。刪錯可以馬上復原。</div>`;
  }
  openSheet({
    title: id ? '編輯單位' : '新增單位',
    body: field('名稱', input('name', u.name, 'placeholder="姚藍"'), '一個人或一個家庭都可以是一個單位') +
      field('人數', input('size', u.size, 'type="number" min="1" inputmode="numeric"'), '分帳時依人數計算') + warn,
    onSave: (f) => {
      if (!val(f, 'name')) return bad(f, 'name', '請填名稱');
      const data = { name: val(f, 'name'), size: Math.max(1, num(f, 'size') || 1) };
      if (id) store.update('units', id, data);
      else store.add('units', { ...data, order: Math.max(-1, ...S.units.map((x) => x.order ?? 0)) + 1 });
    },
    onDelete: id ? () => deleteUnit(id) : null,
  });
}

function editGear(id, preset = {}) {
  const g = S.gear.find((x) => x.id === id) || { source: ui.gearFilter in SOURCE ? ui.gearFilter : 'own', qty: 1, claims: {}, sharedBy: [], need: 1, ...preset };
  const show = (srcs) => `data-show="${srcs}"`;
  openSheet({
    title: id ? '編輯裝備' : '新增裝備',
    body: field('名稱', input('name', g.name, 'placeholder="客廳帳"')) +
      field('來源', `<div class="pick">${Object.entries(SOURCE).map(([k, l]) => `<label><input type="radio" name="source" value="${k}" ${g.source === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>`) +
      `<div ${show('rent')}><div class="f-row">${field('店家', input('shop', g.shop, 'placeholder="Ayn"'))}${field('型號', input('model', g.model))}</div></div>` +
      `<div ${show('rent buy')}><div class="f-row">${field('單價', input('price', g.price, 'type="number" min="0" inputmode="numeric"'))}${field('數量', input('qty', g.qty || 1, 'type="number" min="1" inputmode="numeric"'))}</div>` +
      field('誰付錢', select('payer', unitOpts('還沒決定'), g.payer)) +
      field('誰分攤', unitPick('sharedBy', g.sharedBy?.length ? g.sharedBy : S.units.map((u) => u.id)), '只有某些人用的（例如個人床墊）就只勾他們') + '</div>' +
      `<div ${show('own')}>${field('類別', select('cat', [['', '未分類'], ...CATEGORIES.map((c) => [c, c])], g.cat))}` +
      `<div class="f-row">${field('數量怎麼算', select('needMode', [['fixed', '固定數量'], ['per', '每人幾個'], ['any', '有帶就好']], g.perPerson ? 'per' : g.need != null && g.need !== '' ? 'fixed' : 'any'))}` +
      `<div data-need>${field('<span data-need-label>需要幾個</span>', input('needN', g.perPerson ?? g.need ?? 1, 'type="number" min="1" inputmode="numeric"'))}</div></div>` +
      `<div class="hint" data-need-hint style="margin:-6px 0 12px"></div>` +
      `<div class="f"><span class="sub">誰帶</span>${S.units.map((u) => field(esc(u.name), input('claim_' + u.id, g.claims?.[u.id] ?? '', 'placeholder="數量或帶什麼，例如：湯鍋＋鐵鍋"'))).join('')}</div></div>` +
      field('備註', input('note', g.note)),
    onMount: (f) => {
      const sync = () => {
        const src = f.querySelector('input[name="source"]:checked')?.value;
        f.querySelectorAll('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(src); });
      };
      f.querySelectorAll('input[name="source"]').forEach((r) => (r.onchange = sync));
      sync();
      const syncNeed = () => {
        const mode = f.elements.needMode.value, n = +f.elements.needN.value || 1;
        $('[data-need]', f).hidden = mode === 'any';
        $('[data-need-label]', f).textContent = mode === 'per' ? '每人幾個' : '需要幾個';
        $('[data-need-hint]', f).textContent = mode === 'per' ? `目前 ${heads()} 人，共需要 ${n * heads()} 個；人數改了會自動更新` : mode === 'any' ? '例如蚊香、垃圾袋，有人帶就算齊' : '';
      };
      f.elements.needMode.onchange = f.elements.needN.oninput = syncNeed;
      syncNeed();
    },
    onSave: (f) => {
      if (!val(f, 'name')) return bad(f, 'name', '請填名稱');
      const source = f.querySelector('input[name="source"]:checked').value;
      const data = { name: val(f, 'name'), source, note: val(f, 'note') };
      if (source === 'rent') Object.assign(data, { shop: val(f, 'shop'), model: val(f, 'model') });
      if (source !== 'own') Object.assign(data, { price: num(f, 'price') || 0, qty: num(f, 'qty') || 1, payer: val(f, 'payer') || null, sharedBy: picked(f, 'sharedBy') });
      if (source === 'own') {
        const mode = val(f, 'needMode'), n = Math.max(1, num(f, 'needN') || 1);
        data.cat = val(f, 'cat') || null;
        data.need = mode === 'fixed' ? n : null;
        data.perPerson = mode === 'per' ? n : null;
        data.claims = {};
        S.units.forEach((u) => { const c = val(f, 'claim_' + u.id); if (c) data.claims[u.id] = c; });
      }
      if (id) store.update('gear', id, data); else store.add('gear', data);
    },
    onDelete: id ? () => withUndo(`已刪除「${g.name}」`, [['gear', id]], () => store.remove('gear', id)) : null,
  });
}

function claimGear(id, unitId) {
  if (!unit(unitId)) return pickMe(() => claimGear(id, ui.me));
  const g = S.gear.find((x) => x.id === id);
  const cur = g.claims?.[unitId];
  openSheet({
    title: `${uName(unitId)} 帶「${g.name}」`,
    body: field('帶多少或帶什麼', input('note', cur ?? '1', 'autofocus'), '填數字會算進數量；也可以寫「小煎鍋」這種說明') +
      (gearNeed(g) ? `<div class="hint">總共需要 ${gearNeed(g)} 個${g.perPerson ? `（每人 ${g.perPerson} 個）` : ''}</div>` : ''),
    saveText: cur != null ? '更新' : '我來帶',
    onSave: (f) => store.update('gear', id, { ['claims.' + unitId]: val(f, 'note') || '1' }),
    deleteText: '不帶了',
    onDelete: cur != null ? () => withUndo(`${uName(unitId)} 不帶「${g.name}」了`, [['gear', id]], () => store.update('gear', id, { ['claims.' + unitId]: DELETE })) : null,
  });
}

function editMeal(id, preset = {}) {
  const m = S.meals.find((x) => x.id === id) || { day: 1, slot: '晚餐', unitId: ui.me || '', ...preset };
  let ings = S.items.filter((i) => id && i.mealId === id).map((i) => ({ ...i }));
  const removed = [];
  const days = tripDays();
  const dayOpts = Array.from({ length: days }, (_, i) => [i + 1, dayLabel(i + 1)]);

  const ingRows = () => ings.length ? ings.map((it, k) => `<div class="ing" data-k="${k}">
      <input data-f="name" value="${esc(it.name)}" aria-label="食材">
      <input data-f="qty" value="${esc(it.qty)}" placeholder="數量" aria-label="數量">
      <button type="button" class="icon-btn" data-rm="${k}" aria-label="移除"><i class="ti ti-trash"></i></button>
      <div class="ing-2">
        <select data-f="mode" aria-label="方式"><option value="buy" ${it.mode === 'buy' ? 'selected' : ''}>要買</option><option value="bring" ${it.mode === 'bring' ? 'selected' : ''}>家裡帶</option></select>
        <select data-f="unitId" aria-label="誰">${[['', '同負責人'], ...S.units.map((u) => [u.id, u.name])].map(([v, l]) => `<option value="${v}" ${(it.unitId || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      </div></div>`).join('') : '<div class="empty">還沒有食材。</div>';

  openSheet({
    title: id ? '編輯這一餐' : '安排一餐',
    body: `<div class="f-row">${field('哪一天', select('day', dayOpts, m.day))}${field('哪一餐', select('slot', SLOTS.map((s) => [s, s]), m.slot))}</div>` +
      field('誰負責', select('unitId', unitOpts('還沒決定'), m.unitId)) +
      field('菜色', input('title', m.title, 'placeholder="蝦仁白醬義大利麵"')) +
      field('備註', input('note', m.note)) +
      `<div class="f"><span class="sub">食材</span><div id="ings">${ingRows()}</div>
        <div class="ing-add"><textarea id="ing-new" rows="1" placeholder="大番茄*2、九層塔、起司片" enterkeyhint="done"></textarea><button type="button" class="btn small" id="ing-add-btn">加入</button></div>
        <div class="hint">可以一次貼好幾樣，用頓號、逗號或換行分開；「*2」會變成數量</div></div>`,
    onMount: (f) => {
      const box = $('#ings', f);
      const redraw = () => (box.innerHTML = ingRows());
      box.oninput = box.onchange = (e) => {
        const row = e.target.closest('.ing'); if (!row || !e.target.dataset.f) return;
        ings[+row.dataset.k][e.target.dataset.f] = e.target.value;
      };
      box.onclick = (e) => {
        const rm = e.target.closest('[data-rm]'); if (!rm) return;
        const [it] = ings.splice(+rm.dataset.rm, 1);
        if (it.id) removed.push(it.id);
        redraw();
      };
      const addNew = () => {
        const inp = $('#ing-new', f);
        inp.value.split(/[、,，\n]+/).map((s) => s.trim()).filter(Boolean).forEach((s) => {
          const q = s.match(/^(.*?)\s*[*xX×]\s*(\d+\S*)$/);
          ings.push({ name: q ? q[1] : s, qty: q ? q[2] : '', mode: 'buy', unitId: '' });
        });
        inp.value = ''; redraw(); inp.focus();
      };
      $('#ing-add-btn', f).onclick = addNew;
      $('#ing-new', f).onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addNew(); } };
    },
    onSave: async (f) => {
      if (!val(f, 'title')) return bad(f, 'title', '請填菜色');
      const pending = $('#ing-new', f).value.trim();
      if (pending) $('#ing-add-btn', f).click();
      const data = { day: +val(f, 'day'), slot: val(f, 'slot'), unitId: val(f, 'unitId') || null, title: val(f, 'title'), note: val(f, 'note') };
      const mealId = id || await store.add('meals', data);
      if (id) store.update('meals', id, data);
      removed.forEach((rid) => store.remove('items', rid));
      for (const it of ings) {
        if (!it.name.trim()) { if (it.id) store.remove('items', it.id); continue; }
        const d = { name: it.name.trim(), qty: (it.qty || '').trim(), mode: it.mode, unitId: it.unitId || null, mealId };
        if (it.id) store.update('items', it.id, d); else store.add('items', { ...d, done: false });
      }
    },
    onDelete: id ? () => {
      const its = S.items.filter((i) => i.mealId === id);
      return withUndo(`已刪除「${m.title}」${its.length ? `和 ${its.length} 樣食材` : ''}`, [['meals', id], ...its.map((i) => ['items', i.id])], async () => {
        for (const i of its) await store.remove('items', i.id);
        await store.remove('meals', id);
      });
    } : null,
  });
}

function editItem(id) {
  const it = S.items.find((x) => x.id === id) || { mode: ui.shopMode, mealId: null, unitId: ui.me || null };
  const mealOpts = [['', '共用備品（不屬於某一餐）'], ...[...S.meals].sort(mealSort).map((m) => [m.id, mealLabel(m)])];
  openSheet({
    title: id ? '編輯品項' : '新增品項',
    body: `<div class="f-row">${field('品名', input('name', it.name, 'placeholder="冰塊"'))}<div style="flex:0 0 96px">${field('數量', input('qty', it.qty, 'placeholder="2 包"'))}</div></div>` +
      field('方式', `<div class="pick"><label><input type="radio" name="mode" value="buy" ${it.mode === 'buy' ? 'checked' : ''}><span>要買</span></label><label><input type="radio" name="mode" value="bring" ${it.mode === 'bring' ? 'checked' : ''}><span>家裡帶</span></label></div>`) +
      field('用在哪一餐', select('mealId', mealOpts, it.mealId || '')) +
      field('誰負責', select('unitId', unitOpts('同那一餐的負責人'), it.unitId || '')),
    onSave: (f) => {
      if (!val(f, 'name')) return bad(f, 'name', '請填品名');
      const data = { name: val(f, 'name'), qty: val(f, 'qty'), mode: f.querySelector('input[name="mode"]:checked').value, mealId: val(f, 'mealId') || null, unitId: val(f, 'unitId') || null };
      if (id) store.update('items', id, data); else store.add('items', { ...data, done: false });
    },
    onDelete: id ? () => withUndo(`已刪除「${it.name}」`, [['items', id]], () => store.remove('items', id)) : null,
  });
}

function editExpense(id) {
  const x = S.expenses.find((e) => e.id === id) || { payer: ui.me || '', sharedBy: [] };
  openSheet({
    title: id ? '編輯費用' : '新增費用',
    body: `<div class="f-row">${field('項目', input('title', x.title, 'placeholder="營地費"'))}<div style="flex:0 0 120px">${field('金額', input('amount', x.amount, 'type="number" min="0" inputmode="numeric"'))}</div></div>` +
      field('誰付的', select('payer', unitOpts('還沒填'), x.payer)) +
      field('誰分攤', unitPick('sharedBy', x.sharedBy?.length ? x.sharedBy : S.units.map((u) => u.id)), '依人數分攤，例如姚藍 2 人就算 2 份') +
      field('備註', input('note', x.note)),
    onSave: (f) => {
      if (!val(f, 'title')) return bad(f, 'title', '請填項目');
      if (!(num(f, 'amount') > 0)) return bad(f, 'amount', '請填金額');
      if (!f.querySelector('input[name="sharedBy"]:checked')) return formError(f, '至少要勾一個分攤的單位');
      const data = { title: val(f, 'title'), amount: num(f, 'amount'), payer: val(f, 'payer') || null, sharedBy: picked(f, 'sharedBy'), note: val(f, 'note') };
      if (id) store.update('expenses', id, data); else store.add('expenses', data);
    },
    onDelete: id ? () => withUndo(`已刪除「${x.title}」`, [['expenses', id]], () => store.remove('expenses', id)) : null,
  });
}

function pickMe(then) {
  openSheet({
    title: '你是哪個單位？',
    body: `<div class="me-pick">${S.units.map((u) => `<label class="pick"><input type="radio" name="me" value="${u.id}" ${u.id === ui.me ? 'checked' : ''}><span>${esc(u.name)}</span></label>`).join('')}</div>
      <div class="hint" style="margin-top:8px">只會記在這支手機上，用來顯示「我帶的」和預設負責人。</div>`,
    saveText: '確定',
    onSave: (f) => {
      const v = f.querySelector('input[name="me"]:checked')?.value;
      if (!v) return formError(f, '選一個單位');
      ui.me = v; keep('me', v); render();
      if (then) setTimeout(then, 0);
    },
  });
}

function toast(msg, actionText, onAction) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${actionText ? `<button type="button">${esc(actionText)}</button>` : ''}`;
  if (actionText) el.querySelector('button').onclick = () => { el.remove(); onAction(); };
  document.body.appendChild(el);
  setTimeout(() => el.remove(), actionText ? 6000 : 1800);
}

// ---------- 事件 ----------
document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('#tabs button');
  if (tabBtn) { ui.tab = tabBtn.dataset.tab; keep('tab', ui.tab); render(); scrollTo(0, 0); return; }
  const el = e.target.closest('[data-act]');
  if (!el || sheet.contains(el)) return;
  const { act, id, v } = el.dataset;
  switch (act) {
    case 'edit-trip': return editTrip();
    case 'pick-me': return pickMe();
    case 'set-me': ui.me = id; keep('me', id); return render();
    case 'gear-filter': ui.gearFilter = v; return render();
    case 'edit-gear': return editGear(id);
    case 'new-gear': return editGear(null, { source: el.dataset.src || 'own', cat: el.dataset.cat || null });
    case 'claim': return claimGear(id, el.dataset.unit || ui.me);
    case 'new-meal': return editMeal(null, { day: +el.dataset.day, slot: el.dataset.slot });
    case 'edit-meal': return editMeal(id);
    case 'shop-mode': ui.shopMode = v; return render();
    case 'shop-group': ui.shopGroup = v; return render();
    case 'toggle-item': { const it = S.items.find((i) => i.id === id); return store.update('items', id, { done: !it.done }); }
    case 'edit-item': return editItem(id);
    case 'edit-expense': return editExpense(id);
    case 'new-unit': return editUnit(null);
    case 'edit-unit': return editUnit(id);
    case 'apply-template': return addTemplate(templates[0]).then(() => toast('已套用露營基本清單'));
    case 'demo': return CLOUD ? (location.href = tripUrl('sample')) : loadDemo().then(() => pickMe());
    case 'share': return shareTrip();
    case 'home-new': ui.creating = true; return render();
    case 'home-back': ui.creating = false; return render();
    case 'upload-local': return uploadLocal(el);
    case 'restart': {
      const cloudTrip = !isLocal(tripId);
      return openSheet({
        title: cloudTrip ? '刪除這趟行程？' : '清空這趟行程？',
        body: `<p style="margin:0 0 8px">「${esc(S.trip.name)}」的裝備、餐食、採買和分帳會全部刪除${cloudTrip ? '，所有拿到連結的人都會看不到' : '，回到建立行程的畫面'}。</p>
          <p class="neg" style="margin:0">這個動作不能復原。</p>`,
        saveText: cloudTrip ? '刪除行程' : '清空並重新開始',
        destructive: true,
        onSave: async () => {
          ui.me = null; keep('me', '');
          if (!cloudTrip) return store.reset();
          await store.reset(); await store.flush();
          forgetRecent(tripId);
          location.href = tripUrl();
        },
      });
    }
  }
});

$('#fab').onclick = () => {
  ({ gear: () => editGear(null), meals: () => editMeal(null, { unitId: ui.me || '' }), shop: () => editItem(null), pay: () => editExpense(null) })[ui.tab]?.();
};

// ---------- 啟動 ----------
async function loadDemo() {
  await store.reset();
  // meta 最後寫，畫面才會在資料都到齊後才離開建立行程的畫面
  for (const [col, docs] of Object.entries(sample)) {
    if (col === 'meta') continue;
    for (const [id, d] of Object.entries(docs)) await store.add(col, d, id);
  }
  await store.add('meta', sample.meta.trip, 'trip');
}

let pending = false;
const schedule = () => {
  if (pending) return;
  pending = true;
  queueMicrotask(() => { pending = false; render(); });
};

function syncError(e) {
  console.error(e);
  const msg = e?.code === 'permission-denied' ? '沒有權限存取資料，請確認 Firebase 規則已發布'
    : e?.code === 'unavailable' ? '目前離線，連上網路後會自動同步' : '同步失敗，請稍後再試';
  toast(msg);
}

(async () => {
  if (ui.mode === 'home') return render();
  try {
    store = isLocal(tripId) ? new LocalStore(tripId) : await createFirebaseStore(firebaseConfig, tripId);
  } catch (e) {
    console.error(e);
    view.innerHTML = '<div class="hero"><h1>連不上資料庫</h1><p>請檢查網路後重新整理。</p></div>';
    return;
  }
  store.onError = syncError;
  // 剛建立的行程或第一次看示範：先選身分，雲端行程再提醒分享
  const params = new URLSearchParams(location.search);
  let justCreated = params.has('new');
  if (tripId === 'sample' && store.isEmpty()) { await loadDemo(); justCreated = true; }
  if (justCreated) history.replaceState(null, '', tripUrl(tripId));

  store.subscribe('meta', (docs, { fromCache }) => {
    S.trip = docs.find((d) => d.id === 'trip') || {};
    // 第一次開某個雲端行程時，快取是空的，要等伺服器回應才知道行程存不存在
    if (S.trip.name || !fromCache) S.loaded = true;
    if (S.trip.name && !isLocal(tripId)) saveRecent({ id: tripId, name: S.trip.name, location: S.trip.location || '', startDate: S.trip.startDate, endDate: S.trip.endDate });
    schedule();
    askMeOnce();
  });
  store.subscribe('units', (docs) => { S.units = docs.sort(byOrder); schedule(); askMeOnce(); });

  // 第一次打開這趟行程（還沒選過身分）就問一次「你是哪個單位」；剛建立的雲端行程再提醒分享
  let asked = false;
  function askMeOnce() {
    if (asked || !S.trip.name || !S.units.length) return;
    asked = true;
    const remindShare = justCreated && !isLocal(tripId);
    if (!unit(ui.me)) setTimeout(() => pickMe(remindShare ? () => toast('行程建立好了，按右上角的分享鍵把連結傳給大家') : null), 300);
    else if (remindShare) setTimeout(shareTrip, 300);
  }
  for (const c of ['gear', 'meals', 'items', 'expenses']) store.subscribe(c, (docs) => { S[c] = docs; schedule(); });
})();
