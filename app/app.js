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
    drills: renderDrills, drill: renderDrill
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
  main.textContent = doneToday ? 'Повторить карточки' : 'Начать тренировку · 5 минут';
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
const DRILL_VIEW = {
  ranks: it => ({
    q: 'Чья рука сильнее?',
    stage: boardHtml(it.board) + '<div class="bl">общие карты</div>' +
      `<div class="duo">
        <div class="side" data-side="0"><div class="sl">первая</div>${boardHtml(it.a).replace('board', 'board')}</div>
        <div class="side" data-side="1"><div class="sl">вторая</div>${boardHtml(it.b)}</div>
      </div>`,
    acts: ['Первая рука', 'Вторая рука'],
    right: it.winner
  }),
  starting: it => ({
    q: 'Открываем эту руку?',
    stage: `<div class="dr-pos">${it.pos}</div>` + boardHtml(it.hand, 'mine'),
    acts: ['Пас', 'Открываем рейзом'],
    right: it.answer
  }),
  outs: it => {
    const opts = [2, 4, 6, 8, 9, 15];
    return {
      q: 'Сколько у тебя аутов?',
      stage: boardHtml(it.board) + '<div class="bl">флоп</div>' +
        boardHtml(it.hand, 'mine') + '<div class="mine-lbl">твоя рука</div>',
      acts: opts.map(String), grid: true,
      right: opts.indexOf(it.outs)
    };
  },
  potodds: it => ({
    q: `У тебя ${it.draw}. Платить?`,
    stage: `<div class="potrow">
        <div class="pot"><div class="pl">банк</div><div class="pv">$${it.pot}</div></div>
        <div class="pot"><div class="pl">ставка</div><div class="pv">$${it.bet}</div></div>
        <div class="pot"><div class="pl">аутов</div><div class="pv">${it.outs}</div></div>
      </div>`,
    acts: ['Пас', `Колл $${it.bet}`],
    right: it.answer
  })
};

function paintDrill() {
  const it = D.item, v = DRILL_VIEW[D.kind](it);
  const kind = DRILL_KINDS.find(k => k.id === D.kind);
  document.getElementById('dk-name').textContent = kind.name;
  document.getElementById('dk-score').textContent = `${D.ok} / ${D.n}`;
  document.getElementById('dk-q').textContent = v.q;
  document.getElementById('dk-stage').innerHTML = v.stage;

  const box = document.getElementById('dk-acts');
  box.className = v.grid ? 'grid4' : 'acts';
  box.innerHTML = '';
  v.acts.forEach((txt, i) => {
    const b = document.createElement('button');
    b.className = 'act';
    b.innerHTML = `<span>${txt}</span>`;
    b.onclick = () => pickDrill(i, b);
    box.appendChild(b);
  });

  document.getElementById('dk-why').innerHTML = 'Выбери ответ.';
  const main = document.getElementById('dk-main');
  main.textContent = 'Выбери ответ';
  main.disabled = true;
  main.onclick = onDrillMain;
}

function pickDrill(i, el) {
  if (D.answered) return;
  D.sel = i;
  document.querySelectorAll('#dk-acts .act').forEach(a => a.classList.remove('sel'));
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
  const it = D.item, v = DRILL_VIEW[D.kind](it);
  D.answered = true;
  const good = D.sel === v.right;
  D.n++; if (good) D.ok++;

  document.querySelectorAll('#dk-acts .act').forEach((a, i) => {
    a.classList.remove('sel');
    if (i === v.right) a.classList.add('good');
    else if (i === D.sel) a.classList.add('bad');
  });
  // у «что сильнее» подсветить ещё и саму руку — так понятнее, чем подпись кнопки
  if (D.kind === 'ranks') {
    document.querySelectorAll('#dk-stage .side').forEach(s => {
      const n = +s.dataset.side;
      s.classList.add(n === v.right ? 'good' : (n === D.sel ? 'bad' : 'x'));
    });
  }

  const st = S.drills[D.kind] || { n: 0, ok: 0 };
  st.n++; if (good) st.ok++;
  S.drills[D.kind] = st;
  save();

  document.getElementById('dk-score').textContent = `${D.ok} / ${D.n}`;
  document.getElementById('dk-why').innerHTML =
    `<b>${good ? 'Верно.' : 'Не так.'}</b> ${it.why}`;
  if (TG && TG.HapticFeedback) TG.HapticFeedback.notificationOccurred(good ? 'success' : 'warning');

  const main = document.getElementById('dk-main');
  main.textContent = 'Следующая';
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
