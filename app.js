// 原価計算アプリ（ステップ1：材料・包装・商品を登録して原価を出す）
// データはこのスマホのブラウザの中（localStorage）に保存する。ステップ5で共有の置き場所に移す予定。

const STORE_KEY = 'genka-v1';

const GROUPS = {
  farm: '農園の商品',
  processed: '加工品',
  cafe: 'カフェのメニュー',
};

// 仕入れの単位 → レシピで量を入れるときの単位と、何倍か
const UNITS = {
  kg: { base: 'g', factor: 1000 },
  g: { base: 'g', factor: 1 },
  L: { base: 'ml', factor: 1000 },
  ml: { base: 'ml', factor: 1 },
  個: { base: '個', factor: 1 },
};

const DEFAULT_SETTINGS = {
  hourlyWage: 2000,     // 時給（円）
  targetMargin: 60,     // 目標の利益率（%）
  wholesaleMarkup: 30,  // 卸値の上乗せ率（%）
};

// ---------- データの読み書き ----------

let data = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved) {
      saved.settings = { ...DEFAULT_SETTINGS, ...saved.settings };
      saved.priceHistory = saved.priceHistory || [];
      migrateToBatchAmounts(saved);
      return saved;
    }
  } catch (e) { /* 読めなければ空から始める */ }
  return { settings: { ...DEFAULT_SETTINGS }, materials: [], packaging: [], products: [], priceHistory: [] };
}

// 以前の「1つあたりの量（g・ml・個）」を「1回の仕込みで使う量（仕入れと同じ単位）」に置きかえる
function migrateToBatchAmounts(d) {
  for (const p of d.products) {
    if (p.amountsPerBatch) continue;
    for (const line of p.ingredients || []) {
      const m = d.materials.find(x => x.id === line.materialId);
      const factor = (UNITS[m?.unit] || UNITS['個']).factor;
      const perBatch = num(line.amount) * num(p.batchCount) / factor;
      line.amount = Math.round(perBatch * 1000) / 1000;
    }
    p.amountsPerBatch = true;
  }
}

function save() {
  syncLinkedMaterials();
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
  if (isConnected()) { queueChanges(); syncNow(); }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// ---------- 計算 ----------

function num(v) {
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function yen(n) {
  return Math.round(n).toLocaleString('ja-JP') + '円';
}

function yenFine(n) {
  // 1gあたりなど小さい単価用（小数2けた）
  return n.toLocaleString('ja-JP', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) + '円';
}

function baseUnit(material) {
  return (UNITS[material.unit] || UNITS['個']).base;
}

// 材料の仕入れ値。農園の卸値と連動している材料は、その卸値をそのまま使う
function materialPrice(material) {
  if (material.linkedProductId) {
    const p = data.products.find(x => x.id === material.linkedProductId);
    if (p && p.wholesale) return wholesalePrice(p);
  }
  return num(material.price);
}

// 材料の「1g（1ml・1個）あたり」の値段
function unitPrice(material) {
  const u = UNITS[material.unit] || UNITS['個'];
  const amount = num(material.qty) * u.factor;
  return amount > 0 ? materialPrice(material) / amount : 0;
}

// 商品の単位（kg・本・パックなど）から、材料としての仕入れの単位を決める
function unitFromLabel(label) {
  return UNITS[label] ? label : '個';
}

// カフェへの卸値。自分で決めた値段がなければ「原価＋上乗せ率」を10円単位に切り上げ
function wholesalePrice(p) {
  if (num(p.wholesalePrice) > 0) return num(p.wholesalePrice);
  return autoWholesale(p);
}
function autoWholesale(p) {
  return Math.ceil(calcCost(p).total * (1 + num(data.settings.wholesaleMarkup) / 100) / 10) * 10;
}

// 「カフェへ卸す」商品ごとに、カフェ用の材料を用意する（卸すのをやめたら、最後の値段で連動を外す）
function syncLinkedMaterials() {
  for (const p of data.products) {
    if (!p.wholesale || p.group === 'cafe') continue;
    let m = data.materials.find(x => x.linkedProductId === p.id);
    if (!m) {
      m = { id: newId(), linkedProductId: p.id, use: 'cafe', supplier: '自家農園' };
      data.materials.push(m);
    }
    const price = wholesalePrice(p);
    if (m.price !== price) m.updatedAt = today();
    Object.assign(m, { name: `${p.name}（農園から）`, qty: 1, unit: unitFromLabel(p.unitLabel), price });
  }
  for (const m of data.materials) {
    if (!m.linkedProductId) continue;
    const p = data.products.find(x => x.id === m.linkedProductId);
    if (!p || !p.wholesale || p.group === 'cafe') delete m.linkedProductId;
  }
}

// この材料（農園から）を使っているカフェのメニュー
function menusUsing(materialId) {
  return data.products.filter(p => (p.ingredients || []).some(l => l.materialId === materialId));
}

// 商品1つあたりの原価の内訳
const calculating = new Set();  // 同じ商品を計算中にまた計算しないための印

function calcCost(product) {
  if (calculating.has(product.id)) return { ingredients: 0, ingredientsBatch: 0, packaging: 0, labor: 0, utility: 0, total: 0, suggested: 0, batch: 0 };
  calculating.add(product.id);
  try { return calcCostInner(product); } finally { calculating.delete(product.id); }
}

function calcCostInner(product) {
  const s = data.settings;
  const batch = num(product.batchCount);

  // 材料は「1回の仕込みで使う量（仕入れと同じ単位）」で入っているので、1回分の材料費をできた数で割る
  let ingredientsBatch = 0;
  for (const line of product.ingredients || []) {
    const m = data.materials.find(x => x.id === line.materialId);
    if (m && num(m.qty) > 0) ingredientsBatch += materialPrice(m) / num(m.qty) * num(line.amount);
  }
  const ingredients = batch > 0 ? ingredientsBatch / batch : 0;

  let packaging = 0;
  for (const line of product.packaging || []) {
    const p = data.packaging.find(x => x.id === line.packagingId);
    if (p) packaging += num(p.price) * num(line.count);
  }

  const labor = batch > 0 ? num(product.laborHours) * num(s.hourlyWage) / batch : 0;
  const utility = batch > 0 ? num(product.utilityPerBatch) / batch : 0;
  const total = ingredients + packaging + labor + utility;

  // 売値の目安 = 原価 ÷ (1 − 目標の利益率)。10円単位に切り上げ
  const margin = num(s.targetMargin) / 100;
  const suggested = margin < 1 ? Math.ceil(total / (1 - margin) / 10) * 10 : 0;

  return { ingredients, ingredientsBatch, packaging, labor, utility, total, suggested, batch };
}

// ---------- 画面の切り替え ----------

const main = document.getElementById('main');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('back');

let currentTab = 'products';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 共有のデータが届いたときに描き直してよい画面（一覧の画面だけ。入力中の画面は描き直さない）
let liveView = null;

function setHeader(title, onBack) {
  liveView = null;
  titleEl.textContent = title;
  backBtn.hidden = !onBack;
  backBtn.onclick = onBack || null;
}

function markTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

function showTab(tab) {
  markTab(tab);
  window.scrollTo(0, 0);
  if (tab === 'products') renderProducts();
  if (tab === 'materials') renderMaterials();
  if (tab === 'settings') renderSettings();
}

document.querySelectorAll('.tabbar button').forEach(b => {
  b.addEventListener('click', () => showTab(b.dataset.tab));
});

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

// 「農園用／カフェ用」などの切り替えボタンを動かす
function wireSeg(root) {
  root.querySelectorAll('.seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        seg.dataset.value = btn.dataset.value;
        seg.dispatchEvent(new Event('input', { bubbles: true }));
      });
    });
  });
}

function segHtml(name, options, value) {
  return `<div class="seg" data-name="${name}" data-value="${esc(value)}">` +
    Object.entries(options).map(([k, label]) =>
      `<button type="button" data-value="${k}" class="${k === value ? 'on' : ''}">${label}</button>`).join('') +
    `</div>`;
}

// ---------- 商品の一覧 ----------

// 一覧の「切り替え」と「並べ替え」は、このスマホに覚えておく
const UI_KEY = 'genka-ui';
let ui = { filter: 'all', sort: 'order' };
try { ui = { ...ui, ...JSON.parse(localStorage.getItem(UI_KEY)) }; } catch (e) { /* 覚えていなければ最初の状態 */ }
function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify(ui)); } catch (e) { /* 覚えられなくても動く */ }
}

// 「農園」は農園の商品と加工品（たかさんのお財布）、「カフェ」はカフェのメニュー
const FILTERS = { all: 'すべて', farm: '農園', cafe: 'カフェ' };
const SORTS = { order: '登録順', profit: '利益が多い順', rate: '利益率が高い順' };

function inFilter(p) {
  if (ui.filter === 'farm') return p.group === 'farm' || p.group === 'processed';
  if (ui.filter === 'cafe') return p.group === 'cafe';
  return true;
}

// 売値から利益・利益率を出す（売値が未定なら null）
function profitOf(p, c = calcCost(p)) {
  const price = num(p.price);
  if (price <= 0) return null;
  const profit = price - c.total;
  return { price, profit, rate: profit / price * 100 };
}

// 色分け：赤字は赤、目標の利益率より低いとオレンジ、目標以上は緑
function profitClass(profit, rate) {
  if (profit < 0) return 'minus';
  return rate < num(data.settings.targetMargin) - 0.5 ? 'low' : 'plus';
}

// 目標の利益率（%）から売値の目安を出す。10円単位に切り上げ
function priceForMargin(cost, marginPct) {
  const m = marginPct / 100;
  return m < 1 ? Math.ceil(cost / (1 - m) / 10) * 10 : 0;
}

function productCard(p, rank) {
  const c = calcCost(p);
  const r = profitOf(p, c);
  const per = esc(p.unitLabel || '1つ');
  const cls = r ? profitClass(r.profit, r.rate) : '';
  return `
    <button class="card" data-id="${p.id}">
      <div class="row">
        <div class="name">${rank ? `<span class="rank">${rank}</span>` : ''}${esc(p.name)}</div>
        <div class="sub" style="margin:0">1${per}あたり</div>
      </div>
      <div class="stats">
        <div><span>原価</span><b>${yen(c.total)}</b></div>
        <div><span>売値</span><b>${r ? yen(r.price) : '未定'}</b></div>
        <div><span>利益</span><b class="${r ? cls : ''}">${r ? yen(r.profit) : '—'}</b></div>
        <div><span>利益率</span><b class="${r ? cls : ''}">${r ? r.rate.toFixed(0) + '%' : '—'}</b></div>
      </div>
      ${r ? '' : `<div class="sub">売値の目安 ${yen(c.suggested)}（利益率${num(data.settings.targetMargin)}%）</div>`}
    </button>`;
}

function renderProducts() {
  setHeader('商品');
  liveView = renderProducts;
  if (data.products.length === 0) {
    main.innerHTML = `
      <div class="empty">
        まだ商品がありません。<br>
        下のボタンで見本の「ハスカップジャム」を入れて、<br>原価の出かたを試してみましょう。
      </div>
      <button class="btn primary" id="sample">見本のハスカップジャムを入れる</button>
      <button class="btn ghost" id="add">＋ 自分で商品を登録する</button>`;
    main.querySelector('#sample').onclick = addSample;
    main.querySelector('#add').onclick = () => editProduct(null);
    return;
  }

  const list = data.products.filter(inFilter);
  let body;
  if (list.length === 0) {
    body = `<div class="empty">${FILTERS[ui.filter]}の商品はまだありません</div>`;
  } else if (ui.sort === 'order') {
    // 登録順のときは、グループごとに見出しをつける
    body = Object.entries(GROUPS).map(([g, label]) => {
      const items = list.filter(p => p.group === g);
      return items.length ? `<h2>${label}</h2>` + items.map(p => productCard(p)).join('') : '';
    }).join('');
  } else {
    // 利益の順に並べる。売値が未定の商品はいちばん下
    const key = p => {
      const r = profitOf(p);
      if (!r) return -Infinity;
      return ui.sort === 'profit' ? r.profit : r.rate;
    };
    const sorted = [...list].sort((a, b) => key(b) - key(a));
    body = `<h2>${SORTS[ui.sort]}</h2>` +
      sorted.map((p, i) => productCard(p, profitOf(p) ? i + 1 : '')).join('');
  }

  main.innerHTML = `
    <div class="toolbar">
      ${segHtml('filter', FILTERS, ui.filter)}
      <select id="sort">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}" ${k === ui.sort ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${body}
    <button class="btn ghost" id="add">＋ 商品を登録する</button>
    ${data.products.some(p => p.group === 'farm') ? '' : `<button class="btn ghost" id="sample2">見本の「加工用ハスカップ」と「パフェ」を入れる</button>`}`;

  const sample2 = main.querySelector('#sample2');
  if (sample2) sample2.onclick = addFarmCafeSample;
  const seg = main.querySelector('.seg');
  wireSeg(main);
  seg.addEventListener('input', () => { ui.filter = seg.dataset.value; saveUi(); renderProducts(); });
  main.querySelector('#sort').onchange = e => { ui.sort = e.target.value; saveUi(); renderProducts(); };
  main.querySelectorAll('.card[data-id]').forEach(el => el.onclick = () => simulate(el.dataset.id));
  main.querySelector('#add').onclick = () => editProduct(null);
}

// ---------- 値段シミュレーション ----------

// 農園→カフェの卸値と、その卸値を使っているカフェのメニュー
function wholesaleCardHtml(p, c) {
  if (!p.wholesale || p.group === 'cafe') return '';
  const per = esc(p.unitLabel || '1つ');
  const ws = wholesalePrice(p);
  const manual = num(p.wholesalePrice) > 0;
  const linked = data.materials.find(m => m.linkedProductId === p.id);
  const menus = linked ? menusUsing(linked.id) : [];
  return `
    <h2>カフェへの卸値</h2>
    <div class="card">
      <div class="row">
        <div><div class="sub" style="margin:0">1${per}あたり</div><div class="big">${yen(ws)}</div></div>
        <div class="sub" style="text-align:right">${manual ? '自分で決めた卸値' : `原価${yen(c.total)}＋${num(data.settings.wholesaleMarkup)}%`}<br>農園の利益 ${yen(ws - c.total)}</div>
      </div>
      <div class="linked-menus">
        <div class="sub">この卸値を使っているカフェのメニュー</div>
        ${menus.length ? menus.map(m => {
          const mc = calcCost(m);
          const r = profitOf(m, mc);
          return `<button class="menu-row" data-id="${m.id}">
            <span>${esc(m.name)}</span>
            <span>原価 <b>${yen(mc.total)}</b>${r ? ` ・ 利益率 <b class="${profitClass(r.profit, r.rate)}">${r.rate.toFixed(0)}%</b>` : ''}</span>
          </button>`;
        }).join('') : `<div class="sub">まだありません。カフェのメニューの材料で「${esc(p.name)}（農園から）」をえらぶと、ここに出ます</div>`}
      </div>
    </div>`;
}

function simulate(id) {
  const p = data.products.find(x => x.id === id);
  if (!p) { showTab('products'); return; }
  const c = calcCost(p);
  const per = esc(p.unitLabel || '1つ');
  const target = num(data.settings.targetMargin);
  const saved = num(p.price);

  // スライダーの幅：原価から、目安の2倍くらいまで（決めた売値がそれより高ければそこまで）
  const start = saved > 0 ? saved : c.suggested;
  const min = Math.max(10, Math.floor(c.total / 10) * 10);
  const max = Math.max(Math.ceil(c.suggested * 2 / 100) * 100, Math.ceil(start * 1.2 / 100) * 100, min + 100);

  setHeader(p.name, () => showTab('products'));
  markTab('products');
  window.scrollTo(0, 0);

  const margins = [...new Set([30, 40, 50, target, 70])].filter(m => m < 100).sort((a, b) => a - b);

  main.innerHTML = `
    <div class="card">
      <div class="row">
        <div><div class="sub" style="margin:0">原価（1${per}あたり）</div><div class="big">${yen(c.total)}</div></div>
        <button class="pill" id="edit">内訳・レシピを直す</button>
      </div>
      <div class="sub">いまの売値：${saved > 0 ? yen(saved) : 'まだ決めていません'}</div>
    </div>
    ${wholesaleCardHtml(p, c)}

    <h2>売値を動かしてみる</h2>
    <div class="card sim">
      <div class="inline price-in">
        <input id="priceIn" type="number" inputmode="numeric" value="${start}">
        <span class="unit">円（税込）</span>
      </div>
      <input id="slider" type="range" min="${min}" max="${max}" step="10" value="${Math.min(Math.max(start, min), max)}">
      <div class="bar"><div class="cost"></div><div class="profit"></div></div>
      <div class="bar-legend"><span>■ 原価</span><span class="plus">■ 利益</span></div>
      <div class="sim-stats">
        <div><span>1${per}あたりの利益</span><b id="sProfit"></b></div>
        <div><span>利益率</span><b id="sRate"></b></div>
      </div>
      <div class="sub" id="sNote"></div>
      <button class="btn primary" id="decide">この売値に決める</button>
    </div>

    <h2>利益率から売値を見る（早見表）</h2>
    <div class="card quick">
      <table>
        <tr><th>利益率</th><th>売値の目安</th><th>利益</th></tr>
        ${margins.map(m => {
          const pr = priceForMargin(c.total, m);
          return `<tr data-price="${pr}" class="${m === target ? 'target' : ''}">
            <td>${m}%${m === target ? '<small>目標</small>' : ''}</td><td>${yen(pr)}</td><td>${yen(pr - c.total)}</td></tr>`;
        }).join('')}
      </table>
      <div class="hint">行を押すと、上の売値がその値段になります</div>
    </div>`;

  const priceIn = main.querySelector('#priceIn');
  const slider = main.querySelector('#slider');

  const update = (price) => {
    const profit = price - c.total;
    const rate = price > 0 ? profit / price * 100 : 0;
    const cls = profitClass(profit, rate);
    main.querySelector('#sProfit').innerHTML = `<span class="${cls}">${yen(profit)}</span>`;
    main.querySelector('#sRate').innerHTML = `<span class="${cls}">${rate.toFixed(1)}%</span>`;
    const costPct = price > 0 ? Math.min(100, c.total / price * 100) : 100;
    main.querySelector('.bar .cost').style.width = costPct + '%';
    main.querySelector('.bar .profit').style.width = (100 - costPct) + '%';
    const diff = rate - target;
    main.querySelector('#sNote').textContent = profit < 0
      ? 'この売値だと赤字です'
      : Math.abs(diff) < 0.5 ? `目標の利益率（${target}%）ぴったりです`
      : diff > 0 ? `目標の利益率（${target}%）より ${diff.toFixed(1)}ポイント高い`
      : `目標の利益率（${target}%）より ${(-diff).toFixed(1)}ポイント低い`;
    main.querySelectorAll('.quick tr[data-price]').forEach(tr => tr.classList.toggle('on', num(tr.dataset.price) === price));
  };

  slider.addEventListener('input', () => { priceIn.value = slider.value; update(num(slider.value)); });
  priceIn.addEventListener('input', () => { slider.value = priceIn.value; update(num(priceIn.value)); });
  main.querySelectorAll('.quick tr[data-price]').forEach(tr => tr.onclick = () => {
    priceIn.value = tr.dataset.price; slider.value = tr.dataset.price; update(num(tr.dataset.price));
    priceIn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  main.querySelector('#edit').onclick = () => editProduct(p.id);
  main.querySelectorAll('.menu-row').forEach(el => el.onclick = () => simulate(el.dataset.id));
  main.querySelector('#decide').onclick = () => {
    const price = num(priceIn.value);
    if (price <= 0) { toast('売値を入れてください'); return; }
    p.price = price;
    save();
    toast(`売値を${yen(price)}に決めました`);
    simulate(p.id);
  };

  update(start);
}

// ---------- 商品（レシピ）の登録 ----------

// 農園の商品は「1年間の栽培にかかった費用 ÷ 1年間の収穫量」で出すので、項目の名前を変える
const LABELS = {
  normal: {
    section: '1回の仕込み', batch: '1回でできる数', batchHint: 'だいたいの数でOKです（例：約50瓶 → 50）',
    labor: '作業時間（1回あたり）', utility: '光熱費・機械代（1回あたりの目安）',
    ings: '使う材料（1回の仕込みで使う量）', per: '1回分', ingName: '材料費', utilName: '光熱費・機械代',
  },
  farm: {
    section: '1年間の栽培', batch: '1年間の収穫量', batchHint: 'データが少ないうちは仮の数字でOKです（例：300kg → 300）',
    labor: '1年間の作業時間', utility: '機械の燃料など（1年間）',
    ings: '使った肥料・農薬・資材（1年間の量）', per: '1年分', ingName: '肥料・農薬・資材', utilName: '燃料など',
  },
};
function labelsFor(group) { return group === 'farm' ? LABELS.farm : LABELS.normal; }

function editProduct(id) {
  const existing = data.products.find(p => p.id === id);
  const p = existing ? structuredClone(existing) : {
    id: newId(), name: '', group: 'processed', unitLabel: '瓶',
    batchCount: '', laborHours: '', utilityPerBatch: '', price: '',
    ingredients: [], packaging: [], amountsPerBatch: true,
    wholesale: false, wholesalePrice: '',
  };
  const L = labelsFor(p.group);

  // 戻るときは、直す前に見ていた値段シミュレーションへ（新しく登録するときは一覧へ）
  setHeader(existing ? '商品を直す' : '商品を登録', () => existing ? simulate(id) : showTab('products'));
  markTab('products');
  window.scrollTo(0, 0);

  const ingredientOptions = (sel) => `<option value="">材料をえらぶ</option>` +
    data.materials.filter(m => m.linkedProductId !== p.id)
      .map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const packagingOptions = (sel) => `<option value="">包装をえらぶ</option>` +
    data.packaging.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

  const ingLine = (l = {}) => {
    const m = data.materials.find(x => x.id === l.materialId);
    // 農園の商品では、時期ごとに1行ずつ入れられるよう「メモ（春・収穫後など）」を付ける
    return `<div class="ing">
      <div class="line-item">
        <select>${ingredientOptions(l.materialId)}</select>
        <input class="amt" type="number" inputmode="decimal" placeholder="量" value="${esc(l.amount ?? '')}">
        <span class="unit">${m ? esc(m.unit) : ''}</span>
        <button type="button" class="x" aria-label="消す">×</button>
      </div>
      <input class="memo" placeholder="時期のメモ（例：春・開花前・収穫後）" value="${esc(l.memo ?? '')}">
    </div>`;
  };
  const pkgLine = (l = {}) => `<div class="line-item pkg">
      <select>${packagingOptions(l.packagingId)}</select>
      <input type="number" inputmode="decimal" placeholder="数" value="${esc(l.count ?? 1)}">
      <span class="unit">個</span>
      <button type="button" class="x" aria-label="消す">×</button>
    </div>`;

  main.innerHTML = `
    <form id="pform" autocomplete="off">
      <div class="card">
        <div class="field">
          <label>商品の名前</label>
          <input name="name" value="${esc(p.name)}" placeholder="例：ハスカップジャム" required>
        </div>
        <div class="field">
          <label>グループ</label>
          ${segHtml('group', { farm: '農園', processed: '加工品', cafe: 'カフェ' }, p.group)}
        </div>
        <div class="field">
          <label>原価を出す単位</label>
          <input name="unitLabel" value="${esc(p.unitLabel)}" placeholder="例：瓶・kg・パック・皿・杯">
          <div class="hint">「1瓶あたり」の「瓶」の部分です</div>
        </div>
      </div>

      <h2 data-l="section">${L.section}</h2>
      <div class="card">
        <div class="field">
          <label data-l="batch">${L.batch}</label>
          <div class="inline"><input name="batchCount" type="number" inputmode="decimal" value="${esc(p.batchCount)}" placeholder="50"><span class="unit unitLabel">${esc(p.unitLabel)}</span></div>
          <div class="hint" data-l="batchHint">${L.batchHint}</div>
        </div>
        <div class="field">
          <label data-l="labor">${L.labor}</label>
          <div class="inline"><input name="laborHours" type="number" inputmode="decimal" step="0.25" value="${esc(p.laborHours)}" placeholder="3"><span class="unit">時間</span></div>
        </div>
        <div class="field">
          <label data-l="utility">${L.utility}</label>
          <div class="inline"><input name="utilityPerBatch" type="number" inputmode="decimal" value="${esc(p.utilityPerBatch)}" placeholder="600"><span class="unit">円</span></div>
        </div>
      </div>

      <h2 data-l="ings">${L.ings}</h2>
      <div class="card">
        <div id="ings">${p.ingredients.map(ingLine).join('')}</div>
        <div id="ingTotals"></div>
        ${data.materials.length
          ? `<button type="button" class="add-line" id="addIng">＋ 材料を足す</button>`
          : `<div class="hint">先に「材料」タブで材料を登録してください</div>`}
      </div>

      <h2>包装・送料（1<span class="unitLabel">${esc(p.unitLabel)}</span>あたり）</h2>
      <div class="card">
        <div id="pkgs">${p.packaging.map(pkgLine).join('')}</div>
        ${data.packaging.length
          ? `<button type="button" class="add-line" id="addPkg">＋ 包装を足す</button>`
          : `<div class="hint">先に「材料」タブで包装・資材を登録してください</div>`}
      </div>

      <h2>売値（決まっていれば）</h2>
      <div class="card">
        <div class="inline"><input name="price" type="number" inputmode="decimal" value="${esc(p.price)}" placeholder="未定なら空のまま"><span class="unit">円（税込）</span></div>
      </div>

      <div id="wsBlock">
        <h2>カフェへ卸す</h2>
        <div class="card">
          ${segHtml('wholesale', { no: '卸さない', yes: '卸す' }, p.wholesale ? 'yes' : 'no')}
          <div id="wsFields" class="field" style="margin:14px 0 0">
            <label>卸値（1<span class="unitLabel">${esc(p.unitLabel)}</span>あたり・税込）</label>
            <div class="inline"><input name="wholesalePrice" type="number" inputmode="decimal" value="${esc(p.wholesalePrice)}" placeholder="自動"><span class="unit">円</span></div>
            <div class="hint" id="wsHint"></div>
          </div>
        </div>
      </div>

      <h2>原価の内訳</h2>
      <div class="card breakdown" id="breakdown"></div>

      <button type="submit" class="btn primary">保存する</button>
      ${existing ? `<button type="button" class="btn danger" id="del">この商品を消す</button>` : ''}
    </form>`;

  const form = main.querySelector('#pform');
  wireSeg(form);

  const readForm = () => {
    const f = form.elements;
    return {
      ...p,
      name: f.name.value.trim(),
      group: form.querySelector('.seg[data-name=group]').dataset.value,
      unitLabel: f.unitLabel.value.trim(),
      batchCount: f.batchCount.value,
      laborHours: f.laborHours.value,
      utilityPerBatch: f.utilityPerBatch.value,
      price: f.price.value,
      wholesale: form.querySelector('.seg[data-name=wholesale]').dataset.value === 'yes',
      wholesalePrice: f.wholesalePrice.value,
      ingredients: [...form.querySelectorAll('.ing')].map(row => ({
        materialId: row.querySelector('select').value,
        amount: row.querySelector('.amt').value,
        memo: row.querySelector('.memo').value.trim(),
      })).filter(l => l.materialId),
      packaging: [...form.querySelectorAll('.pkg')].map(row => ({
        packagingId: row.querySelector('select').value,
        count: row.querySelector('input').value,
      })).filter(l => l.packagingId),
    };
  };

  const refresh = () => {
    const cur = readForm();
    const per = cur.unitLabel || '1つ';
    form.querySelectorAll('.unitLabel').forEach(el => el.textContent = per);
    // グループに合わせて項目の名前を変える
    const L = labelsFor(cur.group);
    form.querySelectorAll('[data-l]').forEach(el => el.textContent = L[el.dataset.l]);
    // カフェへ卸すのは農園・加工品だけ
    form.querySelector('#wsBlock').hidden = cur.group === 'cafe';
    form.querySelector('#wsFields').hidden = !cur.wholesale;
    form.querySelector('#wsHint').textContent =
      `空のままなら、原価＋${num(data.settings.wholesaleMarkup)}%で自動計算します（いまは${yen(autoWholesale(cur))}）`;
    // 材料をえらび直したら、量の単位（g・ml・個）も合わせる
    form.querySelectorAll('.ing').forEach(row => {
      const m = data.materials.find(x => x.id === row.querySelector('select').value);
      row.querySelector('.unit').textContent = m ? m.unit : '';
    });
    form.classList.toggle('farm-mode', cur.group === 'farm');
    form.querySelector('#ingTotals').innerHTML = cur.group === 'farm' ? ingTotalsHtml(cur) : '';
    form.querySelector('#breakdown').innerHTML = breakdownHtml(cur);
  };

  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('click', e => {
    if (e.target.classList.contains('x')) { e.target.closest('.ing, .line-item').remove(); refresh(); }
  });
  const addIng = form.querySelector('#addIng');
  if (addIng) addIng.onclick = () => { form.querySelector('#ings').insertAdjacentHTML('beforeend', ingLine()); refresh(); };
  const addPkg = form.querySelector('#addPkg');
  if (addPkg) addPkg.onclick = () => { form.querySelector('#pkgs').insertAdjacentHTML('beforeend', pkgLine()); refresh(); };

  form.addEventListener('submit', e => {
    e.preventDefault();
    const cur = readForm();
    if (!cur.name) { toast('商品の名前を入れてください'); return; }
    if (num(cur.batchCount) <= 0) { toast('1回でできる数を入れてください'); return; }
    const i = data.products.findIndex(x => x.id === cur.id);
    if (i >= 0) data.products[i] = cur; else data.products.push(cur);
    save();
    toast('保存しました');
    simulate(cur.id);
  });

  const del = form.querySelector('#del');
  if (del) del.onclick = () => {
    const linked = data.materials.find(m => m.linkedProductId === p.id);
    const users = linked ? menusUsing(linked.id).map(x => x.name) : [];
    if (users.length) { alert(`カフェの「${users.join('」「')}」でこの商品の卸値を使っているので消せません。先にメニューから外してください。`); return; }
    if (!confirm(`「${p.name}」を消しますか？`)) return;
    data.products = data.products.filter(x => x.id !== p.id);
    if (linked) data.materials = data.materials.filter(m => m !== linked);
    save();
    toast('消しました');
    showTab('products');
  };

  refresh();
}

// 同じ肥料・農薬を時期ごとに分けて入れても、種類ごとに合計して見せる
function ingTotalsHtml(p) {
  const totals = new Map();
  for (const line of p.ingredients) {
    const m = data.materials.find(x => x.id === line.materialId);
    if (!m) continue;
    const t = totals.get(m.id) || { m, amount: 0, times: 0 };
    t.amount += num(line.amount);
    t.times += 1;
    totals.set(m.id, t);
  }
  if (!totals.size) return '';
  const rows = [...totals.values()].map(({ m, amount, times }) => {
    const cost = num(m.qty) > 0 ? materialPrice(m) / num(m.qty) * amount : 0;
    return `<tr><td>${esc(m.name)}${times > 1 ? `<small>${times}回</small>` : ''}</td>
      <td>${Math.round(amount * 1000) / 1000}${esc(m.unit)}</td><td>${yen(cost)}</td></tr>`;
  }).join('');
  return `<div class="totals"><div class="sub">種類ごとの合計（1年間）</div><table>${rows}</table></div>`;
}

function breakdownHtml(p) {
  const c = calcCost(p);
  const s = data.settings;
  const per = esc(p.unitLabel || '1つ');
  const L = labelsFor(p.group);
  const batch = c.batch > 0 ? `${c.batch}${per}` : '（できる数が未入力）';

  let html = `<table>
    <tr><td>${L.ingName}<span class="how">${L.per} ${yen(c.ingredientsBatch)} ÷ ${batch}</span></td><td>${yen(c.ingredients)}</td></tr>
    <tr><td>包装・送料</td><td>${yen(c.packaging)}</td></tr>
    <tr><td>作業時間<span class="how">${num(p.laborHours)}時間 × 時給${yen(s.hourlyWage)} ÷ ${batch}</span></td><td>${yen(c.labor)}</td></tr>
    <tr><td>${L.utilName}<span class="how">${yen(num(p.utilityPerBatch))} ÷ ${batch}</span></td><td>${yen(c.utility)}</td></tr>
    <tr class="total"><td>原価（1${per}あたり）</td><td>${yen(c.total)}</td></tr>
  </table>
  ${p.wholesale && p.group !== 'cafe' ? `<div class="result"><div class="row"><span>カフェへの卸値</span><b>${yen(wholesalePrice(p))}</b></div></div>` : ''}
  <div class="result">
    <div class="row"><span>売値の目安（利益率${num(s.targetMargin)}%）</span><b>${yen(c.suggested)}</b></div>`;

  const price = num(p.price);
  if (price > 0) {
    const profit = price - c.total;
    const rate = profit / price * 100;
    const cls = profit >= 0 ? 'plus' : 'minus';
    html += `
    <div class="row"><span>決めた売値</span><span>${yen(price)}</span></div>
    <div class="row"><span>1${per}あたりの利益</span><b class="${cls}">${yen(profit)}</b></div>
    <div class="row"><span>利益率</span><b class="${cls}">${rate.toFixed(1)}%</b></div>`;
  }
  return html + `</div>`;
}

// ---------- 材料・包装の一覧 ----------

function renderMaterials() {
  setHeader('材料');
  liveView = renderMaterials;

  const mats = data.materials.map(m => `
    <button class="card" data-mat="${m.id}">
      <div class="row">
        <div class="name"><span class="badge ${m.use === 'cafe' ? 'cafe' : ''}">${m.use === 'cafe' ? 'カフェ' : '農園'}</span>${esc(m.name)}</div>
        <div class="big">${yenFine(unitPrice(m))}<small style="font-size:12px;color:var(--muted);font-weight:400"> /${baseUnit(m)}</small></div>
      </div>
      <div class="sub">${m.linkedProductId
        ? `🔗 農園の卸値と連動：1${esc(m.unit === '個' ? (data.products.find(x => x.id === m.linkedProductId)?.unitLabel || '個') : m.unit)} ${yen(materialPrice(m))}`
        : `仕入れ：${num(m.qty)}${esc(m.unit)} ${yen(num(m.price))}${m.supplier ? '・' + esc(m.supplier) : ''}・${esc(m.updatedAt)}更新${lastChangeHtml(m.id)}`}</div>
    </button>`).join('');

  const pkgs = data.packaging.map(x => `
    <button class="card" data-pkg="${x.id}">
      <div class="row">
        <div class="name">${esc(x.name)}</div>
        <div class="big">${yen(num(x.price))}</div>
      </div>
      ${lastChangeHtml(x.id) ? `<div class="sub">${lastChangeHtml(x.id).slice(1)}</div>` : ''}
    </button>`).join('');

  main.innerHTML = `
    <h2>材料（1gあたりなどの単価を自動計算）</h2>
    ${mats || '<div class="empty">まだ材料がありません</div>'}
    <button class="btn ghost" id="addMat">＋ 材料を追加</button>
    <h2>包装・資材・送料（1つあたりの値段）</h2>
    ${pkgs || '<div class="empty">まだ包装・資材がありません</div>'}
    <button class="btn ghost" id="addPkg">＋ 包装・資材を追加</button>
    <h2>記録</h2>
    <button class="btn ghost" id="hist">📋 値段の変更履歴（${data.priceHistory.length}件）</button>`;
  main.querySelector('#hist').onclick = renderHistory;

  main.querySelectorAll('[data-mat]').forEach(el => el.onclick = () => editMaterial(el.dataset.mat));
  main.querySelectorAll('[data-pkg]').forEach(el => el.onclick = () => editPackaging(el.dataset.pkg));
  main.querySelector('#addMat').onclick = () => editMaterial(null);
  main.querySelector('#addPkg').onclick = () => editPackaging(null);
}

// 使っている商品の名前（消すときの確認用）
function usedBy(field, id) {
  return data.products.filter(p => (p[field] || []).some(l => l.materialId === id || l.packagingId === id)).map(p => p.name);
}

function editMaterial(id) {
  const existing = data.materials.find(m => m.id === id);
  if (existing && existing.linkedProductId) {
    const p = data.products.find(x => x.id === existing.linkedProductId);
    setHeader(existing.name, () => showTab('materials'));
    main.innerHTML = `
      <div class="card">
        <div class="name">🔗 ${esc(existing.name)}</div>
        <p class="sub" style="line-height:1.7">この材料の値段は、農園の「${esc(p.name)}」のカフェへの卸値（${yen(materialPrice(existing))}）と連動しています。
        卸値を変えると、この材料を使うカフェのメニューの原価も自動で変わります。</p>
        <button class="btn primary" id="go">農園の「${esc(p.name)}」を開く</button>
      </div>`;
    main.querySelector('#go').onclick = () => simulate(p.id);
    return;
  }
  const m = existing ? { ...existing } : { id: newId(), name: '', use: 'farm', qty: 1, unit: 'kg', price: '', supplier: '' };

  setHeader(existing ? '材料を直す' : '材料を追加', () => showTab('materials'));
  markTab('materials');
  window.scrollTo(0, 0);

  main.innerHTML = `
    <form id="mform" class="card" autocomplete="off">
      <div class="field">
        <label>材料の名前</label>
        <input name="name" value="${esc(m.name)}" placeholder="例：砂糖" required>
      </div>
      <div class="field">
        <label>どちらで使う？</label>
        ${segHtml('use', { farm: '農園用', cafe: 'カフェ用' }, m.use)}
      </div>
      <div class="field">
        <label>仕入れの量</label>
        <div class="inline">
          <input name="qty" type="number" inputmode="decimal" value="${esc(m.qty)}">
          <select name="unit">${Object.keys(UNITS).map(u => `<option ${u === m.unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
        </div>
      </div>
      <div class="field">
        <label>仕入れ値（税込）</label>
        <div class="inline"><input name="price" type="number" inputmode="decimal" value="${esc(m.price)}" placeholder="300"><span class="unit">円</span></div>
        <div class="preview" id="mprev"></div>
        ${existing ? tryButtonsHtml() : ''}
      </div>
      <div class="field">
        <label>仕入れ先（なくてもOK）</label>
        <input name="supplier" value="${esc(m.supplier)}" placeholder="例：〇〇商店">
      </div>
      <div id="impact"></div>
      <button type="submit" class="btn primary">保存する</button>
      ${existing ? `<button type="button" class="btn danger" id="del">この材料を消す</button>` : ''}
    </form>
    ${existing ? itemHistoryHtml(m.id) : ''}`;

  const form = main.querySelector('#mform');
  wireSeg(form);
  const read = () => ({
    ...m,
    name: form.elements.name.value.trim(),
    use: form.querySelector('.seg').dataset.value,
    qty: form.elements.qty.value,
    unit: form.elements.unit.value,
    price: form.elements.price.value,
    supplier: form.elements.supplier.value.trim(),
  });
  const refresh = () => {
    const cur = read();
    form.querySelector('#mprev').textContent = `→ 1${baseUnit(cur)}あたり ${yenFine(unitPrice(cur))}`;
    if (existing) form.querySelector('#impact').innerHTML = impactHtml(impactOf('materials', existing, cur), priceChanged(existing, cur));
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  if (existing) wireTryButtons(form, num(existing.price), refresh);
  refresh();

  form.addEventListener('submit', e => {
    e.preventDefault();
    const cur = read();
    if (!cur.name) { toast('材料の名前を入れてください'); return; }
    if (num(cur.qty) <= 0) { toast('仕入れの量を入れてください'); return; }
    if (!existing || priceChanged(existing, cur)) cur.updatedAt = today();
    if (existing && priceChanged(existing, cur)) addHistory('material', existing, cur);
    const i = data.materials.findIndex(x => x.id === cur.id);
    if (i >= 0) data.materials[i] = cur; else data.materials.push(cur);
    save();
    toast('保存しました');
    showTab('materials');
  });

  const del = form.querySelector('#del');
  if (del) del.onclick = () => {
    const users = usedBy('ingredients', m.id);
    if (users.length) { alert(`「${users.join('」「')}」で使っているので消せません。先に商品から外してください。`); return; }
    if (!confirm(`「${m.name}」を消しますか？`)) return;
    data.materials = data.materials.filter(x => x.id !== m.id);
    save();
    showTab('materials');
  };
}

function editPackaging(id) {
  const existing = data.packaging.find(x => x.id === id);
  const x = existing ? { ...existing } : { id: newId(), name: '', price: '' };

  setHeader(existing ? '包装・資材を直す' : '包装・資材を追加', () => showTab('materials'));
  markTab('materials');
  window.scrollTo(0, 0);

  main.innerHTML = `
    <form id="kform" class="card" autocomplete="off">
      <div class="field">
        <label>名前</label>
        <input name="name" value="${esc(x.name)}" placeholder="例：瓶・フタ、ラベル、送料" required>
      </div>
      <div class="field">
        <label>1つあたりの値段（税込）</label>
        <div class="inline"><input name="price" type="number" inputmode="decimal" value="${esc(x.price)}" placeholder="120"><span class="unit">円</span></div>
        ${existing ? tryButtonsHtml() : ''}
      </div>
      <div id="impact"></div>
      <button type="submit" class="btn primary">保存する</button>
      ${existing ? `<button type="button" class="btn danger" id="del">これを消す</button>` : ''}
    </form>
    ${existing ? itemHistoryHtml(x.id) : ''}`;

  const form = main.querySelector('#kform');
  const readPkg = () => ({ ...x, name: form.elements.name.value.trim(), price: form.elements.price.value });
  if (existing) {
    const refresh = () => {
      const cur = readPkg();
      form.querySelector('#impact').innerHTML = impactHtml(impactOf('packaging', existing, cur), priceChanged(existing, cur));
    };
    form.addEventListener('input', refresh);
    wireTryButtons(form, num(existing.price), refresh);
  }
  form.addEventListener('submit', e => {
    e.preventDefault();
    const cur = readPkg();
    if (!cur.name) { toast('名前を入れてください'); return; }
    if (existing && priceChanged(existing, cur)) addHistory('packaging', existing, cur);
    const i = data.packaging.findIndex(k => k.id === cur.id);
    if (i >= 0) data.packaging[i] = cur; else data.packaging.push(cur);
    save();
    toast('保存しました');
    showTab('materials');
  });

  const del = form.querySelector('#del');
  if (del) del.onclick = () => {
    const users = usedBy('packaging', x.id);
    if (users.length) { alert(`「${users.join('」「')}」で使っているので消せません。先に商品から外してください。`); return; }
    if (!confirm(`「${x.name}」を消しますか？`)) return;
    data.packaging = data.packaging.filter(k => k.id !== x.id);
    save();
    showTab('materials');
  };
}

// ---------- 値上がりチェックと変更履歴（ステップ4） ----------

// 値段（仕入れの量・単位も含む）が変わったか
function priceChanged(before, after) {
  return num(before.price) !== num(after.price) || num(before.qty) !== num(after.qty) || (before.unit || '') !== (after.unit || '');
}

// 「もし値段がこうなったら」：材料（包装）を一時的に入れかえて、全商品の原価を計算し直してくらべる
// 肥料 → 農園の果実の原価 → カフェへの卸値 → カフェのメニュー のような、間接的な影響も入る
function impactOf(listName, before, after) {
  const list = data[listName];
  const i = list.findIndex(x => x.id === before.id);
  if (i < 0) return [];
  const costsBefore = data.products.map(p => calcCost(p).total);
  list[i] = after;
  let costsAfter;
  try { costsAfter = data.products.map(p => calcCost(p).total); } finally { list[i] = before; }
  return data.products
    .map((p, k) => ({ p, before: costsBefore[k], after: costsAfter[k] }))
    .filter(r => Math.abs(r.after - r.before) >= 0.005);
}

function impactHtml(rows, changed) {
  if (!changed) return '';
  if (!rows.length) return `<div class="impact"><div class="sub">この値段を使っている商品はまだありません</div></div>`;
  return `<div class="impact">
    <div class="impact-title">⚠️ この値段にすると…（まだ保存していません）</div>
    ${rows.map(({ p, before, after }) => {
      const diff = Math.round(after) - Math.round(before);  // 表示している金額どうしの差にそろえる
      const price = num(p.price);
      const rateB = price > 0 ? (price - before) / price * 100 : null;
      const rateA = price > 0 ? (price - after) / price * 100 : null;
      return `<div class="impact-row">
        <div class="row"><b>${esc(p.name)}</b><span class="${diff > 0 ? 'minus' : 'plus'}">${diff > 0 ? '+' : ''}${yen(diff)}（${diff > 0 ? '+' : ''}${(diff / before * 100).toFixed(1)}%）</span></div>
        <div class="row sub"><span>原価 ${yen(before)} → <b>${yen(after)}</b></span>
          <span>${rateA !== null ? `利益率 ${rateB.toFixed(0)}% → <b class="${profitClass(price - after, rateA)}">${rateA.toFixed(0)}%</b>` : '売値 未定'}</span></div>
      </div>`;
    }).join('')}
  </div>`;
}

// 「＋5%」などのボタンで、仕入れ値をためしに上げてみる
function tryButtonsHtml() {
  return `<div class="try">ためしに：
    <button type="button" data-pct="5">＋5%</button><button type="button" data-pct="10">＋10%</button>
    <button type="button" data-pct="20">＋20%</button><button type="button" data-pct="0">元に戻す</button></div>`;
}
function wireTryButtons(form, basePrice, refresh) {
  form.querySelectorAll('.try button').forEach(b => b.onclick = () => {
    form.elements.price.value = Math.round(basePrice * (1 + num(b.dataset.pct) / 100));
    refresh();
  });
}

function addHistory(kind, before, after) {
  data.priceHistory.push({
    id: newId(), kind, itemId: before.id, name: after.name, date: today(),
    oldPrice: num(before.price), newPrice: num(after.price),
    oldQty: before.qty ?? 1, newQty: after.qty ?? 1, oldUnit: before.unit || '個', newUnit: after.unit || '個',
  });
}

// 1g（1個）あたりで、何%変わったか
function historyRate(h) {
  const per = (price, qty, unit) => { const a = num(qty) * (UNITS[unit] || UNITS['個']).factor; return a > 0 ? num(price) / a : 0; };
  const o = per(h.oldPrice, h.oldQty, h.oldUnit), n = per(h.newPrice, h.newQty, h.newUnit);
  return o > 0 ? (n - o) / o * 100 : 0;
}
function historyText(h, side) {
  const price = yen(side === 'old' ? h.oldPrice : h.newPrice);
  if (h.kind === 'packaging') return `1つ ${price}`;
  return side === 'old' ? `${num(h.oldQty)}${esc(h.oldUnit)} ${price}` : `${num(h.newQty)}${esc(h.newUnit)} ${price}`;
}
function rateBadge(h) {
  const r = historyRate(h);
  if (Math.abs(r) < 0.05) return '';
  return `<span class="${r > 0 ? 'minus' : 'plus'}">${r > 0 ? '▲' : '▼'}${Math.abs(r).toFixed(1)}%</span>`;
}

// 一覧に出す「前回から▲10%」
function lastChangeHtml(itemId) {
  const h = [...data.priceHistory].reverse().find(x => x.itemId === itemId);
  return h && rateBadge(h) ? `・前回から${rateBadge(h)}` : '';
}

function historyRowsHtml(list, showName) {
  return list.slice().reverse().map(h => `
    <div class="hist-row">
      <div class="row"><span class="sub" style="margin:0">${esc(h.date)}</span>${rateBadge(h)}</div>
      ${showName ? `<div class="name" style="font-size:15px">${esc(h.name)}</div>` : ''}
      <div>${historyText(h, 'old')} → <b>${historyText(h, 'new')}</b></div>
    </div>`).join('');
}

function itemHistoryHtml(itemId) {
  const list = data.priceHistory.filter(h => h.itemId === itemId);
  return `<h2>値段の変更履歴</h2><div class="card">${list.length ? historyRowsHtml(list, false) : '<div class="sub" style="margin:0">まだ変更はありません</div>'}</div>`;
}

function renderHistory() {
  setHeader('値段の変更履歴', () => showTab('materials'));
  liveView = renderHistory;
  markTab('materials');
  window.scrollTo(0, 0);
  main.innerHTML = data.priceHistory.length
    ? `<div class="card">${historyRowsHtml(data.priceHistory, true)}</div>`
    : `<div class="empty">まだ変更はありません。<br>材料や包装の値段を直して保存すると、ここに記録されます。</div>`;
}

// ---------- 2人で共有（ステップ5） ----------
// データの置き場所は Googleスプレッドシート（gas/Code.gs）。合言葉で守る。
// 直したところだけを送り、送れなかった分はスマホが覚えておいて、あとで送り直す。

const SYNC_KEY = 'genka-sync';        // { key: 合言葉, lastSync }
const PENDING_KEY = 'genka-pending';  // まだ送れていない変更 { "materials:id": op }
const SNAP_KEY = 'genka-snap';        // 最後に送った（受け取った）ときの中身 { "materials:id": JSON }
const COLS = ['materials', 'packaging', 'products', 'priceHistory'];

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 書けなくても動く */ }
}

let syncConf = readJson(SYNC_KEY, {});
let syncState = '';   // '' | 'busy' | 'ok' | 'error' | 'wrong-key'
let syncRunning = false;
let syncAgain = false;

function isConnected() { return !!(window.GENKA_SYNC_URL && syncConf.key); }

// データを「種類:id → 1件」の形にばらす（設定は id が 'settings' の1件）
function records(d) {
  const out = {};
  for (const col of COLS) for (const rec of d[col] || []) out[`${col}:${rec.id}`] = { col, rec };
  out['settings:settings'] = { col: 'settings', rec: { id: 'settings', ...d.settings } };
  return out;
}

// 前回から変わったところを「まだ送れていない変更」に足す
function queueChanges() {
  const cur = records(data);
  const snap = readJson(SNAP_KEY, {});
  const pending = readJson(PENDING_KEY, {});
  const newSnap = {};
  for (const [k, { col, rec }] of Object.entries(cur)) {
    const json = JSON.stringify(rec);
    newSnap[k] = json;
    if (snap[k] !== json) pending[k] = { col, op: 'put', rec };
  }
  for (const k of Object.keys(snap)) {
    if (!cur[k]) pending[k] = { col: k.split(':')[0], op: 'del', id: k.slice(k.indexOf(':') + 1) };
  }
  writeJson(SNAP_KEY, newSnap);
  writeJson(PENDING_KEY, pending);
}

function pendingCount() { return Object.keys(readJson(PENDING_KEY, {})).length; }

// スプレッドシートの表で見やすいように、商品の原価・利益率・卸値も送る
function productViews() {
  return data.products.map(p => {
    const c = calcCost(p);
    const r = profitOf(p, c);
    return {
      id: p.id, cost: Math.round(c.total), price: r ? r.price : '',
      rate: r ? `${r.rate.toFixed(1)}%` : '', wholesale: p.wholesale && p.group !== 'cafe' ? wholesalePrice(p) : '',
    };
  });
}

async function callServer(body) {
  const res = await fetch(window.GENKA_SYNC_URL, { method: 'POST', body: JSON.stringify({ key: syncConf.key, ...body }) });
  return res.json();
}

// 変更を送って、最新のデータを受け取る（変更がなければ受け取るだけ）
async function syncNow() {
  if (!isConnected()) return;
  if (syncRunning) { syncAgain = true; return; }
  syncRunning = true;
  setSyncState('busy');
  try {
    const pending = readJson(PENDING_KEY, {});
    const sent = Object.entries(pending);
    const res = await callServer({ action: 'apply', ops: sent.map(([, op]) => op), productViews: sent.length ? productViews() : [] });
    if (!res.ok) { setSyncState(res.error === 'wrong-key' ? 'wrong-key' : 'error'); return; }
    // 送っているあいだに、さらに直したものは残しておく
    const now = readJson(PENDING_KEY, {});
    for (const [k, op] of sent) if (JSON.stringify(now[k]) === JSON.stringify(op)) delete now[k];
    writeJson(PENDING_KEY, now);
    applyServerData(res.data);
    syncConf.lastSync = new Date().toISOString();
    writeJson(SYNC_KEY, syncConf);
    setSyncState(Object.keys(now).length ? 'error' : 'ok');
  } catch (e) {
    setSyncState('error');  // 電波が悪いときなど。変更は覚えているので、あとで送り直す
  } finally {
    syncRunning = false;
    if (syncAgain) { syncAgain = false; syncNow(); }
  }
}

// 受け取ったデータに、まだ送れていない自分の変更を重ねて、画面に反映する
function applyServerData(server, force) {
  const d = {
    settings: { ...DEFAULT_SETTINGS },
    materials: server.materials || [], packaging: server.packaging || [],
    products: server.products || [], priceHistory: server.priceHistory || [],
  };
  const st = (server.settings || [])[0];
  if (st) { const { id, ...rest } = st; d.settings = { ...DEFAULT_SETTINGS, ...rest }; }

  for (const op of Object.values(readJson(PENDING_KEY, {}))) {
    if (op.col === 'settings') { if (op.op === 'put') { const { id, ...rest } = op.rec; d.settings = rest; } continue; }
    const list = d[op.col];
    const id = op.op === 'put' ? op.rec.id : op.id;
    const i = list.findIndex(x => x.id === id);
    if (op.op === 'del') { if (i >= 0) list.splice(i, 1); }
    else if (i >= 0) list[i] = op.rec; else list.push(op.rec);
  }
  migrateToBatchAmounts(d);

  const snap = {};
  for (const [k, { rec }] of Object.entries(records(d))) snap[k] = JSON.stringify(rec);
  writeJson(SNAP_KEY, snap);

  if (!force && JSON.stringify(d) === JSON.stringify(data)) return;
  data = d;
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
  if (liveView) liveView();
}

function setSyncState(state) {
  syncState = state;
  const el = document.getElementById('syncBadge');
  if (el) {
    const n = pendingCount();
    el.textContent = !isConnected() ? '' : state === 'busy' ? '⏳'
      : state === 'wrong-key' ? '⚠️ 合言葉' : n ? `⚠️ 未送信${n}` : state === 'error' ? '⚠️' : '☁️';
  }
  const card = document.getElementById('shareCard');
  if (card && !card.querySelector('input:focus')) { card.innerHTML = shareCardHtml(); wireShareCard(); }
}

function shareCardHtml() {
  if (!window.GENKA_SYNC_URL) {
    return `<div class="sub" style="margin:0">データはこのスマホの中だけに保存されています。（共有の準備中です）</div>`;
  }
  if (!isConnected()) {
    return `
      <div class="sub" style="margin:0 0 10px">いまはこのスマホの中だけに保存されています。2人で決めた合言葉を入れると、共有のデータにつながります。</div>
      <div class="field"><label>合言葉</label><input id="shareKey" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
        <div class="hint">日本語でも入れられます（iPhoneは「パスワード」の欄だと日本語が打てないため、ふつうの欄にしています）</div></div>
      <button type="button" class="btn primary" id="connect">つなぐ</button>`;
  }
  const n = pendingCount();
  const last = syncConf.lastSync ? new Date(syncConf.lastSync).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  const msg = syncState === 'wrong-key' ? '⚠️ 合言葉が違うようです。いったん「つなぐのをやめる」から入れ直してください'
    : syncState === 'busy' ? '⏳ やりとり中…'
    : n ? `⚠️ まだ送れていない変更が${n}件あります（電波のよいところで「最新にする」を押してください）`
    : syncState === 'error' ? '⚠️ つながりませんでした。電波のよいところで「最新にする」を押してください'
    : '☁️ 共有のデータとそろっています';
  return `
    <div class="sub" style="margin:0">${msg}</div>
    <div class="sub">最後にそろえた時間：${last}</div>
    <button type="button" class="btn primary" id="syncBtn">最新にする</button>
    <button type="button" class="btn danger" id="disconnect">このスマホでつなぐのをやめる</button>`;
}

function wireShareCard() {
  const card = document.getElementById('shareCard');
  if (!card) return;
  const c = card.querySelector('#connect');
  if (c) c.onclick = () => connect(card.querySelector('#shareKey').value.trim());
  const b = card.querySelector('#syncBtn');
  if (b) b.onclick = () => syncNow();
  const d = card.querySelector('#disconnect');
  if (d) d.onclick = () => {
    if (!confirm('このスマホでの共有をやめますか？（共有のデータは消えません。このスマホのデータもそのまま残ります）')) return;
    syncConf = {};
    writeJson(SYNC_KEY, syncConf);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(SNAP_KEY);
    setSyncState('');
  };
}

// はじめてつなぐ：共有のデータが空なら、このスマホのデータを送る。データがあれば、それを受け取る
async function connect(key) {
  if (!key) { toast('合言葉を入れてください'); return; }
  const btn = document.getElementById('connect');
  if (btn) { btn.disabled = true; btn.textContent = 'つないでいます…'; }
  try {
    syncConf = { key };
    const res = await callServer({ action: 'load' });
    if (!res.ok) {
      syncConf = {};
      toast(res.error === 'wrong-key' ? '合言葉が違います' : 'つながりませんでした');
      return;
    }
    const server = res.data;
    const serverEmpty = COLS.every(c => !(server[c] || []).length);
    const localHas = data.products.length || data.materials.length;
    if (!serverEmpty && localHas &&
        !confirm('共有のデータがすでにあります。このスマホのデータは共有のデータに置きかわります（このスマホだけにある分は消えます）。つなぎますか？')) {
      syncConf = {};
      return;
    }
    writeJson(SYNC_KEY, syncConf);
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(SNAP_KEY);
    if (serverEmpty) {
      queueChanges();  // スナップショットが空なので、このスマホの全部が「送る変更」になる
      await syncNow();
      toast('このスマホのデータを共有しました');
    } else {
      applyServerData(server, true);
      syncConf.lastSync = new Date().toISOString();
      writeJson(SYNC_KEY, syncConf);
      setSyncState('ok');
      toast('共有のデータを受け取りました');
    }
  } catch (e) {
    syncConf = {};
    toast('つながりませんでした');
  } finally {
    setSyncState(syncState);
  }
}

// アプリを開いたとき・スマホで画面に戻ってきたときに、最新にする
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
window.addEventListener('online', () => syncNow());

// ---------- 設定 ----------

function renderSettings() {
  setHeader('設定');
  const s = data.settings;
  main.innerHTML = `
    <form id="sform" class="card" autocomplete="off">
      <div class="field">
        <label>時給</label>
        <div class="inline"><input name="hourlyWage" type="number" inputmode="decimal" value="${esc(s.hourlyWage)}"><span class="unit">円</span></div>
        <div class="hint">作業時間の費用の計算に使います</div>
      </div>
      <div class="field">
        <label>目標の利益率</label>
        <div class="inline"><input name="targetMargin" type="number" inputmode="decimal" value="${esc(s.targetMargin)}"><span class="unit">%</span></div>
        <div class="hint">売値の目安 ＝ 原価 ÷（1 − 利益率）。10円単位に切り上げます</div>
      </div>
      <div class="field">
        <label>卸値の上乗せ率</label>
        <div class="inline"><input name="wholesaleMarkup" type="number" inputmode="decimal" value="${esc(s.wholesaleMarkup)}"><span class="unit">%</span></div>
        <div class="hint">農園→カフェの卸値に使います（空欄の卸値は「原価＋この%」）</div>
      </div>
      <button type="submit" class="btn primary">保存する</button>
    </form>
    <h2>2人で共有</h2>
    <div class="card" id="shareCard">${shareCardHtml()}</div>`;

  wireShareCard();
  const form = main.querySelector('#sform');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const margin = num(form.elements.targetMargin.value);
    if (margin >= 100) { toast('利益率は100%より小さくしてください'); return; }
    data.settings = {
      hourlyWage: num(form.elements.hourlyWage.value),
      targetMargin: margin,
      wholesaleMarkup: num(form.elements.wholesaleMarkup.value),
    };
    save();
    toast('保存しました');
  });
}

// ---------- 見本データ（設計書のハスカップジャムの例） ----------

function addSample() {
  const findOrAdd = (list, name, obj) => {
    const found = list.find(x => x.name === name);
    if (found) return found.id;
    const item = { id: newId(), name, ...obj };
    list.push(item);
    return item.id;
  };

  const haskap = findOrAdd(data.materials, 'ハスカップ（加工用）', { use: 'farm', qty: 1, unit: 'kg', price: 1500, supplier: '自家農園', updatedAt: today() });
  const sugar = findOrAdd(data.materials, '砂糖', { use: 'farm', qty: 1, unit: 'kg', price: 300, supplier: '', updatedAt: today() });
  const jar = findOrAdd(data.packaging, '瓶・フタ', { price: 120 });
  const label = findOrAdd(data.packaging, 'ラベル', { price: 20 });

  data.products.push({
    id: newId(), name: 'ハスカップジャム', group: 'processed', unitLabel: '瓶',
    batchCount: 30, laborHours: 3, utilityPerBatch: 600, price: '',
    ingredients: [{ materialId: haskap, amount: 4.5 }, { materialId: sugar, amount: 2.25 }],
    amountsPerBatch: true,
    packaging: [{ packagingId: jar, count: 1 }, { packagingId: label, count: 1 }],
  });
  save();
  toast('見本を入れました（数字は仮です）');
  renderProducts();
}

// 見本：農園の果実（1年間の費用 ÷ 収穫量）→ カフェへ卸す → カフェのメニュー（数字はすべて仮）
function addFarmCafeSample() {
  const mat = (name, obj) => {
    const found = data.materials.find(x => x.name === name && !x.linkedProductId);
    if (found) return found.id;
    const item = { id: newId(), name, supplier: '', updatedAt: today(), ...obj };
    data.materials.push(item);
    return item.id;
  };
  const fert = mat('肥料', { use: 'farm', qty: 20, unit: 'kg', price: 3000 });
  const spray = mat('農薬', { use: 'farm', qty: 1, unit: 'L', price: 4000 });
  const milk = mat('牛乳', { use: 'cafe', qty: 1, unit: 'L', price: 250 });

  const fruit = {
    id: newId(), name: '加工用ハスカップ', group: 'farm', unitLabel: 'kg',
    batchCount: 300, laborHours: 120, utilityPerBatch: 30000, price: '',
    ingredients: [{ materialId: fert, amount: 200 }, { materialId: spray, amount: 5 }],
    packaging: [], amountsPerBatch: true, wholesale: true, wholesalePrice: '',
  };
  data.products.push(fruit);
  save();  // ここでカフェ用の「加工用ハスカップ（農園から）」ができる
  const linked = data.materials.find(m => m.linkedProductId === fruit.id);

  data.products.push({
    id: newId(), name: 'ハスカップパフェ', group: 'cafe', unitLabel: '皿',
    batchCount: 1, laborHours: 0.25, utilityPerBatch: 30, price: 900,
    ingredients: [{ materialId: linked.id, amount: 0.08 }, { materialId: milk, amount: 0.1 }],
    packaging: [], amountsPerBatch: true,
  });
  save();
  toast('見本を入れました（数字は仮です）');
  renderProducts();
}

showTab('products');
setSyncState('');
syncNow();
