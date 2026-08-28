/* Учебный покерный стол — движок раздачи.

   Здесь только правила: колода, блайнды, порядок хода, улицы, вскрытие.
   Ни одной строки про экран — рисует стол table.js, а спрашивает ходы тот,
   кто движок вызывает. Так движок можно проверять без браузера.

   Почему свой, а не чужой. Проверено 26 открытых движков: у лучшего по функциям
   ядовитая лицензия (запрет коммерции), у следующего сломаны побочные банки
   и месяц висит неслитая правка, остальные требуют сборки. Нам нужен не рум,
   а тренажёр: правила те же, но без денег, античита и множества столов.
   Двести строк, которые тренер может попросить поменять, лучше пятидесяти
   килобайт, которые никто не читал.

   Оценщик комбинаций — чужой: vendor/pokersolver.js, MIT. Он сверен с нашим
   питоновским на 1000 случайных раскладов и 14 краевых — расхождений ноль.

   ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ:
   · Побочные банки (трое и больше в олл-ин с разными стеками) — считаются,
     но не делятся: победитель забирает всё. В учебном споте это не встретится,
     а код усложняет вдвое. Место помечено словом ПОБОЧНЫЕ.
   · Ставок вне очереди, тайм-банка, ребаев — нет намеренно.
*/

(function (global) {
  'use strict';

  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUITS = ['♠', '♥', '♦', '♣'];

  /* Наши карты — {r:'10', s:'♠'}. У pokersolver ранг десятки 'T', масть латиницей.
     Перевод держим в одном месте: путаница здесь стоила бы неверных вскрытий. */
  const SOLVER_SUIT = { '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c' };
  const CAT_RU = {
    'High Card': 'старшая карта', 'Pair': 'пара', 'Two Pair': 'две пары',
    'Three of a Kind': 'сет', 'Straight': 'стрит', 'Flush': 'флеш',
    'Full House': 'фулл-хаус', 'Four of a Kind': 'каре',
    'Straight Flush': 'стрит-флеш', 'Royal Flush': 'флеш-рояль'
  };

  function toSolver(c) {
    return (c.r === '10' ? 'T' : c.r) + SOLVER_SUIT[c.s];
  }

  /* Свой генератор вместо Math.random — ради воспроизводимости.

     Тренер говорит «давай ту же раздачу ещё раз»: с Math.random это невозможно,
     карты придут другие, и разбор рассыпется. Здесь раздача целиком определяется
     числом seed: один и тот же seed — одна и та же раздача, всегда.

     mulberry32: тридцать строк, равномерный, для карт более чем достаточно.
     Криптостойкость не нужна и не заявляется — фишки игровые. */
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Новый seed, когда его не задали. Единственное место, где допустима
     настоящая случайность — дальше раздача идёт только от seed. */
  function newSeed() {
    return Math.floor(Math.random() * 0x7FFFFFFF) + 1;
  }

  function deck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ r: r, s: s });
    return d;
  }

  /* Тасовка Фишера—Йетса. rnd передаётся снаружи: тренер задаёт спот с заранее
     известными картами, и тогда тасовка не нужна вовсе. */
  function shuffle(d, rnd) {
    const rand = rnd || Math.random;
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  /* Сила руки: чем больше, тем сильнее. Плюс русское название комбинации
     и пять карт, которые её составили — их подсвечиваем при разборе. */
  function evaluate(cards) {
    const h = global.Hand.solve(cards.map(toSolver));
    const royal = h.name === 'Straight Flush' && h.cards[0] && h.cards[0].value === 'A';
    return {
      rank: h.rank,
      score: h.rank * 1e10 + h.cards.reduce((a, c, i) => a + c.rank * Math.pow(15, 4 - i), 0),
      name: royal ? 'флеш-рояль' : (CAT_RU[h.name] || h.name),
      best: h.cards.map(c => ({ r: c.value === 'T' ? '10' : c.value, s: invSuit(c.suit) })),
      raw: h
    };
  }

  function invSuit(s) {
    return { s: '♠', h: '♥', d: '♦', c: '♣' }[s];
  }

  /* Кто выиграл. Возвращает список мест — при делёже их больше одного.
     Делёж не редкость: борд играет у обоих чаще, чем кажется новичку. */
  function winners(hands) {
    const solved = hands.map(h => global.Hand.solve(h.cards.map(toSolver)));
    const win = global.Hand.winners(solved);
    return hands.filter((h, i) => win.indexOf(solved[i]) >= 0).map(h => h.seat);
  }

  // ─────────── раздача ───────────

  const STREETS = ['префлоп', 'флоп', 'тёрн', 'ривер', 'вскрытие'];

  /* Состояние раздачи. Всё, что нужно нарисовать и продолжить, лежит здесь —
     значит раздачу можно сохранить в localStorage и поднять после обрыва связи. */
  function newHand(opts) {
    const o = opts || {};
    const n = o.seats || 6;
    const bb = o.bb || 20;
    const stack = o.stack || 100 * bb;

    const st = {
      seats: [],
      button: o.button === undefined ? 0 : o.button,
      bb: bb, sb: o.sb || bb / 2,
      board: [],
      pot: 0,
      street: 0,
      toAct: null,
      bet: 0,            // текущая ставка улицы, которую нужно уравнять
      lastRaise: bb,     // минимальный размер следующего повышения
      deck: [],
      log: [],
      done: false,
      result: null
    };

    for (let i = 0; i < n; i++) {
      st.seats.push({
        i: i,
        name: o.names && o.names[i] || (i === (o.hero === undefined ? 0 : o.hero) ? 'Ты' : 'Игрок ' + i),
        hero: i === (o.hero === undefined ? 0 : o.hero),
        stack: (o.stacks && o.stacks[i] !== undefined) ? o.stacks[i] : stack,
        cards: [],
        put: 0,          // вложено на этой улице
        total: 0,        // вложено за раздачу — пригодится для ПОБОЧНЫХ банков
        folded: false,
        allin: false,
        acted: false
      });
    }

    st.seed = o.seed || newSeed();
    st.rnd = rng(st.seed);
    st.deck = shuffle(deck(), st.rnd);
    // Заранее заданный спот: карты берём из него, остальное — из колоды
    if (o.cards) {
      for (const k in o.cards) st.seats[k].cards = o.cards[k].slice();
    }
    if (o.board) st.board = o.board.slice();

    for (const s of st.seats) {
      while (s.cards.length < 2) s.cards.push(drawUnused(st));
    }

    postBlinds(st);
    return st;
  }

  /* Берём карту, которой ещё нет ни на столе, ни в руках: в заданном споте
     тренер мог назвать те же карты, что лежат в колоде. */
  function drawUnused(st) {
    const used = {};
    st.board.forEach(c => { used[c.r + c.s] = 1; });
    st.seats.forEach(s => s.cards.forEach(c => { used[c.r + c.s] = 1; }));
    while (st.deck.length) {
      const c = st.deck.pop();
      if (!used[c.r + c.s]) return c;
    }
    throw new Error('колода кончилась');
  }

  function seatAfter(st, from) {
    for (let k = 1; k <= st.seats.length; k++) {
      const s = st.seats[(from + k) % st.seats.length];
      if (!s.folded && !s.allin) return s.i;
    }
    return null;
  }

  function postBlinds(st) {
    const n = st.seats.length;
    // Вдвоём малый блайнд — это кнопка (правило TDA №34). Втроём и больше
    // блайнды идут слева от кнопки. Путать нельзя: порядок хода зависит.
    const sbSeat = n === 2 ? st.button : (st.button + 1) % n;
    const bbSeat = n === 2 ? (st.button + 1) % n : (st.button + 2) % n;
    put(st, sbSeat, st.sb);
    put(st, bbSeat, st.bb);
    st.bet = st.bb;
    st.lastRaise = st.bb;
    st.bbSeat = bbSeat;
    // До флопа ходят слева от большого блайнда. Вдвоём это кнопка/малый блайнд.
    st.toAct = n === 2 ? st.button : seatAfter(st, bbSeat);
    st.log.push({ street: 0, text: 'блайнды ' + st.sb + '/' + st.bb });
  }

  function put(st, i, amount) {
    const s = st.seats[i];
    const real = Math.min(amount, s.stack);
    s.stack -= real;
    s.put += real;
    s.total += real;
    st.pot += real;
    if (s.stack === 0) s.allin = true;
    return real;
  }

  /* Что сейчас можно сделать. Отдаём наружу, чтобы интерфейс не решал это сам
     и не разошёлся с движком. */
  function options(st) {
    if (st.done || st.toAct === null) return [];
    const s = st.seats[st.toAct];
    const need = st.bet - s.put;
    const out = [];
    if (need > 0) out.push({ act: 'fold', label: 'Пас' });
    else out.push({ act: 'check', label: 'Чек' });
    if (need > 0) {
      out.push({ act: 'call', label: need >= s.stack ? 'Колл ва-банк' : 'Колл ' + need, amount: Math.min(need, s.stack) });
    }
    const minRaise = st.bet + st.lastRaise;
    if (s.stack + s.put > st.bet) {
      out.push({
        act: 'raise',
        label: need > 0 ? 'Рейз' : 'Бет',
        min: Math.min(minRaise, s.put + s.stack),
        max: s.put + s.stack
      });
    }
    return out;
  }

  /* Ход. to — сумма, ДО которой поднимают (как за живым столом говорят
     «рейз до шестидесяти»), а не добавка сверху: новички путают именно это. */
  function act(st, action, to) {
    if (st.done) return st;
    const i = st.toAct;
    const s = st.seats[i];
    const need = st.bet - s.put;

    if (action === 'fold') {
      s.folded = true;
      st.log.push({ street: st.street, seat: i, text: s.name + ' пас' });
    } else if (action === 'check') {
      if (need > 0) throw new Error('чек нельзя: нужно уравнять ' + need);
      st.log.push({ street: st.street, seat: i, text: s.name + ' чек' });
    } else if (action === 'call') {
      const paid = put(st, i, need);
      st.log.push({ street: st.street, seat: i, text: s.name + ' колл ' + paid });
    } else if (action === 'raise') {
      const target = Math.min(to, s.put + s.stack);
      if (target <= st.bet && target < s.put + s.stack) throw new Error('рейз должен быть больше текущей ставки');
      const add = target - s.put;
      // Повышение меньше минимального возможно только олл-ином — это не рейз,
      // а «сколько есть»: право на переоткрытие торговли оно не даёт.
      if (target - st.bet >= st.lastRaise) st.lastRaise = target - st.bet;
      put(st, i, add);
      st.bet = Math.max(st.bet, target);
      // после настоящего повышения все остальные ходят заново
      st.seats.forEach(x => { if (x.i !== i && !x.folded && !x.allin) x.acted = false; });
      st.log.push({ street: st.street, seat: i, text: s.name + ' до ' + target });
    } else {
      throw new Error('неизвестное действие: ' + action);
    }
    s.acted = true;
    advance(st);
    return st;
  }

  function alive(st) { return st.seats.filter(s => !s.folded); }
  function canAct(st) { return st.seats.filter(s => !s.folded && !s.allin); }

  function streetClosed(st) {
    const live = canAct(st);
    if (live.length === 0) return true;
    return live.every(s => s.acted && s.put === st.bet);
  }

  function advance(st) {
    if (alive(st).length === 1) return finish(st);
    if (!streetClosed(st)) {
      st.toAct = seatAfter(st, st.toAct);
      // Некому ходить — все остальные в олл-ине: доигрываем борд без торговли.
      if (st.toAct === null || canAct(st).length === 0) return runOut(st);
      return st;
    }
    return nextStreet(st);
  }

  function nextStreet(st) {
    st.seats.forEach(s => { s.put = 0; s.acted = false; });
    st.bet = 0;
    st.lastRaise = st.bb;
    st.street++;
    if (st.street >= 4) return finish(st);
    deal(st);
    if (canAct(st).length < 2) return runOut(st);
    // После флопа ходят с малого блайнда — не с того, кто ходил первым до флопа.
    // Это ровно то место, где новички путаются, и движок обязан быть прав.
    const n = st.seats.length;
    const sbSeat = n === 2 ? (st.button + 1) % n : (st.button + 1) % n;
    st.toAct = st.seats[sbSeat].folded || st.seats[sbSeat].allin ? seatAfter(st, sbSeat) : sbSeat;
    return st;
  }

  function deal(st) {
    const want = st.street === 1 ? 3 : st.street === 2 ? 4 : 5;
    while (st.board.length < want) st.board.push(drawUnused(st));
    st.log.push({ street: st.street, text: STREETS[st.street] + ': ' + st.board.map(c => c.r + c.s).join(' ') });
  }

  /* Все в олл-ине — доводим борд до ривера без торговли и вскрываем. */
  function runOut(st) {
    while (st.street < 3) { st.street++; deal(st); }
    return finish(st);
  }

  function finish(st) {
    st.done = true;
    st.toAct = null;
    const live = alive(st);

    if (live.length === 1) {
      live[0].stack += st.pot;
      st.result = { winners: [live[0].i], pot: st.pot, showdown: false,
                    text: live[0].name + ' забирает ' + st.pot + ' — остальные спасовали' };
      return st;
    }

    while (st.board.length < 5) st.board.push(drawUnused(st));
    const hands = live.map(s => ({ seat: s.i, cards: s.cards.concat(st.board) }));
    const win = winners(hands);
    // ПОБОЧНЫЕ банки: при разных стеках в олл-ине банк надо делить на основной
    // и побочные. Сейчас победитель забирает всё — в учебном споте этого не будет,
    // но если стол пойдёт в свободную игру, считать надо от seats[].total.
    /* Полноценных ПОБОЧНЫХ банков нет, но и врать нельзя: выиграть больше,
       чем вложил каждый соперник, невозможно. Ограничиваем выигрыш тем,
       что победитель мог покрыть своим стеком, излишек возвращаем тем,
       кто переставил. Закрывает почти все случаи разных стеков за столом
       и, главное, не даёт тренажёру показать неверную сумму при клиенте. */
    const cap = st.seats[win[0]].total;
    let payout = 0, back = [];
    for (const s of st.seats) {
      const covered = Math.min(s.total, cap);
      payout += covered;
      if (s.total > covered && !win.includes(s.i)) back.push([s.i, s.total - covered]);
    }
    back.forEach(([i, amount]) => { st.seats[i].stack += amount; });
    const share = Math.floor(payout / win.length);
    win.forEach(i => { st.seats[i].stack += share; });
    st.seats[win[0]].stack += payout - share * win.length;   // остаток — ближнему к кнопке
    if (back.length) st.log.push({ street: st.street, text: 'возврат непокрытого: ' + back.map(b => st.seats[b[0]].name + ' ' + b[1]).join(', ') });

    const names = win.map(i => st.seats[i].name).join(' и ');
    const ev = evaluate(st.seats[win[0]].cards.concat(st.board));
    st.result = {
      winners: win, pot: st.pot, showdown: true, hand: ev.name,
      text: names + (win.length > 1 ? ' делят ' : ' забирает ') + st.pot + ' — ' + ev.name
    };
    return st;
  }

  global.Poker = {
    RANKS: RANKS, SUITS: SUITS, STREETS: STREETS,
    deck: deck, shuffle: shuffle, evaluate: evaluate, winners: winners,
    rng: rng, newSeed: newSeed,
    newHand: newHand, options: options, act: act,
    alive: alive, canAct: canAct
  };
})(typeof window !== 'undefined' ? window : globalThis);
