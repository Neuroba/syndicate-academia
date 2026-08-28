/* Экран стола: рисует раздачу и спрашивает ход.

   Правил здесь нет — они в poker.js, решения соперников в bots.js.
   Здесь только показ и нажатия.

   Что важно и почему именно так:

   · ПОЗИЦИЯ — НАДПИСЬЮ. Шесть мест взяты ради ранних позиций: за столом
     на троих их не бывает, а теряют деньги в клубе именно там. Но если
     позиция читается только из геометрии овала, новичок её не увидит.
     Поэтому сверху лента UTG · LJ · HJ · CO · BTN · SB · BB с подсветкой
     её места и словами «ты ходишь первой, за тобой ещё четверо».

   · ДВЕ РАСКЛАДКИ ПО ШИРИНЕ ОКНА, не по устройству. Занятие идёт с ноутбуков,
     в окне Telegram Desktop, а домашка — с телефона. До 520 px — столбиком,
     шире — овал по центру. Смотрим ширину контейнера, а не user-agent:
     окно Telegram на десктопе бывает узким.

   · РАЗДАЧА ПЕРЕЖИВАЕТ ЗАКРЫТИЕ. Mini App закрывается свайпом, звонком,
     случайным Esc. Состояние пишем в localStorage на каждый ход: вернулся —
     продолжил, а не «начинаем заново» посреди занятия.

   · В ЖУРНАЛ — ВСЯ РУКА ОДНОЙ ЗАПИСЬЮ в конце, а не каждое нажатие.
     Через неделю тренер должен уметь вернуться к раздаче целиком.
     И ok здесь всегда пустой: в свободной игре правильного ответа нет,
     иначе статистика «где спотыкаются» начнёт врать.
*/

(function (global) {
  'use strict';

  // Восемь мест, а не шесть. Причина не в покере, а в согласованности:
  // в тренажёре стартовых рук 45 задач по восьмиместной схеме, из них 17
  // про LJ и UTG+1 — за шестиместным столом таких мест нет вовсе.
  // Шпаргалка, словарь и заученные цифры открытия — тоже про восемь.
  // Разночтение между экранами дороже двух лишних ботов.
  const SEATS = 8;
  const BB = 20;
  const STACK = 100 * BB;

  let H = null;            // текущая раздача
  let думает = false;      // идёт ход ботов — кнопки заблокированы
  let выбор = null;        // выбранное, но ещё не подтверждённое действие

  function el(id) { return document.getElementById(id); }

  function cardHtml(c, hidden) {
    if (hidden) return '<div class="pt-card back">♠</div>';
    const red = (c.s === '♥' || c.s === '♦') ? ' red' : '';
    return '<div class="pt-card' + red + '"><b>' + c.r + '</b><i>' + c.s + '</i></div>';
  }

  /* Лента позиций и подсказка, где она в очереди ХОДА.

     Тонкость, на которой ловятся все: до флопа и после флопа порядок разный.
     До флопа ходят слева от большого блайнда, поэтому большой блайнд говорит
     последним. После флопа ходят с малого блайнда, и последней говорит кнопка,
     а большой блайнд — второй.

     Первая версия писала большому блайнду «говоришь последней — лучшее место»
     на всех улицах. Это ровно тот вредный рефлекс, от которого предостерегает
     занятие 2: за живым столом он стоил бы денег в каждой раздаче. */
  function actingOrder() {
    const n = H.seats.length;
    const order = [];
    // до флопа — от места слева от большого блайнда; после — от малого блайнда
    const from = H.street === 0
      ? (n === 2 ? H.button : (H.button + 3) % n)
      : (H.button + 1) % n;
    for (let k = 0; k < n; k++) order.push((from + k) % n);
    return order;
  }

  function posStrip() {
    const B = global.Bots;
    const names = B.positions(H.seats.length);
    const mine = B.posOf(H, hero().i);
    const cells = names.map(n =>
      '<span class="pt-ps' + (n === mine ? ' on' : '') + '">' + n + '</span>').join('');

    const order = actingOrder();
    const place = order.indexOf(hero().i);
    const after = order.length - place - 1;
    if (H.done) {
      return '<div class="pt-posrow">' + cells + '</div>' +
        '<div class="pt-poshint">в этой раздаче ты была <b>' + mine + '</b></div>';
    }
    const улица = H.street === 0 ? 'до флопа' : 'на этой улице';
    const word = place === 0 ? 'ходишь первой из ' + order.length
      : after === 0 ? 'говоришь последней — лучшее место'
        : 'за тобой ещё ' + after + ' ' + plural(after, 'игрок', 'игрока', 'игроков');
    return '<div class="pt-posrow">' + cells + '</div>' +
      '<div class="pt-poshint">ты <b>' + mine + '</b>, ' + улица + ' ' + word + '</div>';
  }

  function plural(n, a, b, c) {
    const m = n % 100, k = n % 10;
    return (m > 10 && m < 20) ? c : k === 1 ? a : (k >= 2 && k <= 4) ? b : c;
  }

  function hero() { return H.seats.find(s => s.hero); }

  function paint() {
    const P = global.Poker, B = global.Bots;
    const me = hero();

    el('tb-pos').innerHTML = posStrip();
    el('tb-pot').textContent = H.pot;
    el('tb-street').textContent = P.STREETS[Math.min(H.street, 4)];

    // Места по овалу. Герой всегда внизу по центру — так стол читается
    // одинаково независимо от того, какая позиция ему досталась в этой раздаче.
    // Координаты считаем по эллипсу: угол от нижней точки, по часовой стрелке.
    const n = H.seats.length;
    const meIdx = me.i;
    el('tb-seats').innerHTML = H.seats.map(s => {
      const k = (s.i - meIdx + n) % n;                 // 0 — герой, дальше по кругу
      const ang = (90 + k * (360 / n)) * Math.PI / 180;
      const x = 50 + 44 * Math.cos(ang);
      const y = 50 + 46 * Math.sin(ang);
      const cls = s.hero ? ' me' : (s.folded ? ' out' : (H.toAct === s.i ? ' act' : ''));
      const btn = s.i === H.button ? '<span class="pt-dlr">D</span>' : '';
      // Последнее действие этого игрока на текущей улице — то, что тренер
      // и ученица читают в первую очередь: «кто что сделал».
      const last = [...H.log].reverse().find(l => l.seat === s.i && l.street === H.street);
      const act = s.folded ? 'пас'
        : last ? last.text.replace(s.name + ' ', '')
          : (s.put > 0 ? String(s.put) : '');
      return '<div class="pt-seat' + cls + '" style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%">' +
        btn +
        '<div class="pt-sn">' + (s.hero ? 'Ты' : s.name.replace('Игрок ', '')) +
          ' <em>' + B.posOf(H, s.i) + '</em></div>' +
        '<div class="pt-ss">' + s.stack + '</div>' +
        (act ? '<div class="pt-sa' + (/до |колл/.test(act) ? ' bet' : '') + '">' + act + '</div>' : '') +
        '</div>';
    }).join('');

    /* Лента раздачи. Боты ходят быстрее, чем она успевает посмотреть, и без строки
       «кто поставил и сколько» разбор невозможен: тренер спросит «почему не сбросила
       против рейза с ранней», а она не видела, что был рейз.
       В конце раздачи лента разворачивается — руку разбирают целиком. */
    const lines = H.log.filter(l => l.text).slice(H.done ? 0 : -7);
    const logBox = el('tb-log');
    logBox.classList.toggle('full', !!H.done);
    logBox.innerHTML = lines.map(l =>
      '<div class="pt-lg' + (l.seat === me.i ? ' me' : '') + '">' + l.text + '</div>').join('');
    logBox.scrollTop = logBox.scrollHeight;

    // борд
    el('tb-board').innerHTML = H.board.map(c => cardHtml(c)).join('') ||
      '<div class="pt-bnote">карты стола откроются после торговли</div>';

    // моя рука
    el('tb-hand').innerHTML = me.cards.map(c => cardHtml(c)).join('');
    el('tb-stack').textContent = me.stack;
    const ev = H.board.length >= 3 ? P.evaluate(me.cards.concat(H.board)) : null;
    el('tb-made').textContent = ev ? 'у тебя ' + ev.name : '';

    // кнопки
    const box = el('tb-acts');
    box.innerHTML = '';
    if (H.done) {
      el('tb-hint').hidden = true;
      выбор = null;
      el('tb-main').hidden = false;
      el('tb-main').textContent = 'Следующая раздача';
      el('tb-main').onclick = () => start();
      el('tb-res').hidden = false;
      const R = review();
      el('tb-res').innerHTML =
        '<div class="pt-verd">' + R.verdict + '</div>' +
        '<div class="pt-sd"><div class="pt-sdh">что было у кого</div>' +
        R.rows.map(r =>
          '<div class="pt-sdr' + (r.hero ? ' me' : '') + (r.folded ? ' out' : '') +
            (r.seat === R.best.seat ? ' win' : '') + '">' +
            '<span class="pt-who">' + r.name + ' <em>' + r.pos + '</em></span>' +
            '<span class="pt-cds">' + r.cards.map(c =>
              '<i class="' + (c.s === '♥' || c.s === '♦' ? 'r' : '') + '">' + c.r + c.s + '</i>').join('') + '</span>' +
            '<span class="pt-cmb">' + r.ev.name + (r.folded ? ' · сбросил' : '') + '</span>' +
          '</div>').join('') + '</div>';
      return;
    }
    el('tb-res').hidden = true;
    el('tb-main').hidden = true;

    if (H.toAct !== hero().i || думает) {
      box.innerHTML = '<div class="pt-wait">ход соперника…</div>';
      return;
    }

    /* Два шага, а не один: тапнула — увидела последствие словами — подтвердила.

       Причина не в аккуратности, а в двух вещах. Кнопки «Пас» и «Колл» стоят
       вплотную, палец накрывает обе, и сброшенную руку не вернуть — при муже
       и при тренере. И второе: между выбором и подтверждением у тренера
       появляется секунда сказать «стой, подумай». Тот же ритуал, что
       в тренажёрах приложения, — третьей грамматики в одном приложении не нужно. */
    P.options(H).forEach(o => {
      const b = document.createElement('button');
      const sel = выбор && выбор.act === o.act;
      b.className = 'pt-act' + (o.act === 'fold' ? ' fold' : o.act === 'raise' ? ' raise' : '') + (sel ? ' sel' : '');
      b.textContent = o.label;
      b.onclick = () => {
        выбор = { act: o.act, to: o.act === 'raise' ? askRaise(o) : undefined, o: o };
        paint();
      };
      box.appendChild(b);
    });

    const hint = el('tb-hint');
    if (выбор) {
      hint.hidden = false;
      hint.textContent = последствие(выбор);
      el('tb-main').hidden = false;
      el('tb-main').textContent = 'Подтвердить';
      el('tb-main').onclick = () => { const v = выбор; выбор = null; step(v.act, v.to); };
    } else {
      hint.hidden = true;
      el('tb-main').hidden = true;
    }
  }

  /* Последствие хода словами. Новичок не считает в уме банк и цену —
     а решение принимает именно по ним. */
  function последствие(v) {
    const me = hero();
    const need = H.bet - me.put;
    if (v.act === 'fold') {
      return me.total > 0
        ? 'Сбросишь — ' + me.total + ', которые уже в банке, останутся соперникам.'
        : 'Сбросишь — ничего не теряешь, ждём следующую раздачу.';
    }
    if (v.act === 'check') return 'Чек — платить не надо, смотрим следующую карту бесплатно.';
    if (v.act === 'call') return 'Заплатишь ' + need + ', в банке станет ' + (H.pot + need) + '. Останется ' + (me.stack - need) + '.';
    const add = v.to - me.put;
    return 'Поднимешь до ' + v.to + ' — это ' + add + ' из твоих. В банке станет ' + (H.pot + add) + ', соперникам придётся платить ' + (v.to - H.bet) + ' сверху.';
  }

  /* Размер повышения. Не ползунок: новичку он не говорит ничего.
     Три готовых размера от банка — то, чем реально играют, и то,
     что разбирается на занятии 5. */
  function askRaise(o) {
    const pot = H.pot;
    const half = Math.min(Math.max(H.bet + Math.round(pot * 0.5), o.min), o.max);
    return half;
  }

  function step(act, to) {
    const P = global.Poker;
    H = P.act(H, act, to);
    save();
    paint();
    runBots();
  }

  /* Ходы соперников — с задержкой, иначе всё происходит мгновенно
     и ученица не понимает, что вообще случилось. */
  function runBots() {
    const P = global.Poker, B = global.Bots;
    if (H.done || H.toAct === hero().i) { finishIfDone(); return; }
    думает = true;
    paint();
    /* Пауза разной длины. Восемь мест по 700 мс — это до 25 секунд на раздачу,
       и половина из них уходит на чужие пасы, где ничего не происходит.
       Пас проскакивает быстро, ставка держится: внимание достаётся тому,
       что тренер потом и будет разбирать. */
    const решение = B.botAct(H);
    const пауза = (решение.act === 'fold' || решение.act === 'check') ? 380 : 900;
    setTimeout(() => {
      if (H.done) { думает = false; finishIfDone(); return; }
      const d = решение;
      // Запись в ленту делает движок — своей второй мы задваивали каждый ход.
      // Наше дело только прицепить к ней причину: тренеру она нужна на разборе,
      // ученице не показываем, иначе стол превращается в подсказку.
      const было = H.log.length;
      H = P.act(H, d.act, d.to);
      for (let k = было; k < H.log.length; k++) {
        if (H.log[k].seat !== undefined) H.log[k].why = d.why;
      }
      save();
      думает = false;
      paint();
      runBots();
    }, пауза);
  }

  function finishIfDone() {
    if (!H.done || H._logged) return;
    H._logged = true;
    save();
    paint();
    // Вся рука одной записью. ok пустой намеренно: правильного ответа нет.
    if (global.track) {
      const me = hero();
      global.track('table', 'free',
        'seed ' + H.seed + ' · ' + me.cards.map(c => c.r + c.s).join('') +
        ' · борд ' + H.board.map(c => c.r + c.s).join(' '),
        H.log.filter(l => l.seat === me.i).map(l => l.text).join(' → '),
        H.result.text, null, null);
    }
  }


  /* Разбор раздачи. Отвечает на первый вопрос новичка: «а правильно ли я сбросила?»

     До этого после сброса была тишина: раздача уезжала без неё, чужие карты
     не показывались, и понять, что произошло, было нельзя. Учиться на таком
     невозможно — человек просто нажимает наугад.

     Показываем три вещи:
     1. что было у КАЖДОГО — в учебном столе прятать нечего;
     2. чем закончилась раздача;
     3. что было бы у неё, если бы осталась.

     И обязательную оговорку про результат. Новичок, увидев «твоя рука выиграла бы»,
     делает вывод «зря сбросила» — это и есть результат-ориентированное мышление,
     главная ловушка на дистанции. Сброс мусора остаётся верным, даже когда
     этот мусор один раз выиграл. */
  function review() {
    const P = global.Poker, B = global.Bots;
    const me = hero();

    // Доводим борд до пяти карт ВИРТУАЛЬНО — состояние раздачи не трогаем.
    // Порядок колоды тот же, поэтому «что было бы» honest, а не выдуманное.
    const board = H.board.slice();
    const deck = H.deck.slice();
    const used = {};
    board.forEach(c => { used[c.r + c.s] = 1; });
    H.seats.forEach(s => s.cards.forEach(c => { used[c.r + c.s] = 1; }));
    while (board.length < 5 && deck.length) {
      const c = deck.pop();
      if (!used[c.r + c.s]) { used[c.r + c.s] = 1; board.push(c); }
    }
    const дораздали = board.length > H.board.length;

    const rows = H.seats.map(s => ({
      seat: s.i, name: s.hero ? 'Ты' : s.name.replace('Игрок ', 'И'),
      pos: B.posOf(H, s.i), hero: s.hero, folded: s.folded,
      cards: s.cards, ev: P.evaluate(s.cards.concat(board))
    }));
    const best = rows.reduce((a, r) => r.ev.score > a.ev.score ? r : a, rows[0]);
    const myEv = rows.find(r => r.hero).ev;

    let verdict = '';
    if (me.folded) {
      const меБыЛучше = myEv.score === best.ev.score;
      verdict = 'Ты сбросила. На полном борде твоя рука — <b>' + myEv.name + '</b>. ' +
        (меБыЛучше
          ? 'Это лучшая рука за столом.<br><span class="pt-cav">И всё же: одна раздача ничего не доказывает. ' +
            'Сброс слабой руки остаётся верным решением, даже когда она один раз выиграла бы — ' +
            'иначе придётся платить за неё и во все остальные разы.</span>'
          : 'Сильнее всех — у ' + best.name + ': ' + best.ev.name + '. Сброс сберёг фишки.');
    } else {
      verdict = H.result.text;
    }
    if (дораздали) verdict += '<br><span class="pt-cav">Борд после «' +
      P.STREETS[Math.min(H.street, 4)] + '» дораздан, чтобы было видно, чем бы всё кончилось.</span>';

    return { rows: rows, best: best, verdict: verdict };
  }

  // ─────────── сохранение ───────────

  const KEY = 'syndicate.table.v1';

  function save() {
    try {
      const copy = JSON.parse(JSON.stringify(H));
      delete copy.rnd;                 // функцию не сохранить
      localStorage.setItem(KEY, JSON.stringify(copy));
    } catch (e) { /* приватный режим — играем без сохранения */ }
  }

  function restore() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const st = JSON.parse(raw);
      if (!st || st.done) return null;
      st.rnd = global.Poker.rng(st.seed);   // генератор восстанавливаем из seed
      return st;
    } catch (e) { return null; }
  }

  function start(opts) {
    H = global.Poker.newHand(Object.assign({
      seats: SEATS, bb: BB, stack: STACK,
      button: Math.floor(Math.random() * SEATS),
      names: { 0: 'Ты' }
    }, opts || {}));
    думает = false;
    выбор = null;
    save();
    paint();
    runBots();
  }

  function render() {
    const kept = restore();
    if (kept) { H = kept; думает = false; paint(); runBots(); }
    else start();
  }

  global.Table = { render: render, start: start, state: () => H };
})(typeof window !== 'undefined' ? window : globalThis);
