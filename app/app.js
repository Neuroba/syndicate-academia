/* SYNDICATE Академия — Telegram Mini App.
   Vanilla JS без сборки: файл открывается и с диска, и с GitHub Pages, и в Telegram.
   Данные приходят из data/quiz.js и data/content.js (window.QUIZ / window.CONTENT) —
   через <script>, а не fetch, потому что fetch по file:// блокируется браузером.
   Прогресс — только localStorage. Никакой базы на этом этапе не нужно: один ученик,
   один телефон. Когда появится второй — переносим состояние в Supabase как есть. */

const TG = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
// ?demo=1 — витрина для скриншотов и показа: состояние живёт только в памяти
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const QUIZ = window.QUIZ || { cards: [] };
const CONTENT = window.CONTENT || { lessons: [], spots: [], sheets: {} };
const DRILLS = window.DRILLS || {};
const GLOSSARY = (window.GLOSSARY && window.GLOSSARY.terms) || [];
const DAY_CARDS = 6;

/* Ключ хранения — свой на каждого ученика Telegram. Один и тот же телефон
   может открыть и она, и её партнёр, и тренер на показе: без разделения
   их серии и ошибки складывались бы в одну кучу. Кто вошёл без Telegram
   (браузер, отладка) — общий ключ, как было. */
const TG_USER = (() => {
  try { return (window.Telegram.WebApp.initDataUnsafe.user) || null; } catch (e) { return null; }
})();
const STORE_BASE = 'syndicate.academia.v1';
const STORE = TG_USER && TG_USER.id ? STORE_BASE + '.u' + TG_USER.id : STORE_BASE;

/* ─────────── состояние ─────────── */

/* Дата — по часам телефона, а не по UTC. В Буэнос-Айресе (UTC-3) toISOString()
   переводит день уже в 21:00, и у того, кто тренируется вечером, серия рвалась. */
function ymd(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function today() { return ymd(new Date()); }
function dayShift(n) { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

const defaults = () => ({
  v: 1,
  name: '',
  startedAt: today(),
  lesson: 1,          // текущее (ещё не пройденное) занятие
  done: {},           // id карточки -> {ok, err}
  wrong: [],          // очередь на повтор
  days: [],           // даты завершённых тренировок
  spots: {},          // id спота -> выбранный индекс
  drills: {},         // вид тренажёра -> {n, ok}
  plan: null,         // план дня: {date, mins, done:[номера блоков]}
  srez: null,         // входной срез: {date, res, start}
  bestStreak: 0,
  tgId: null,         // чей это прогресс — видно в профиле
  onboarded: false    // экран входа уже показан и закрыт
});

let S = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) return Object.assign(defaults(), JSON.parse(raw));
    // первый вход под своим Telegram: если на этом телефоне уже был прогресс
    // до разделения по ученикам — забираем его себе, а не начинаем с нуля
    if (STORE !== STORE_BASE) {
      const old = localStorage.getItem(STORE_BASE);
      if (old) return Object.assign(defaults(), JSON.parse(old));
    }
  } catch (e) { /* приватный режим — работаем без сохранения */ }
  return defaults();
}
function save() {
  if (DEMO) return;   // демо-состояние живёт только в памяти, прогресс не трогаем
  try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {}
}

// Серия: считаем непрерывные дни назад от сегодня или от вчера.
// От вчера — чтобы серия не «умирала» до того, как человек успел зайти сегодня.
function streak() {
  if (!S.days.length) return 0;
  const set = new Set(S.days);
  let anchor = today();
  if (!set.has(anchor)) {
    const y = dayShift(-1);
    if (!set.has(y)) return 0;
    anchor = y;
  }
  // шагаем по календарю в полдень: перевод часов не сдвинет дату
  let n = 0, cur = new Date(anchor + 'T12:00:00');
  while (set.has(ymd(cur))) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}
function markDay() {
  const t = today();
  if (!S.days.includes(t)) S.days.push(t);
  const st = streak();
  if (st > S.bestStreak) S.bestStreak = st;
  save();
}
function cardsDone() { return Object.keys(S.done).filter(id => S.done[id].ok > 0).length; }

/* ─────────── роутинг ─────────── */

let stack = [];

function go(name, param) {
  const cur = stack[stack.length - 1];
  if (!cur || cur.name !== name) {
    stack.push({ name, param });
    // своя запись в истории: иначе системная кнопка «назад» уводит с сайта,
    // а обработчик popstate ловить нечего
    try { history.pushState({ screen: name }, ''); } catch (e) {}
  }
  render(name, param);
  if (TG && TG.BackButton) {
    if (stack.length > 1 && name !== 'home') TG.BackButton.show(); else TG.BackButton.hide();
  }
  if (TG && TG.HapticFeedback) TG.HapticFeedback.selectionChanged();
}
// Просьба вернуться (кнопка Telegram). Откат делает history.back() → popstate,
// чтобы своя навигация и история браузера не разъезжались на два шага.
function back() {
  if (stack.length > 1) history.back();
  else if (TG && TG.close) TG.close();
}
function popBack() {
  if (stack.length <= 1) return;
  stack.pop();
  const p = stack[stack.length - 1];
  // Возврат в квиз — продолжение, а не новая тренировка: апп сам зовёт из
  // разбора в шпаргалку, и раньше кнопка «назад» стирала начатые карточки.
  render(p.name, p.name === 'quiz' ? 'keep' : p.param);
  if (TG && TG.BackButton && (stack.length === 1 || p.name === 'home')) TG.BackButton.hide();
}
function show(name) {
  // подсказка по руке живёт вместе со своим экраном, а не висит поверх следующего
  document.querySelectorAll('.pop').forEach(p => p.remove());
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.dataset.screen === name));
  const b = document.querySelector(`.screen[data-screen="${name}"] .body`);
  if (b) b.scrollTop = 0;
}
function render(name, param) {
  show(name);
  const fn = ({
    onboarding: () => {},
    home: renderHome, program: renderProgram, lesson: renderLesson,
    sheets: renderSheets, sheet: renderSheet,
    quiz: renderQuiz, result: renderResult, spot: renderSpot, profile: renderProfile,
    drills: renderDrills, drill: renderDrill, day: renderDay, glossary: renderGlossary,
    srez: renderSrez, srezres: renderSrezRes
  })[name];
  if (fn) fn(param);
}

/* ─────────── главный ─────────── */

/* Пока курс идёт — текущее занятие. После восьмого S.lesson становится 9,
   и тогда «сегодняшняя тема» — последнее занятие, а не первое. */
function currentLesson() {
  return CONTENT.lessons.find(l => l.n === S.lesson)
    || CONTENT.lessons[CONTENT.lessons.length - 1]
    || CONTENT.lessons[0];
}

function pickTodayCards() {
  const pool = QUIZ.cards.filter(c => c.lesson <= Math.max(1, S.lesson));
  const fresh = pool.filter(c => !S.done[c.id] || S.done[c.id].ok === 0);
  const wrong = S.wrong.map(id => QUIZ.cards.find(c => c.id === id)).filter(Boolean);
  const seen = pool.filter(c => S.done[c.id] && S.done[c.id].ok > 0);
  const out = [];
  const push = arr => arr.forEach(c => { if (out.length < DAY_CARDS && !out.includes(c)) out.push(c); });
  push(wrong); push(fresh); push(seen);
  return out;
}

function renderHome() {
  const l = currentLesson();
  const st = streak();
  document.getElementById('h-streak').textContent = st;
  document.getElementById('h-lesson').textContent = `${Math.min(S.lesson, 8)} / 8`;
  document.getElementById('h-prog-go').textContent = `${S.lesson - 1} / 8`;

  const cards = pickTodayCards();
  const doneToday = S.days.includes(today());
  document.getElementById('h-task').innerHTML = doneToday
    ? 'Тренировка<br><em>на сегодня сделана</em>'
    : `${cards.length === DAY_CARDS ? 'Шесть карточек' : cards.length + ' ' + plural(cards.length, 'карточка', 'карточки', 'карточек')}<br><em>по теме «${l.topic}»</em>`;
  document.getElementById('h-taskd').textContent = doneToday
    ? `Серия ${st} ${plural(st, 'день', 'дня', 'дней')}. Возвращайся завтра — карточки обновятся.`
    : 'Пять минут. Держит в голове то, что разобрали на занятии, — до следующей встречи.';

  // Полоса и подпись считаются от одной базы — открытых карточек. Раньше подпись
  // делилась на все 24, а полоса — на открытые, и она стояла на 100% при «18 / 24».
  const openCards = QUIZ.cards.filter(c => c.lesson <= S.lesson);
  const openDone = openCards.filter(c => S.done[c.id] && S.done[c.id].ok > 0).length;
  const pct = Math.round(openDone / (openCards.length || 1) * 100);
  document.getElementById('h-next').textContent = Math.min(S.lesson + 1, 8);
  document.getElementById('h-left').innerHTML = `пройдено <b>${openDone} / ${openCards.length}</b> карточек`;
  document.getElementById('h-bar').style.width = Math.min(100, pct) + '%';
  document.getElementById('h-quiz-sub').textContent = `${QUIZ.cards.length} карточек · ${cardsDone()} пройдено`;
  document.getElementById('h-quiz-go').textContent = doneToday ? 'ещё раз' : cards.length + ' новых';

  const sp = todaySpot();
  document.getElementById('h-spot-sub').textContent = sp
    ? `${sp.board.length ? sp.board.map(c => c.r + c.s).join(' ') : 'префлоп'} — твоё решение?`
    : 'скоро';
  document.getElementById('h-spot-go').textContent = sp && S.spots[sp.id] != null ? 'решён' : 'новый';

  const dn = Object.values(S.drills || {}).reduce((a, d) => a + (d.n || 0), 0);
  const dok = Object.values(S.drills || {}).reduce((a, d) => a + (d.ok || 0), 0);
  document.getElementById('h-dr-sub').textContent = dn
    ? `решено ${dn} · верно ${Math.round(dok / dn * 100)}%`
    : 'считать и запоминать · без конца';
  document.getElementById('h-dr-go').textContent = dn ? 'ещё' : '4 вида';

  const main = document.getElementById('h-main');
  const pl = S.plan && S.plan.date === today() ? S.plan : null;
  const total = planBlocks(pl ? pl.mins : 20).length;
  main.textContent = !pl || !pl.done.length ? 'Начать занятие дня'
    : pl.done.length >= total ? 'Занятие дня закрыто · повторить'
    : `Продолжить · блок ${pl.done.length + 1} из ${total}`;
}
function plural(n, a, b, c) {
  const m = n % 100, d = n % 10;
  if (m > 10 && m < 20) return c;
  if (d === 1) return a;
  if (d >= 2 && d <= 4) return b;
  return c;
}

/* ─────────── программа и занятие ─────────── */

function renderProgram() {
  document.getElementById('pr-sub').textContent =
    `8 занятий · ${S.lesson - 1} пройдено · сейчас занятие ${Math.min(S.lesson, 8)}`;
  document.getElementById('pr-bar').style.width = ((S.lesson - 1) / 8 * 100) + '%';
  const box = document.getElementById('pr-list');
  box.innerHTML = '';
  CONTENT.lessons.forEach(l => {
    const state = l.n < S.lesson ? 'done' : (l.n === S.lesson ? 'now' : 'lock');
    const b = document.createElement('button');
    b.className = 'ls ' + state;
    b.innerHTML = `<span class="n">${state === 'done' ? '✓' : l.n}</span>
      <span class="t">${l.title}</span>
      <span class="st">${state === 'done' ? 'пройдено' : state === 'now' ? 'сейчас' : '—'}</span>`;
    b.onclick = () => go('lesson', l.n);
    box.appendChild(b);
  });
  const main = document.getElementById('pr-main');
  main.textContent = `Открыть занятие ${Math.min(S.lesson, 8)}`;
  main.onclick = () => go('lesson', Math.min(S.lesson, 8));
}

function renderLesson(n) {
  const l = CONTENT.lessons.find(x => x.n === n) || currentLesson();
  document.getElementById('ls-kick').textContent =
    `занятие ${l.n} · ${l.n < S.lesson ? 'пройдено' : l.n === S.lesson ? 'текущее' : 'впереди'}`;
  document.getElementById('ls-title').textContent = l.title;
  document.getElementById('ls-about').innerHTML = l.about.map(t => `<li>${t}</li>`).join('');

  const mat = document.getElementById('ls-mat');
  mat.innerHTML = '';
  if (l.sheet && CONTENT.sheets[l.sheet]) {
    const s = CONTENT.sheets[l.sheet];
    const d = document.createElement('button');
    d.className = 'mt';
    d.innerHTML = `<div class="mi">▦</div><div class="mn">${s.title}</div><div class="md">шпаргалка</div>`;
    d.onclick = () => go('sheet', l.sheet);
    mat.appendChild(d);
  }
  const q = document.createElement('button');
  q.className = 'mt';
  const cnt = QUIZ.cards.filter(c => c.lesson === l.n).length;
  q.innerHTML = `<div class="mi">◈</div><div class="mn">${cnt} ${plural(cnt, 'карточка', 'карточки', 'карточек')}</div>
    <div class="md">${l.n <= S.lesson ? 'доступны' : 'откроются после занятия'}</div>`;
  if (l.n <= S.lesson) q.onclick = () => go('quiz');
  mat.appendChild(q);

  const hw = document.getElementById('ls-hw');
  hw.innerHTML = `Домашка: <b>${l.homework}</b>`;
  if (l.n === S.lesson) {
    const btn = document.createElement('button');
    btn.className = 'markdone';
    btn.textContent = 'Отметить занятие пройденным →';
    btn.onclick = () => {
      if (S.lesson <= 8) { S.lesson++; save(); }
      go('program');
    };
    hw.appendChild(btn);
  }

  const main = document.getElementById('ls-main');
  if (l.sheet && CONTENT.sheets[l.sheet]) {
    main.textContent = 'Открыть шпаргалку';
    main.onclick = () => go('sheet', l.sheet);
  } else {
    main.textContent = 'Карточки по теме';
    main.onclick = () => go('quiz');
  }
}

/* ─────────── шпаргалки ─────────── */

/* Порядок задаётся здесь, но список берётся из данных: добавил шпаргалку в
   content.json — она появится в аппе, даже если про неё тут не написано. */
const SHEET_ORDER_HINT = ['starting', 'odds', 'pushfold', 'ranks'];
const SHEET_HINT = {
  starting: 'что открывать с позиции',
  odds: 'когда колл плюсовой',
  pushfold: 'короткий стек в турнире',
  ranks: 'что бьёт что'
};
function sheetKeys() {
  const all = Object.keys(CONTENT.sheets || {});
  const known = SHEET_ORDER_HINT.filter(k => all.includes(k));
  return known.concat(all.filter(k => !known.includes(k)));
}

function renderSheets() {
  const box = document.getElementById('sh-list');
  box.innerHTML = '';
  sheetKeys().forEach(key => {
    const s = CONTENT.sheets[key];
    if (!s) return;
    const b = document.createElement('button');
    b.className = 'sh';
    const prev = key === 'starting'
      ? `<span class="prev mini">${miniCells()}</span>`
      : `<span class="prev">${key === 'odds' ? '%' : key === 'pushfold' ? 'BB' : '♠'}</span>`;
    b.innerHTML = `${prev}<span class="tx"><span class="tt">${s.title}</span>
      <span class="ts">${SHEET_HINT[key] || s.sub || ''}</span></span><span class="ar">›</span>`;
    b.onclick = () => go('sheet', key);
    box.appendChild(b);
  });
  // Словарь — та же шпаргалка, только по словам. Отдельного пункта на главной
  // ему не нужно: человек идёт «посмотреть, что значит» туда же, куда за чартом.
  const g = document.createElement('button');
  g.className = 'sh';
  g.innerHTML = `<span class="prev">Аа</span><span class="tx"><span class="tt">Словарь</span>
    <span class="ts">${GLOSSARY.length} слов с объяснением и примером</span></span><span class="ar">›</span>`;
  g.onclick = () => go('glossary');
  box.appendChild(g);
}
function miniCells() {
  // мини-превью матрицы: те же три зоны, 4×4
  const map = ['g','g','g','','g','g','f','','g','f','f','','','','','f'];
  return map.map(c => `<i class="${c}"></i>`).join('');
}

function renderSheet(key) {
  const s = CONTENT.sheets[key];
  if (!s) return;
  document.getElementById('s-title').textContent = s.title;
  document.getElementById('s-sub').textContent = s.sub;
  document.getElementById('s-note').textContent = s.note || '';
  const box = document.getElementById('s-content');
  box.innerHTML = '';
  if (s.type === 'matrix') box.appendChild(buildMatrix(s));
  if (s.type === 'table') buildTable(box, s);
  if (s.type === 'list') buildRanks(box, s);
}

/* Матрица 169 рук. Зоны берутся из data/content.json (sheets.starting.zones) —
   они перенесены один в один с печатной шпаргалки курса, которая у ученика на
   руках. Правится там же, кодом ничего считать не нужно. */
const R = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
function handLabel(i, j) {
  return i === j ? R[i] + R[i] : (i < j ? R[i] + R[j] + 's' : R[j] + R[i] + 'o');
}
function zoneOf(i, j) {
  const z = (CONTENT.sheets.starting || {}).zones || {};
  const h = handLabel(i, j);
  if ((z.z1 || []).includes(h)) return 'z1';
  if ((z.z2 || []).includes(h)) return 'z2';
  return 'z3';
}
const ZONE_TEXT = {
  z1: { n: 'Играем всегда', d: 'С любой позиции, включая раннюю. Это ядро диапазона — с такими руками ты открываешь банк рейзом, а не коллом.' },
  z2: { n: 'С поздней позиции', d: 'Кнопка, катофф или дешёвый вход. Из ранней позиции пас: рука играбельная, но не сильная — постфлоп без позиции ей тяжело.' },
  z3: { n: 'Пас', d: 'В базовом курсе не входим: без позиции такие руки чаще создают проблемы, чем банк. Опытные игроки часть из них добавляют с кнопки — но это уже следующий уровень.' }
};
function buildMatrix(s) {
  const wrap = document.createElement('div');
  const lg = document.createElement('div');
  lg.className = 'legend';
  lg.innerHTML = (s.legend || []).map(l => `<span class="lg"><i class="${l.z}"></i>${l.t}</span>`).join('');
  wrap.appendChild(lg);
  const m = document.createElement('div');
  m.className = 'matrix';
  for (let i = 0; i < 13; i++) for (let j = 0; j < 13; j++) {
    const z = zoneOf(i, j);
    const label = handLabel(i, j);
    const c = document.createElement('div');
    c.className = 'cell ' + z + (i === j ? ' pairmark' : '');
    c.textContent = label;
    c.onclick = () => popup(label, z);
    m.appendChild(c);
  }
  wrap.appendChild(m);
  return wrap;
}
function popup(hand, z) {
  document.querySelectorAll('.pop').forEach(p => p.remove());
  const t = ZONE_TEXT[z];
  const p = document.createElement('div');
  p.className = 'pop';
  p.innerHTML = `<div class="ph"><span class="hand">${hand}</span><span class="zn ${z}">${t.n}</span></div>
    <div class="pt">${t.d}</div>`;
  p.onclick = () => p.remove();
  document.body.appendChild(p);
  setTimeout(() => p.remove(), 5200);
  if (TG && TG.HapticFeedback) TG.HapticFeedback.impactOccurred('light');
}

function buildTable(box, s) {
  const t = document.createElement('table');
  t.innerHTML = `<thead><tr>${s.head.map(h => `<th>${h}</th>`).join('')}</tr></thead>`;
  const tb = document.createElement('tbody');
  s.rows.forEach(r => {
    const hi = r[r.length - 1] === true;
    const cells = r.slice(0, -1);
    const tr = document.createElement('tr');
    if (hi) tr.className = 'hi';
    tr.innerHTML = cells.map((c, i) => {
      if (c === '') return '';
      const span = (cells.length < s.head.length && i === cells.length - 1) ? ' colspan="2"' : '';
      return i === 0 ? `<td class="n">${c}</td>` : `<td${span}><b>${c}</b></td>`;
    }).join('');
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  box.appendChild(t);
  (s.rules || []).forEach(r => {
    const d = document.createElement('div');
    d.className = 'rulebox' + (r.ok ? ' ok' : '');
    d.innerHTML = `<b>${r.t}.</b> ${r.d}`;
    box.appendChild(d);
  });
}
function buildRanks(box, s) {
  const w = document.createElement('div');
  w.className = 'ranks';
  s.items.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'rk';
    d.innerHTML = `<span class="num">${i + 1}</span><span><span class="rn">${it.n}</span>
      <span class="rd">${it.d}</span></span><span class="ex">${it.ex}</span>`;
    w.appendChild(d);
  });
  box.appendChild(w);
}

/* ─────────── квиз ─────────── */

let Q = { list: [], i: 0, ok: 0, sel: null, answered: false, missed: [], order: [] };

/* Варианты в данных лежат правильным ответом первым — показывать их в этом
   порядке нельзя, ученик за две тренировки заметит и начнёт жать первую кнопку.
   Порядок перемешан, но не случаен: он выводится из номера карточки и даты,
   поэтому не «прыгает» при перерисовке экрана и меняется на следующий день. */
function optionOrder(card) {
  const n = card.options.length;
  const order = Array.from({ length: n }, (_, k) => k);
  const t = today();
  let s = (card.id * 2654435761 + Number(t.slice(0, 4) + t.slice(5, 7) + t.slice(8, 10))) >>> 0;
  const rnd = () => {           // xorshift32: младшие биты у него честные
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s;
  };
  rnd(); rnd();                 // прогреть, иначе соседние id дают похожий порядок
  for (let k = n - 1; k > 0; k--) {
    const j = rnd() % (k + 1);
    const tmp = order[k]; order[k] = order[j]; order[j] = tmp;
  }
  return order;
}

function renderQuiz(restart) {
  // Начатую тренировку не обнуляем ни возвратом «назад», ни повторным заходом
  // с другого экрана: новая колода набирается только когда прошлая доиграна.
  const inProgress = Q.list.length > 0 && Q.i < Q.list.length;
  if (!inProgress && restart !== 'keep') {
    Q = { list: pickTodayCards(), i: 0, ok: 0, sel: null, answered: false, missed: [], order: [] };
  }
  if (!Q.list.length) { go('home'); return; }
  paintCard();
}

function paintCard() {
  const c = Q.list[Q.i];
  const lesson = CONTENT.lessons.find(l => l.n === c.lesson);
  document.getElementById('q-bar').style.width = ((Q.i) / Q.list.length * 100) + '%';
  document.getElementById('q-n').textContent = `${Q.i + 1} / ${Q.list.length}`;
  document.getElementById('q-lb').textContent = `занятие ${c.lesson} · ${c.topic}`;
  document.getElementById('q-q').innerHTML = highlight(c.q);
  const why = document.getElementById('q-why');
  why.hidden = true; why.innerHTML = '';

  const box = document.getElementById('q-answers');
  box.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D', 'E'];
  Q.order = optionOrder(c);
  Q.order.forEach((src, pos) => {
    const b = document.createElement('button');
    b.className = 'ans';
    b.innerHTML = `<span class="m">${letters[pos]}</span><span>${c.options[src]}</span>`;
    b.onclick = () => selectAnswer(src, b);
    box.appendChild(b);
  });

  Q.sel = null; Q.answered = false;
  const main = document.getElementById('q-main');
  main.textContent = 'Выбери ответ';
  main.disabled = true;
  main.onclick = onQuizMain;
}
function highlight(t) {
  return t.replace(/\$\d+(?:[.,]\d+)?/g, m => `<span class="hl">${m}</span>`);
}
function selectAnswer(idx, el) {
  if (Q.answered) return;
  Q.sel = idx;
  document.querySelectorAll('#q-answers .ans').forEach(a => a.classList.remove('sel'));
  el.classList.add('sel');
  const main = document.getElementById('q-main');
  main.disabled = false;
  main.textContent = 'Ответить';
}
function onQuizMain() {
  if (!Q.answered) { checkAnswer(); return; }
  Q.i++;
  if (Q.i >= Q.list.length) finishQuiz(); else paintCard();
}
function checkAnswer() {
  const c = Q.list[Q.i];
  Q.answered = true;
  const nodes = document.querySelectorAll('#q-answers .ans');
  nodes.forEach((a, pos) => {
    const src = Q.order[pos];   // кнопка на экране → её вариант в данных
    a.classList.remove('sel');
    if (src === c.correct) a.classList.add('right');
    else if (src === Q.sel) a.classList.add('wrong');
  });

  const good = Q.sel === c.correct;
  if (good) Q.ok++; else Q.missed.push(c);

  const rec = S.done[c.id] || { ok: 0, err: 0 };
  if (good) { rec.ok++; S.wrong = S.wrong.filter(id => id !== c.id); }
  else { rec.err++; if (!S.wrong.includes(c.id)) S.wrong.push(c.id); }
  S.done[c.id] = rec;
  save();

  const why = document.getElementById('q-why');
  why.hidden = false;
  why.innerHTML = `<b>${good ? 'Верно.' : 'Не так.'}</b> ${c.why}`;
  if (c.sheet && CONTENT.sheets[c.sheet]) {
    const a = document.createElement('button');
    a.className = 'lnk';
    a.textContent = `Шпаргалка: ${CONTENT.sheets[c.sheet].title} →`;
    a.onclick = () => go('sheet', c.sheet);
    why.appendChild(a);
  }
  if (TG && TG.HapticFeedback) TG.HapticFeedback.notificationOccurred(good ? 'success' : 'warning');

  const main = document.getElementById('q-main');
  main.textContent = Q.i + 1 >= Q.list.length ? 'Итог' : 'Дальше';
}
function finishQuiz() {
  markDay();
  if (finishBlock()) return;   // шли по плану дня — возвращаемся в него
  go('result');
}

function renderResult() {
  document.getElementById('r-score').innerHTML = `${Q.ok}<i> / ${Q.list.length}</i>`;
  const st = streak();
  document.getElementById('r-streak').textContent = `♠ ${st} ${plural(st, 'день', 'дня', 'дней')} подряд`;
  document.getElementById('r-streakd').textContent =
    `Серия сохранена. Лучшая — ${S.bestStreak} ${plural(S.bestStreak, 'день', 'дня', 'дней')}.`;

  const redo = document.getElementById('r-redo');
  const link = document.getElementById('r-redol');
  if (Q.missed.length) {
    redo.hidden = false;
    document.getElementById('r-redoq').textContent = '«' + Q.missed[0].q + '»';
    const sheet = Q.missed[0].sheet;
    if (sheet && CONTENT.sheets[sheet]) {
      link.hidden = false;
      link.textContent = `Повторить: ${CONTENT.sheets[sheet].title} →`;
      link.onclick = () => go('sheet', sheet);
    } else link.hidden = true;
  } else {
    redo.hidden = true;
  }

  const left = QUIZ.cards.length - cardsDone();
  document.getElementById('r-next').innerHTML = left > 0
    ? `Осталось <b>${left}</b> ${plural(left, 'карточка', 'карточки', 'карточек')} из курса`
    : 'Все карточки курса пройдены. Дальше — только повторение.';
}

/* ─────────── спот дня ─────────── */

function todaySpot() {
  const list = CONTENT.spots || [];
  if (!list.length) return null;
  const idx = Math.abs(daysBetween(S.startedAt, today())) % list.length;
  return list[idx];
}
function cardHtml(c) {
  const red = c.s === '♥' || c.s === '♦';
  return `<div class="pcard${red ? ' red' : ''}"><div class="r">${c.r}</div><div class="s">${c.s}</div></div>`;
}
function renderSpot() {
  const sp = todaySpot();
  if (!sp) { go('home'); return; }
  document.getElementById('sp-k').textContent = `спот ${sp.id}`;
  document.getElementById('sp-t').textContent = sp.position;
  // Схема стола: где сидишь ты и как называются остальные места.
  // Одинаковая во всех разделах — ученик привыкает к одной картинке.
  const felt = document.getElementById('sp-felt');
  if (felt) { felt.innerHTML = sp.seat ? tableHtml(sp.seat) : ''; bindSeats(felt); }
  document.getElementById('sp-board').innerHTML = sp.board.length
    ? sp.board.map(cardHtml).join('')
    : '<div class="sp-k" style="padding:18px 0">префлоп — общих карт ещё нет</div>';
  document.getElementById('sp-hand').innerHTML = sp.hand.map(cardHtml).join('');
  const need = Math.round(sp.bet / (sp.pot + sp.bet * 2) * 100);
  document.getElementById('sp-pots').innerHTML =
    `<div class="pot"><div class="pl">банк</div><div class="pv">$${sp.pot}</div></div>
     <div class="pot"><div class="pl">ставка</div><div class="pv">$${sp.bet}</div></div>
     <div class="pot"><div class="pl">твой стек</div><div class="pv">$${sp.stack}</div></div>`;

  const acts = document.getElementById('sp-acts');
  acts.innerHTML = '';
  const already = S.spots[sp.id];
  sp.actions.forEach((a, idx) => {
    const b = document.createElement('button');
    b.className = 'act';
    const hint = (idx === 1 && sp.bet) ? `<span class="pctl">нужно ${need}%</span>` : '';
    b.innerHTML = `<span>${a}</span>${hint}`;
    b.onclick = () => answerSpot(sp, idx);
    acts.appendChild(b);
  });
  const foot = document.getElementById('sp-foot');
  const main = document.getElementById('sp-main');
  if (already != null) {
    paintSpotResult(sp, already);
  } else {
    foot.textContent = 'Выбери решение — увидишь разбор.';
    main.disabled = true; main.textContent = 'Выбери решение';
  }
}
function answerSpot(sp, idx) {
  if (PLAN.active != null && S.spots[sp.id] != null) { markDay(); finishBlock(); return; }
  S.spots[sp.id] = idx; save();
  paintSpotResult(sp, idx);
  if (TG && TG.HapticFeedback) TG.HapticFeedback.notificationOccurred(idx === sp.best ? 'success' : 'warning');
}
function paintSpotResult(sp, idx) {
  const nodes = document.querySelectorAll('#sp-acts .act');
  nodes.forEach((n, i) => {
    n.classList.remove('sel');
    if (i === sp.best) n.classList.add('good');
    else if (i === idx) n.classList.add('bad');
  });
  document.getElementById('sp-foot').innerHTML =
    `<b>${idx === sp.best ? 'Так и есть.' : 'Спорно.'}</b> ${sp.why}`;
  const main = document.getElementById('sp-main');
  main.disabled = false;
  main.textContent = 'На главную';
  main.onclick = () => go('home');
}

/* ─────────── входной срез ───────────

   Первое, что человек делает в приложении. Не экзамен — калибровка: тринадцать
   задач из пяти областей, чтобы понять, с какого занятия начинать и где дыры.
   Проходится вместе с тренером на первой встрече, поэтому короткий.

   Формулировки нарочно мягкие: новичок, который решит, что его проверяют,
   начнёт угадывать вместо того, чтобы честно сказать «не знаю». */

const SREZ_AREAS = [
  { id: 'ranks', name: 'Комбинации', need: 'что бьёт что', lesson: 1, n: 3 },
  { id: 'starting', name: 'Стартовые руки', need: 'что играть с какой позиции', lesson: 3, n: 3 },
  { id: 'outs', name: 'Ауты', need: 'сколько карт спасёт', lesson: 4, n: 2 },
  { id: 'potodds', name: 'Цена колла', need: 'платить или уйти', lesson: 4, n: 2 },
  { id: 'quiz', name: 'Правила и позиции', need: 'как устроена игра', lesson: 2, n: 3 }
];

let SZ = null;

function srezBuild() {
  const items = [];
  SREZ_AREAS.forEach(a => {
    if (a.id === 'quiz') {
      // по одной карточке из разных занятий: начало, середина, дальше
      [1, 2, 5].forEach(ls => {
        const pool = QUIZ.cards.filter(c => c.lesson === ls);
        if (pool.length) items.push({ area: a.id, kind: 'card', it: pool[Math.floor(Math.random() * pool.length)] });
      });
    } else {
      const pool = shuffled(drillPool(a.id)).slice(0, a.n);
      pool.forEach(it => items.push({ area: a.id, kind: 'drill', it }));
    }
  });
  return items;
}

function renderSrez() {
  const box = document.getElementById('sz-areas');
  box.innerHTML = SREZ_AREAS.map(a =>
    `<div class="sza"><span class="n">${a.n}</span>
     <span class="tx"><span class="tt">${a.name}</span><span class="ts">${a.need}</span></span></div>`).join('');
  document.getElementById('sz-main').onclick = () => {
    SZ = { list: srezBuild(), i: 0, res: {}, sel: null, answered: false };
    SREZ_AREAS.forEach(a => { SZ.res[a.id] = { ok: 0, n: 0 }; });
    go('drill', '__srez__');
  };
}

/* Карточка квиза внутри среза: тот же вид, что у тренажёров, чтобы человек
   не переключался между двумя разными экранами посреди калибровки. */
function srezView(step) {
  if (step.kind === 'drill') {
    const v = DRILL_VIEW[step.area](step.it);
    return { ...v, why: step.it.why };
  }
  const c = step.it;
  const order = optionOrder(c);
  return {
    q: c.q,
    stage: '',
    acts: order.map(src => c.options[src]),
    grid: false,
    right: order.indexOf(c.correct),
    why: c.why
  };
}

function srezAnswer(good) {
  const a = SZ.res[SZ.list[SZ.i].area];
  a.n++; if (good) a.ok++;
}

function srezFinish() {
  const level = srezLevel();
  S.srez = { date: today(), res: SZ.res, knows: level.knows };
  // Занятие НЕ перематываем. Курс рассчитан с нуля и идёт по порядку для всех:
  // срез — знакомство и карта дыр для тренера, а не распределение по уровням.
  save();
  stack = [{ name: 'home' }, { name: 'srezres' }];
  render('srezres');
}

/* Считаем по областям, а не общим процентом: человек может знать комбинации
   и не уметь считать — это разные дыры. Нужно ТРЕНЕРУ, чтобы знать, где
   притормозить, а не ученику, чтобы куда-то перепрыгнуть. */
function srezLevel() {
  const pct = id => { const r = SZ.res[id]; return r && r.n ? r.ok / r.n : 0; };
  const weak = SREZ_AREAS.filter(a => pct(a.id) < 0.67);
  const knows = SREZ_AREAS.filter(a => pct(a.id) >= 0.67).map(a => a.id);
  return { weak, knows, pct };
}

function renderSrezRes() {
  const { weak, knows, pct } = srezLevel();
  const total = Object.values(SZ.res).reduce((a, r) => a + r.ok, 0);
  const all = Object.values(SZ.res).reduce((a, r) => a + r.n, 0);

  document.getElementById('sr-h1').textContent =
    knows.length >= 4 ? 'Кое-что уже знаешь' : knows.length >= 2 ? 'Что-то знакомо'
      : 'Всё впереди';
  document.getElementById('sr-sub').textContent =
    `${total} из ${all} верно. Это не оценка и не экзамен — просто знакомство.`;

  document.getElementById('sr-bars').innerHTML = SREZ_AREAS.map(a => {
    const p = Math.round(pct(a.id) * 100);
    const cls = p >= 67 ? 'ok' : p >= 34 ? 'mid' : 'low';
    const word = p >= 67 ? 'уверенно' : p >= 34 ? 'шатко' : 'ещё нет';
    return `<div class="szb"><div class="l"><span>${a.name}</span><span class="${cls}">${word}</span></div>
      <div class="b"><i class="${cls}" style="width:${Math.max(p, 4)}%"></i></div></div>`;
  }).join('');

  const l1 = (CONTENT.lessons.find(l => l.n === 1) || {}).title || '';
  const v = document.getElementById('sr-verdict');
  v.innerHTML = '<div class="bt">что дальше</div>' +
    `<div class="szv">Занятие <b>1</b> — ${l1}</div>` +
    '<div class="szw">Курс идёт по порядку для всех: он и рассчитан с нуля, ' +
    'перепрыгивать через занятия мы не будем. ' +
    (weak.length
      ? `На чём притормозим отдельно: ${weak.map(w => w.name.toLowerCase()).join(', ')}. ` +
        'Тренажёры по этим темам уже открыты, они не кончаются.'
      : 'Знакомое повторим быстро и пойдём дальше.') + '</div>';

  document.getElementById('sr-note').textContent =
    'Срез можно пройти заново в любой момент — из профиля.';
  document.getElementById('sr-main').onclick = () => go('day');
}

/* ─────────── словарь ───────────

   Открывается посреди раздачи: услышала слово, не поняла, нашла. Поэтому
   список не бесконечный — сразу показываем ходовые три десятка, остальные
   семь десятков достаются поиском. Длинный список на телефоне не листают. */

let GL_OPEN = null;
let GL_SHOWN = 0;          // сколько слов уже открыто кнопкой «показать ещё»
const GL_STEP = 20;

/* Вес совпадения: само слово важнее упоминания в чужом примере.
   Иначе «лимп» первым находит «изолирующий рейз», где лимпер только упомянут. */
function glRank(t, q) {
  const term = t.term.toLowerCase(), en = (t.en || '').toLowerCase();
  if (term === q) return 0;
  if (term.startsWith(q)) return 1;
  if (en.startsWith(q)) return 2;
  if (term.includes(q)) return 3;
  if ((t.also || '').toLowerCase().includes(q)) return 4;
  if (en.includes(q)) return 5;
  if ((t.short || '').toLowerCase().includes(q)) return 6;
  return 99;
}
function glMatch(t, q) { return glRank(t, q) < 99; }

function renderGlossary() {
  const inp = document.getElementById('gl-q');
  const box = document.getElementById('gl-list');
  const draw = () => {
    const q = (inp.value || '').trim().toLowerCase();
    const core = GLOSSARY.filter(t => t.core);
    const rest = GLOSSARY.filter(t => !t.core);
    const list = q
      ? GLOSSARY.filter(t => glMatch(t, q))
          .sort((a, b) => glRank(a, q) - glRank(b, q) || a.term.localeCompare(b.term))
      : core.concat(rest.slice(0, GL_SHOWN));
    document.getElementById('gl-sub').textContent = q
      ? `нашлось ${list.length} ${plural(list.length, 'слово', 'слова', 'слов')}`
      : 'Услышала слово и не поняла — найди его здесь.';
    const restLeft = GLOSSARY.filter(t => !t.core).length - GL_SHOWN;
    document.getElementById('gl-note').textContent = q ? ''
      : restLeft > 0 ? `Показаны ходовые. Ещё ${restLeft} — кнопкой ниже или поиском.`
      : `Все ${GLOSSARY.length} слов открыты.`;
    const more = document.getElementById('gl-more');
    if (more) {
      more.hidden = !!q || restLeft <= 0;
      more.textContent = `Показать ещё ${Math.min(GL_STEP, restLeft)}`;
      more.onclick = () => { GL_SHOWN += GL_STEP; draw(); };
    }
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<div class="glnone">Ничего не нашлось. Попробуй часть слова или английское написание.</div>';
      return;
    }
    list.forEach(t => {
      const el = document.createElement('button');
      el.className = 'gl' + (GL_OPEN === t.id ? ' open' : '');
      el.innerHTML = `<div class="gh"><span class="gt">${t.term}</span>` +
        (t.en ? `<span class="ge">${t.en}</span>` : '') + '</div>' +
        `<div class="gs">${t.short}</div>` +
        (GL_OPEN === t.id ? `<div class="gf">${t.full}</div>` +
          (t.also ? `<div class="ga">ещё говорят: ${t.also}</div>` : '') +
          (t.trap ? `<div class="gtrap"><b>Частая ошибка.</b> ${t.trap}</div>` : '') +
          `<div class="ga">разбираем на занятии ${t.lesson}</div>` : '');
      el.onclick = () => { GL_OPEN = GL_OPEN === t.id ? null : t.id; draw(); };
      box.appendChild(el);
    });
  };
  inp.oninput = draw;
  draw();
}

/* ─────────── план дня ───────────

   Меню — это витрина: ученик открывает её и не знает, с чего начать. План ведёт
   за руку: блок за блоком, по порядку, с показанным временем. Ровно это нужно
   и на занятии, когда тренер рассказывает, а ученики решают в моменте.

   Состав зависит от того, докуда дошёл курс: тренажёр на ауты бессмысленно
   давать до четвёртого занятия, там ещё не объясняли, что такое аут. */

const PLAN_MINS = [20, 40, 60];

/* Блок ≈ 30 секунд на вопрос. Числа подобраны так, чтобы сумма попадала
   в выбранное время, а не «примерно около». */
function planBlocks(mins) {
  const L = S.lesson;
  const avail = [
    { kind: 'drill', id: 'ranks', name: 'Комбинации', sub: 'что сильнее', from: 1, n: 8, min: 4 },
    { kind: 'quiz', name: 'Карточки дня', sub: 'по теме занятия', from: 1, n: DAY_CARDS, min: 5 },
    { kind: 'drill', id: 'starting', name: 'Стартовые руки', sub: 'играть или пас', from: 3, n: 10, min: 5 },
    { kind: 'spot', name: 'Спот дня', sub: 'разбор раздачи', from: 1, n: 1, min: 3 },
    { kind: 'drill', id: 'outs', name: 'Ауты', sub: 'сколько карт спасёт', from: 4, n: 8, min: 4 },
    { kind: 'drill', id: 'potodds', name: 'Цена колла', sub: 'платить или уйти', from: 4, n: 8, min: 4 },
    { kind: 'drill', id: 'ranks', name: 'Комбинации ещё', sub: 'на скорость', from: 1, n: 12, min: 6 },
    { kind: 'drill', id: 'starting', name: 'Руки ещё', sub: 'закрепляем чарт', from: 3, n: 14, min: 7 },
    { kind: 'drill', id: 'potodds', name: 'Счёт ещё', sub: 'пока не станет автоматом', from: 4, n: 12, min: 6 }
  ].filter(b => b.from <= L && (b.kind !== 'drill' || drillPool(b.id).length));

  const out = [];
  let left = mins;
  for (const b of avail) {
    if (b.min <= left + 1) { out.push(b); left -= b.min; }
    if (left <= 1) break;
  }
  return out;
}

let PLAN = { active: null };

function planState() {
  const t = today();
  if (!S.plan || S.plan.date !== t) S.plan = { date: t, mins: 20, done: [] };
  return S.plan;
}

function renderDay() {
  const st = planState();
  const blocks = planBlocks(st.mins);
  document.getElementById('dy-h1').textContent =
    st.mins === 20 ? 'Двадцать минут' : st.mins === 40 ? 'Сорок минут' : 'Час работы';
  document.getElementById('dy-kick').textContent =
    st.done.length ? `сделано ${st.done.length} из ${blocks.length}` : 'план на сегодня';

  const mbox = document.getElementById('dy-mins');
  mbox.innerHTML = '';
  PLAN_MINS.forEach(m => {
    const b = document.createElement('button');
    b.className = 'mn' + (m === st.mins ? ' on' : '');
    b.textContent = m + ' мин';
    b.onclick = () => { st.mins = m; st.done = []; save(); renderDay(); };
    mbox.appendChild(b);
  });

  const box = document.getElementById('dy-list');
  box.innerHTML = '';
  blocks.forEach((b, i) => {
    const done = st.done.includes(i);
    const next = !done && !blocks.some((_, k) => k < i && !st.done.includes(k));
    const el = document.createElement('button');
    el.className = 'pb' + (done ? ' done' : next ? ' now' : '');
    el.innerHTML = `<span class="pn">${done ? '✓' : i + 1}</span>
      <span class="tx"><span class="tt">${b.name}</span><span class="ts">${b.sub} · ${b.n} ${b.kind === 'spot' ? 'раздача' : plural(b.n, 'вопрос', 'вопроса', 'вопросов')}</span></span>
      <span class="pm">${b.min} мин</span>`;
    el.onclick = () => startBlock(i);
    box.appendChild(el);
  });

  const all = st.done.length >= blocks.length;
  document.getElementById('dy-note').textContent = all
    ? 'План на сегодня закрыт. Можно продолжать в тренажёрах — они не кончаются.'
    : 'Можно останавливаться между блоками: план запомнит, где ты.';
  const main = document.getElementById('dy-main');
  main.textContent = all ? 'Открыть тренажёры' : st.done.length ? 'Продолжить' : 'Начать';
  main.onclick = () => {
    if (all) { go('drills'); return; }
    const i = blocks.findIndex((_, k) => !st.done.includes(k));
    startBlock(i < 0 ? 0 : i);
  };
}

function startBlock(i) {
  const st = planState();
  const b = planBlocks(st.mins)[i];
  if (!b) return;
  PLAN.active = i;
  if (b.kind === 'quiz') { Q = { list: [], i: 0, ok: 0, sel: null, answered: false, missed: [], order: [] }; go('quiz'); }
  else if (b.kind === 'spot') go('spot');
  else { D = { kind: null }; go('drill', b.id); D.limit = b.n; }
}

/* Блок закрыт — отмечаем и возвращаем в план. Возврат именно сюда, а не «назад»:
   иначе после квиза ученик оказывался на главной и терял нить. */
function finishBlock() {
  if (PLAN.active == null) return false;
  const st = planState();
  if (!st.done.includes(PLAN.active)) st.done.push(PLAN.active);
  PLAN.active = null;
  save();
  stack = [{ name: 'home' }, { name: 'day' }];
  render('day');
  return true;
}

/* ─────────── тренажёры ───────────

   Отдельно от квиза: квиз — это шесть карточек в день по теме занятия, а здесь
   бесконечная отработка одного навыка. Ради этого их и открывают прямо на уроке.

   Ответы в drills.json не написаны руками, а вычислены сборщиком build-drills.py:
   руки сравнивает оценщик семи карт, ауты пересчитаны перебором колоды, цена
   колла — формулой. Поэтому здесь нет поля «правильный ответ по мнению автора». */

const DRILL_KINDS = [
  { id: 'ranks', icon: '♠', badge: '', name: 'Что сильнее',
    sub: 'две руки на одном борде — чья лучше', skill: 'запоминать' },
  { id: 'starting', icon: '▦', badge: 'b2', name: 'Играть или пас',
    sub: 'позиция и две карты — открываем?', skill: 'запоминать' },
  { id: 'outs', icon: '◷', badge: 'b3', name: 'Считай ауты',
    sub: 'сколько карт тебя спасёт', skill: 'считать' },
  { id: 'potodds', icon: '◈', badge: 'b5', name: 'Цена колла',
    sub: 'банк, ставка — платить или уйти', skill: 'считать' }
];

let D = { kind: null, item: null, pool: [], n: 0, ok: 0, sel: null, answered: false };

function drillPool(kind) {
  return (DRILLS && DRILLS[kind]) || [];
}

function renderDrills() {
  const box = document.getElementById('dr-list');
  box.innerHTML = '';
  DRILL_KINDS.forEach(k => {
    const pool = drillPool(k.id);
    const st = S.drills[k.id] || { n: 0, ok: 0 };
    const b = document.createElement('button');
    b.className = 'it';
    b.disabled = !pool.length;
    b.innerHTML = `<span class="badge ${k.badge}">${k.icon}</span>
      <span class="tx"><span class="tt">${k.name}</span>
      <span class="ts">${k.sub}</span></span>
      <span class="go">${st.n ? st.ok + ' / ' + st.n : 'начать'}</span>`;
    b.onclick = () => go('drill', k.id);
    box.appendChild(b);
  });
  const total = DRILL_KINDS.reduce((a, k) => a + drillPool(k.id).length, 0);
  document.getElementById('dr-sub').textContent =
    `${total} ${plural(total, 'задача', 'задачи', 'задач')} · повторяются по кругу. ` +
    'Можно решать на занятии вместе с тренером.';
}

/* Порядок задач перемешан один раз на заход, дальше идём по кругу: одна и та же
   задача не должна выпасть дважды подряд, но и «кончиться» тренажёр не может. */
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function renderDrill(kind) {
  if (kind === '__srez__') {          // режим входного среза: свой список, свой финал
    if (!SZ) { go('srez'); return; }
    D = { kind: '__srez__', item: SZ.list[SZ.i], sel: null, answered: false, n: SZ.i, ok: 0 };
    paintDrill();
    return;
  }
  if (kind && kind !== D.kind) {
    const pool = drillPool(kind);
    if (!pool.length) { go('drills'); return; }
    D = { kind, item: null, pool: shuffled(pool), n: 0, ok: 0, sel: null, answered: false };
  }
  if (!D.kind) { go('drills'); return; }
  if (!D.item) nextDrill();
  paintDrill();
}

function nextDrill() {
  if (!D.pool.length) D.pool = shuffled(drillPool(D.kind));
  D.item = D.pool.pop();
  D.sel = null; D.answered = false;
}

function pc(c) {
  const red = c.s === '♥' || c.s === '♦';
  return `<div class="pcard${red ? ' red' : ''}"><div class="r">${c.r === 'T' ? '10' : c.r}</div><div class="s">${c.s}</div></div>`;
}
function boardHtml(cards, cls) {
  return `<div class="board${cls ? ' ' + cls : ''}">${cards.map(pc).join('')}</div>`;
}

/* Каждый тренажёр описывает себя сам: вопрос, что показать, какие кнопки
   и какой из них верный. Дальше механика общая — выбрал, проверил, следующая. */
/* Схема стола: где ты сидишь. Словами «ты на лоджеке» новичку не сказать
   ничего — нужно место, подсвеченное на картинке, и рядом его имя. */
const SEATS = [
  { id: 'UTG', x: 22, y: 6 }, { id: 'UTG+1', x: 50, y: 0 }, { id: 'LJ', x: 78, y: 6 },
  { id: 'HJ', x: 97, y: 46 }, { id: 'CO', x: 84, y: 90 }, { id: 'BTN', x: 50, y: 100 },
  { id: 'SB', x: 16, y: 90 }, { id: 'BB', x: 3, y: 46 }
];
/* Место на схеме -> слово в словаре. Ткнул в «LJ» — получил «лоджек»
   и объяснение: три буквы сами по себе новичку не говорят ничего. */
const SEAT_TERM = {
  'UTG': 'UTG', 'UTG+1': 'ранняя позиция', 'LJ': 'лоджек', 'HJ': 'хайджек',
  'CO': 'катофф', 'BTN': 'кнопка', 'SB': 'малый блайнд', 'BB': 'большой блайнд'
};

function tableHtml(active) {
  const dots = SEATS.map(s => {
    const on = s.id === active ? ' on' : '';
    const bl = (s.id === 'SB' || s.id === 'BB') ? ' bl' : '';
    return `<span class="sd${on}${bl}" data-seat="${s.id}" style="left:${s.x}%;top:${s.y}%">${s.id}</span>`;
  }).join('');
  return `<div class="minifelt">${dots}</div>
    <div class="felthint">Жми по любому месту — покажу, как оно называется</div>
    <div class="seatpop" id="seatpop" hidden></div>`;
}

/* Подсказка по месту — прямо на экране, без ухода в словарь: ученик посреди
   задачи не должен терять раздачу, чтобы узнать значение трёх букв. */
function bindSeats(root) {
  (root || document).querySelectorAll('.sd[data-seat]').forEach(el => {
    el.onclick = ev => {
      ev.stopPropagation();
      const code = el.dataset.seat;
      const name = SEAT_TERM[code];
      const g = GLOSSARY.find(x => x.term.toLowerCase() === (name || '').toLowerCase());
      const pop = document.getElementById('seatpop');
      if (!pop) return;
      if (!g) { pop.hidden = true; return; }
      pop.hidden = false;
      pop.innerHTML = `<div class="sp-h"><b>${code}</b> — ${g.term}` +
        (g.en ? `<span class="sp-en">${g.en}</span>` : '') + '</div>' +
        `<div class="sp-d">${g.short}</div>`;
    };
  });
}

const OUTS_OPTS = [2, 4, 6, 8, 9, 15];

const DRILL_VIEW = {
  ranks: it => ({
    q: 'Чья рука сильнее? Жми по руке',
    stage: boardHtml(it.board) + '<div class="bl">общие карты</div>' +
      `<div class="duo tap">
        <div class="side" data-pick="0"><div class="sl">первая</div>${boardHtml(it.a)}</div>
        <div class="side" data-pick="1"><div class="sl">вторая</div>${boardHtml(it.b)}</div>
      </div>`,
    tapStage: true,
    right: it.winner
  }),
  starting: it => ({
    q: 'Открываем эту руку?',
    stage: tableHtml(it.seat) +
      `<div class="dr-pos">${it.pos} · ${it.seat}</div>` +
      boardHtml(it.hand, 'mine'),
    acts: ['Пас', 'Открываем рейзом'],
    right: it.answer
  }),
  outs: it => ({
    q: 'Сколько у тебя аутов?',
    stage: boardHtml(it.board) + '<div class="bl">флоп</div>' +
      boardHtml(it.hand, 'mine') + '<div class="mine-lbl">твоя рука</div>',
    acts: OUTS_OPTS.map(String), grid: true,
    right: OUTS_OPTS.indexOf(it.outs)
  }),
  potodds: it => ({
    q: 'Платить эту ставку?',
    stage: boardHtml(it.board) + '<div class="bl">флоп</div>' +
      boardHtml(it.hand, 'mine') + '<div class="mine-lbl">твоя рука</div>' +
      `<div class="potrow">
        <div class="pot"><div class="pl">в банке</div><div class="pv">$${it.pot}</div></div>
        <div class="pot"><div class="pl">он поставил</div><div class="pv">$${it.bet}</div></div>
      </div>`,
    acts: ['Пас', `Колл $${it.bet}`],
    right: it.answer
  })
};

/* Полоса «сколько нужно против того, сколько есть» — цифра 29% против 35%
   ничего не говорит, пока не увидишь эти два куска рядом. */
function oddsBar(it) {
  return `<div class="obar">
    <div class="ol"><span>нужно ${it.need}%</span><span>у тебя ${it.equity}%</span></div>
    <div class="ob"><i class="need" style="width:${it.need}%"></i>
      <i class="have" style="width:${it.equity}%"></i></div>
  </div>`;
}

/* Показать сами карты-ауты: «девять» превращается из числа в девять карт,
   которые видно. Это и есть ответ на вопрос «на что мне смотреть». */
function outsHtml(it) {
  if (!it.outCards || !it.outCards.length) return '';
  return `<div class="outs"><div class="bl">вот они, ${it.outCards.length} — считать надо их</div>
    <div class="orow">${it.outCards.map(pc).join('')}</div></div>`;
}

function drillView() {
  return D.kind === '__srez__' ? srezView(SZ.list[SZ.i]) : DRILL_VIEW[D.kind](D.item);
}

function paintDrill() {
  const v = drillView();
  const sr = D.kind === '__srez__';
  const kind = sr ? { name: 'срез' } : DRILL_KINDS.find(k => k.id === D.kind);
  document.getElementById('dk-name').textContent = kind.name;
  document.getElementById('dk-score').textContent = sr
    ? `${SZ.i + 1} / ${SZ.list.length}` : `${D.ok} / ${D.n}`;
  document.getElementById('dk-q').textContent = v.q;
  document.getElementById('dk-stage').innerHTML = v.stage || '';
  bindSeats(document.getElementById('dk-stage'));

  const box = document.getElementById('dk-acts');
  box.className = v.tapStage ? 'acts hidden' : (v.grid ? 'grid4' : 'acts');
  box.innerHTML = '';
  if (v.tapStage) {
    // ответ — сама карта, а не кнопка внизу: тянуться через весь экран неудобно
    document.querySelectorAll('#dk-stage [data-pick]').forEach(el => {
      el.onclick = () => pickDrill(+el.dataset.pick, el);
    });
  } else {
    v.acts.forEach((txt, i) => {
      const b = document.createElement('button');
      b.className = 'act';
      b.innerHTML = `<span>${txt}</span>`;
      b.onclick = () => pickDrill(i, b);
      box.appendChild(b);
    });
  }

  document.getElementById('dk-why').innerHTML = 'Выбери ответ.';
  const main = document.getElementById('dk-main');
  main.textContent = 'Выбери ответ';
  main.disabled = true;
  main.onclick = onDrillMain;
}

function pickDrill(i, el) {
  if (D.answered) return;
  D.sel = i;
  document.querySelectorAll('#dk-acts .act, #dk-stage [data-pick]')
    .forEach(a => a.classList.remove('sel'));
  el.classList.add('sel');
  const main = document.getElementById('dk-main');
  main.disabled = false;
  main.textContent = 'Ответить';
}

function onDrillMain() {
  if (!D.answered) { checkDrill(); return; }
  nextDrill();
  paintDrill();
}

function checkDrill() {
  const sr = D.kind === '__srez__';
  const it = sr ? SZ.list[SZ.i].it : D.item;
  const v = drillView();
  D.answered = true;
  const good = D.sel === v.right;
  if (sr) { srezAnswer(good); } else { D.n++; if (good) D.ok++; }

  document.querySelectorAll('#dk-acts .act, #dk-stage [data-pick]').forEach(a => {
    const i = a.dataset.pick != null ? +a.dataset.pick
      : [...a.parentNode.children].indexOf(a);
    a.classList.remove('sel');
    if (i === v.right) a.classList.add('good');
    else if (i === D.sel) a.classList.add('bad');
  });

  // Показать, НА ЧТО смотреть: сами карты-ауты и полосу «нужно против есть».
  // Без этого «девять аутов» и «29%» остаются числами из воздуха.
  const extra = [];
  if (D.kind === 'potodds') extra.push(oddsBar(it));
  if (it.outCards) extra.push(outsHtml(it));
  if (extra.length) {
    const box = document.createElement('div');
    box.className = 'dk-extra';
    box.innerHTML = extra.join('');
    document.getElementById('dk-stage').appendChild(box);
  }

  if (!sr) {
    const st = S.drills[D.kind] || { n: 0, ok: 0 };
    st.n++; if (good) st.ok++;
    S.drills[D.kind] = st;
    save();
    document.getElementById('dk-score').textContent = `${D.ok} / ${D.n}`;
  }
  document.getElementById('dk-why').innerHTML =
    `<b>${good ? 'Верно.' : 'Не так.'}</b> ${v.why || it.why || ''}`;
  if (TG && TG.HapticFeedback) TG.HapticFeedback.notificationOccurred(good ? 'success' : 'warning');

  const main = document.getElementById('dk-main');
  if (sr) {
    const fin = SZ.i + 1 >= SZ.list.length;
    main.textContent = fin ? 'Показать итог' : 'Дальше';
    main.onclick = () => { if (fin) { srezFinish(); return; } SZ.i++; renderDrill('__srez__'); };
    return;
  }
  const last = D.limit && D.n >= D.limit;
  main.textContent = last ? 'Блок закрыт' : 'Следующая';
  if (last) main.onclick = () => { markDay(); if (!finishBlock()) go('drills'); };
}

/* ─────────── профиль ─────────── */

function renderProfile() {
  const st = streak();
  document.getElementById('p-name').textContent = S.name || 'Ученик';
  document.getElementById('p-av').textContent = (S.name || 'У').trim().charAt(0).toUpperCase();
  document.getElementById('p-since').textContent = 'в Академии с ' + human(S.startedAt);
  document.getElementById('p-streak').textContent = '♠ ' + st;
  document.getElementById('p-lesson').textContent = `${S.lesson - 1} / 8`;
  document.getElementById('p-cards').textContent = `${cardsDone()} / ${QUIZ.cards.length}`;

  const heat = document.getElementById('p-heat');
  heat.innerHTML = '';
  for (let i = 13; i >= 0; i--) {
    const d = dayShift(-i);
    const i2 = document.createElement('i');
    if (S.days.includes(d)) i2.className = 'on';
    heat.appendChild(i2);
  }

  // Тренажёры появились после квиза, и профиль их не считал — а решают в них
  // теперь больше, чем в карточках. Показываем разбивку по видам.
  const drow = DRILL_KINDS.map(k => {
    const d = S.drills[k.id];
    if (!d || !d.n) return '';
    return `<div class="dst"><span class="t">${k.name}</span>
      <span class="v">${d.ok} / ${d.n}</span>
      <span class="p">${Math.round(d.ok / d.n * 100)}%</span></div>`;
  }).filter(Boolean).join('');
  const dbox = document.getElementById('p-drills');
  if (dbox) {
    const any = drow.length > 0;
    dbox.innerHTML = any
      ? '<div class="bt">тренажёры</div>' + drow
      : '<div class="bt">тренажёры</div><div class="dst none">пока не открывала — там считают и запоминают</div>';
  }

  const total = QUIZ.cards.length || 24;
  const miles = [
    { t: 'Первая неделя без пропусков', got: S.bestStreak >= 7, pr: `${Math.min(S.bestStreak, 7)} / 7` },
    { t: 'Половина карточек курса', got: cardsDone() >= total / 2, pr: `${cardsDone()} / ${Math.ceil(total / 2)}` },
    { t: 'Знаю все стартовые руки', got: cardsDone() >= total, pr: `${cardsDone()} / ${total}` },
    { t: 'Курс пройден · мини-турнир', got: S.lesson > 8, pr: `${S.lesson - 1} / 8` }
  ];
  const box = document.getElementById('p-mile');
  box.innerHTML = miles.map(m => `<div class="ml${m.got ? ' got' : ''}">
      <span class="mk">${m.got ? '✓' : '♠'}</span><span class="t">${m.t}</span>
      <span class="pr">${m.got ? '' : m.pr}</span></div>`).join('');
}
function human(iso) {
  const M = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  // «2026-07-25» без времени парсится как UTC-полночь — в Аргентине это ещё
  // вчерашний день, поэтому дата в профиле уезжала на сутки назад
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${M[d.getMonth()]}`;
}

/* ─────────── запуск ─────────── */

function init() {
  if (TG) {
    TG.ready();
    if (TG.expand) TG.expand();
    if (TG.setHeaderColor) { try { TG.setHeaderColor('#0b0b0d'); } catch (e) {} }
    // фон под аппом — тоже чёрный, иначе при оверскролле видна светлая полоса
    if (TG.setBackgroundColor) { try { TG.setBackgroundColor('#0b0b0d'); } catch (e) {} }
    // без этого свайп вниз внутри списка сворачивает Mini App на полуслове
    if (TG.disableVerticalSwipes) { try { TG.disableVerticalSwipes(); } catch (e) {} }
    if (TG.BackButton) TG.BackButton.onClick(back);
    if (TG_USER) {
      if (TG_USER.first_name && !S.name) S.name = TG_USER.first_name;
      if (!S.tgId) S.tgId = TG_USER.id;
      save();
    }
  }

  document.querySelectorAll('[data-go]').forEach(el => {
    el.addEventListener('click', () => {
      if (!S.onboarded) { S.onboarded = true; save(); }
      go(el.dataset.go);
    });
  });
  const sz = document.getElementById('p-srez');
  if (sz) sz.onclick = () => go('srez');
  document.getElementById('p-reset').onclick = () => {
    if (confirm('Сбросить весь прогресс: серию, карточки и занятия?')) {
      S = defaults();
      if (TG && TG.initDataUnsafe && TG.initDataUnsafe.user) S.name = TG.initDataUnsafe.user.first_name || '';
      save(); go('home');
    }
  };
  document.getElementById('ob-hi').textContent = S.name ? `${S.name}, добро пожаловать` : 'Добро пожаловать';

  // Отладка без телефона: ?screen=quiz откроет нужный экран, ?demo=1 наполнит
  // состояние (в памяти, без записи), чтобы экраны не выглядели пустыми.
  const url = new URLSearchParams(location.search);
  if (DEMO) {
    S.name = S.name || 'Сергей';
    S.lesson = 4;
    S.startedAt = dayShift(-12);
    // считаем от вчера, чтобы на главной было видно задание на сегодня, а не «сделано»
    S.days = [1, 2, 3, 4, 5, 6].map(i => dayShift(-i));
    S.bestStreak = 7;
    // пройдено две трети открытых карточек — иначе прогресс выглядит завершённым
    const open = QUIZ.cards.filter(c => c.lesson <= S.lesson);
    open.slice(0, Math.round(open.length * 2 / 3)).forEach(c => { S.done[c.id] = { ok: 1, err: 0 }; });
    S.wrong = open.length ? [open[open.length - 1].id] : [];
  }

  // Первый запуск — онбординг, дальше сразу главный. Флаг ставится по кнопке
  // «Начать»: раньше вход показывался снова и снова, пока ученик не ответит
  // хотя бы на одну карточку.
  const seen = S.onboarded || S.days.length > 0 || S.lesson > 1 || Object.keys(S.done).length > 0;
  const start = url.get('screen') || (seen ? 'home' : 'onboarding');
  stack = [{ name: start }];
  render(start, url.get('param') || (start === 'sheet' ? 'starting' : undefined));

  // Браузерная кнопка «назад» и свайп в Telegram
  window.addEventListener('popstate', popBack);

  // Оффлайн: шпаргалки должны открываться в клубе и без связи.
  // С file:// service worker недоступен — там и не нужен.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
document.addEventListener('DOMContentLoaded', init);
