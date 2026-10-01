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
      migrateToBatchAmounts(saved);
      return saved;
    }
  } catch (e) { /* 読めなければ空から始める */ }
  return { settings: { ...DEFAULT_SETTINGS }, materials: [], packaging: [], products: [] };
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
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
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

// 材料の「1g（1ml・1個）あたり」の値段
function unitPrice(material) {
  const u = UNITS[material.unit] || UNITS['個'];
  const amount = num(material.qty) * u.factor;
  return amount > 0 ? num(material.price) / amount : 0;
}

// 商品1つあたりの原価の内訳
function calcCost(product) {
  const s = data.settings;
  const batch = num(product.batchCount);

  // 材料は「1回の仕込みで使う量（仕入れと同じ単位）」で入っているので、1回分の材料費をできた数で割る
  let ingredientsBatch = 0;
  for (const line of product.ingredients || []) {
    const m = data.materials.find(x => x.id === line.materialId);
    if (m && num(m.qty) > 0) ingredientsBatch += num(m.price) / num(m.qty) * num(line.amount);
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

function setHeader(title, onBack) {
  titleEl.textContent = title;
  backBtn.hidden = !onBack;
  backBtn.onclick = onBack || null;
}

function showTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
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
    <button class="btn ghost" id="add">＋ 商品を登録する</button>`;

  const seg = main.querySelector('.seg');
  wireSeg(main);
  seg.addEventListener('input', () => { ui.filter = seg.dataset.value; saveUi(); renderProducts(); });
  main.querySelector('#sort').onchange = e => { ui.sort = e.target.value; saveUi(); renderProducts(); };
  main.querySelectorAll('.card[data-id]').forEach(el => el.onclick = () => simulate(el.dataset.id));
  main.querySelector('#add').onclick = () => editProduct(null);
}

// ---------- 値段シミュレーション ----------

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

function editProduct(id) {
  const existing = data.products.find(p => p.id === id);
  const p = existing ? structuredClone(existing) : {
    id: newId(), name: '', group: 'processed', unitLabel: '瓶',
    batchCount: '', laborHours: '', utilityPerBatch: '', price: '',
    ingredients: [], packaging: [], amountsPerBatch: true,
  };

  // 戻るときは、直す前に見ていた値段シミュレーションへ（新しく登録するときは一覧へ）
  setHeader(existing ? '商品を直す' : '商品を登録', () => existing ? simulate(id) : showTab('products'));
  window.scrollTo(0, 0);

  const ingredientOptions = (sel) => `<option value="">材料をえらぶ</option>` +
    data.materials.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  const packagingOptions = (sel) => `<option value="">包装をえらぶ</option>` +
    data.packaging.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');

  const ingLine = (l = {}) => {
    const m = data.materials.find(x => x.id === l.materialId);
    return `<div class="line-item ing">
      <select>${ingredientOptions(l.materialId)}</select>
      <input type="number" inputmode="decimal" placeholder="量" value="${esc(l.amount ?? '')}">
      <span class="unit">${m ? esc(m.unit) : ''}</span>
      <button type="button" class="x" aria-label="消す">×</button>
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

      <h2>1回の仕込み</h2>
      <div class="card">
        <div class="field">
          <label>1回でできる数</label>
          <div class="inline"><input name="batchCount" type="number" inputmode="decimal" value="${esc(p.batchCount)}" placeholder="50"><span class="unit unitLabel">${esc(p.unitLabel)}</span></div>
          <div class="hint">だいたいの数でOKです（例：約50瓶 → 50）</div>
        </div>
        <div class="field">
          <label>作業時間（1回あたり）</label>
          <div class="inline"><input name="laborHours" type="number" inputmode="decimal" step="0.25" value="${esc(p.laborHours)}" placeholder="3"><span class="unit">時間</span></div>
        </div>
        <div class="field">
          <label>光熱費・機械代（1回あたりの目安）</label>
          <div class="inline"><input name="utilityPerBatch" type="number" inputmode="decimal" value="${esc(p.utilityPerBatch)}" placeholder="600"><span class="unit">円</span></div>
        </div>
      </div>

      <h2>使う材料（1回の仕込みで使う量）</h2>
      <div class="card">
        <div id="ings">${p.ingredients.map(ingLine).join('')}</div>
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
      ingredients: [...form.querySelectorAll('.ing')].map(row => ({
        materialId: row.querySelector('select').value,
        amount: row.querySelector('input').value,
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
    // 材料をえらび直したら、量の単位（g・ml・個）も合わせる
    form.querySelectorAll('.ing').forEach(row => {
      const m = data.materials.find(x => x.id === row.querySelector('select').value);
      row.querySelector('.unit').textContent = m ? m.unit : '';
    });
    form.querySelector('#breakdown').innerHTML = breakdownHtml(cur);
  };

  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  form.addEventListener('click', e => {
    if (e.target.classList.contains('x')) { e.target.closest('.line-item').remove(); refresh(); }
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
    if (!confirm(`「${p.name}」を消しますか？`)) return;
    data.products = data.products.filter(x => x.id !== p.id);
    save();
    toast('消しました');
    showTab('products');
  };

  refresh();
}

function breakdownHtml(p) {
  const c = calcCost(p);
  const s = data.settings;
  const per = esc(p.unitLabel || '1つ');
  const batch = c.batch > 0 ? `${c.batch}${per}` : '（できる数が未入力）';

  let html = `<table>
    <tr><td>材料費<span class="how">1回分 ${yen(c.ingredientsBatch)} ÷ ${batch}</span></td><td>${yen(c.ingredients)}</td></tr>
    <tr><td>包装・送料</td><td>${yen(c.packaging)}</td></tr>
    <tr><td>作業時間<span class="how">${num(p.laborHours)}時間 × 時給${yen(s.hourlyWage)} ÷ ${batch}</span></td><td>${yen(c.labor)}</td></tr>
    <tr><td>光熱費・機械代<span class="how">${yen(num(p.utilityPerBatch))} ÷ ${batch}</span></td><td>${yen(c.utility)}</td></tr>
    <tr class="total"><td>原価（1${per}あたり）</td><td>${yen(c.total)}</td></tr>
  </table>
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

  const mats = data.materials.map(m => `
    <button class="card" data-mat="${m.id}">
      <div class="row">
        <div class="name"><span class="badge ${m.use === 'cafe' ? 'cafe' : ''}">${m.use === 'cafe' ? 'カフェ' : '農園'}</span>${esc(m.name)}</div>
        <div class="big">${yenFine(unitPrice(m))}<small style="font-size:12px;color:var(--muted);font-weight:400"> /${baseUnit(m)}</small></div>
      </div>
      <div class="sub">仕入れ：${num(m.qty)}${esc(m.unit)} ${yen(num(m.price))}${m.supplier ? '・' + esc(m.supplier) : ''}・${esc(m.updatedAt)}更新</div>
    </button>`).join('');

  const pkgs = data.packaging.map(x => `
    <button class="card" data-pkg="${x.id}">
      <div class="row">
        <div class="name">${esc(x.name)}</div>
        <div class="big">${yen(num(x.price))}</div>
      </div>
    </button>`).join('');

  main.innerHTML = `
    <h2>材料（1gあたりなどの単価を自動計算）</h2>
    ${mats || '<div class="empty">まだ材料がありません</div>'}
    <button class="btn ghost" id="addMat">＋ 材料を追加</button>
    <h2>包装・資材・送料（1つあたりの値段）</h2>
    ${pkgs || '<div class="empty">まだ包装・資材がありません</div>'}
    <button class="btn ghost" id="addPkg">＋ 包装・資材を追加</button>`;

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
  const m = existing ? { ...existing } : { id: newId(), name: '', use: 'farm', qty: 1, unit: 'kg', price: '', supplier: '' };

  setHeader(existing ? '材料を直す' : '材料を追加', () => showTab('materials'));
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
      </div>
      <div class="field">
        <label>仕入れ先（なくてもOK）</label>
        <input name="supplier" value="${esc(m.supplier)}" placeholder="例：〇〇商店">
      </div>
      <button type="submit" class="btn primary">保存する</button>
      ${existing ? `<button type="button" class="btn danger" id="del">この材料を消す</button>` : ''}
    </form>`;

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
  };
  form.addEventListener('input', refresh);
  form.addEventListener('change', refresh);
  refresh();

  form.addEventListener('submit', e => {
    e.preventDefault();
    const cur = read();
    if (!cur.name) { toast('材料の名前を入れてください'); return; }
    if (num(cur.qty) <= 0) { toast('仕入れの量を入れてください'); return; }
    cur.updatedAt = today();
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
      </div>
      <button type="submit" class="btn primary">保存する</button>
      ${existing ? `<button type="button" class="btn danger" id="del">これを消す</button>` : ''}
    </form>`;

  const form = main.querySelector('#kform');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const cur = { ...x, name: form.elements.name.value.trim(), price: form.elements.price.value };
    if (!cur.name) { toast('名前を入れてください'); return; }
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
        <div class="hint">農園→カフェの卸値に使います（ステップ3で使えるようになります）</div>
      </div>
      <button type="submit" class="btn primary">保存する</button>
    </form>
    <div class="empty" style="font-size:13px">データはこのスマホの中に保存されています。<br>（かえさんとの共有はステップ5で行います）</div>`;

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

showTab('products');
