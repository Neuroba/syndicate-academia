/* Соперники за учебным столом.

   Главное требование, ради которого всё написано именно так: КАЖДЫЙ ход бота
   возвращает причину словами. Половина разбора на занятии — «а почему он
   поставил?», и тренер должен знать ответ, а не сочинять. Причина уходит
   в состояние стола и видна только тренеру.

   Второе требование — предсказуемость. Никакого Math.random: бот решает
   по правилам от карт, позиции и банка. Тот же спот — тот же ход соперника,
   иначе «давай ещё раз» разваливается.

   ЧЕСТНО ПРО УРОВЕНЬ. Это не сильные боты и не могут ими быть: они играют
   по правилам в лоб, не блефуют осмысленно и не наказывают за ошибки.
   Годятся, чтобы отработать порядок хода, позиции и дисциплину фолда.
   Учиться на них читать соперника нельзя — об этом ученику сказано прямо
   на экране стола.

   Шкала силы стартовой руки — формула Чена. Выбрана не потому, что лучшая,
   а потому что её можно объяснить ученику за минуту и он посчитает сам:
   туз 10, король 8, дама 7, валет 6, остальные пополам; пара — вдвое, но
   не меньше 5; одномастные +2; за разрыв между картами вычитаем.
*/

(function (global) {
  'use strict';

  const VAL = { 'A': 10, 'K': 8, 'Q': 7, 'J': 6 };
  const ORD = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
                '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

  /* Сила стартовой руки по Чену. Возвращает баллы и объяснение —
     объяснение показываем тренеру, оно же годится ученику на разборе. */
  function chen(cards) {
    const a = cards[0], b = cards[1];
    const hi = ORD[a.r] >= ORD[b.r] ? a : b;
    const lo = hi === a ? b : a;
    // Половинки округляем СРАЗУ вверх, как в оригинале формулы:
    // ученик считает в уме «семёрка — это четыре», а не «три с половиной».
    const base = VAL[hi.r] || Math.ceil(ORD[hi.r] / 2);
    let pts, why;

    if (a.r === b.r) {
      pts = Math.max(base * 2, 5);
      why = 'пара ' + a.r + ' — удваиваем ' + base + ', минимум 5';
    } else {
      pts = base;
      why = 'старшая ' + hi.r + ' даёт ' + base;
      if (a.s === b.s) { pts += 2; why += ', одномастные +2'; }
      const gap = ORD[hi.r] - ORD[lo.r] - 1;
      const minus = gap === 0 ? 0 : gap === 1 ? 1 : gap === 2 ? 2 : gap === 3 ? 4 : 5;
      if (minus) { pts -= minus; why += ', разрыв ' + gap + ' → −' + minus; }
      if (gap <= 1 && ORD[hi.r] < 12) { pts += 1; why += ', обе младше дамы и рядом +1'; }
    }
    return { pts: Math.ceil(pts), why: why };
  }

  /* Названия мест по числу игроков. Втроём ранних позиций не бывает вовсе —
     об этом же говорится на занятии 2, и стол обязан быть с ним согласен. */
  function positions(n) {
    if (n === 2) return ['BTN/SB', 'BB'];
    if (n === 3) return ['BTN', 'SB', 'BB'];
    if (n === 4) return ['CO', 'BTN', 'SB', 'BB'];
    if (n === 5) return ['HJ', 'CO', 'BTN', 'SB', 'BB'];
    if (n === 6) return ['LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
    if (n === 7) return ['UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
    // Восемь — наш основной стол: те же места, что в шпаргалке и тренажёре.
    return ['UTG', 'UTG+1', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'].slice(-n);
  }

  /* Кто на каком месте. Кнопка едет по кругу, поэтому имя позиции
     считается от неё, а не от номера кресла. */
  function posOf(st, seat) {
    const n = st.seats.length;
    const names = positions(n);
    // BTN — предпоследний перед блайндами в нашем списке
    const btnIdx = names.indexOf(n === 2 ? 'BTN/SB' : 'BTN');
    const shift = (seat - st.button + n) % n;
    return names[(btnIdx + shift) % n];
  }

  /* Порог открытия по позиции: чем позже сидишь, тем шире играешь.
     Числа согласованы с нашей шпаргалкой «Стартовые руки» — второй набор
     диапазонов ученику не показываем, иначе будет каша. */
  const OPEN = { 'UTG': 9, 'UTG+1': 9, 'LJ': 8, 'HJ': 8, 'CO': 7, 'BTN': 6,
                 'BTN/SB': 5, 'SB': 6, 'BB': 6 };

  function botAct(st) {
    const P = global.Poker;
    const s = st.seats[st.toAct];
    const opts = P.options(st);
    const pos = posOf(st, s.i);
    const need = st.bet - s.put;
    const pot = st.pot;

    // ─── до флопа ───
    if (st.street === 0) {
      const h = chen(s.cards);
      const thr = OPEN[pos] === undefined ? 7 : OPEN[pos];
      const opened = st.bet > st.bb;   // кто-то уже поднял

      if (!opened) {
        if (h.pts >= thr) {
          const to = Math.min(st.bb * 3, s.put + s.stack);
          return { act: 'raise', to: to,
            why: pos + ', рука ' + h.pts + ' балла по Чену (' + h.why + '), с этого места открываю от ' + thr + ' — поднимаю до ' + to };
        }
        if (need === 0) return { act: 'check', why: pos + ', рука ' + h.pts + ' — слабо для открытия, но платить не надо: чек' };
        return { act: 'fold', why: pos + ', рука ' + h.pts + ' балла, с этого места открываю от ' + thr + ' — пас' };
      }

      // против чужого повышения играем заметно уже
      if (h.pts >= thr + 3) {
        const to = Math.min(st.bet * 3, s.put + s.stack);
        return { act: 'raise', to: to, why: pos + ', рука ' + h.pts + ' — сильно даже против повышения, отвечаю рейзом до ' + to };
      }
      if (h.pts >= thr + 1 && need <= s.stack) {
        return { act: 'call', why: pos + ', рука ' + h.pts + ' — хватает уравнять чужое повышение, но не поднимать' };
      }
      if (need === 0) return { act: 'check', why: pos + ', бесплатно смотрю флоп' };
      return { act: 'fold', why: pos + ', рука ' + h.pts + ' — против повышения этого мало, пас' };
    }

    // ─── после флопа ───
    const ev = P.evaluate(s.cards.concat(st.board));
    const madeRank = ev.rank;                 // 1 старшая карта … 9 стрит-флеш
    const wet = boardWet(st.board);

    if (madeRank >= 4) {                      // сет и выше — играем за деньги
      const to = Math.min(st.bet + Math.round(pot * 0.7), s.put + s.stack);
      if (opts.some(o => o.act === 'raise'))
        return { act: 'raise', to: to, why: 'у меня ' + ev.name + ' — ставлю за деньги, ' + Math.round(pot * 0.7) + ' в банк ' + pot };
      return { act: 'call', why: 'у меня ' + ev.name + ' — плачу' };
    }
    if (madeRank >= 2) {                      // пара или две пары
      if (need === 0) {
        const to = Math.min(st.bet + Math.round(pot * 0.5), s.put + s.stack);
        if (!wet) return { act: 'raise', to: to, why: 'у меня ' + ev.name + ', борд сухой — ставлю половину банка' };
        return { act: 'check', why: 'у меня ' + ev.name + ', но борд мокрый — не раздуваю, чек' };
      }
      if (need <= pot * 0.4) return { act: 'call', why: 'у меня ' + ev.name + ', цена ' + need + ' в банк ' + pot + ' — плачу' };
      return { act: 'fold', why: 'у меня всего ' + ev.name + ', а просят ' + need + ' в банк ' + pot + ' — дорого, пас' };
    }
    // ничего не собралось
    if (need === 0) {
      const aggressor = st.log.some(l => l.seat === s.i && l.street === st.street - 1 && /до /.test(l.text));
      if (aggressor && !wet) {
        const to = Math.min(st.bet + Math.round(pot * 0.5), s.put + s.stack);
        return { act: 'raise', to: to, why: 'я поднимал до этого, борд сухой — продолжаю ставку на половину банка' };
      }
      return { act: 'check', why: 'ничего не собралось — чек' };
    }
    return { act: 'fold', why: 'ничего не собралось, а просят ' + need + ' — пас' };
  }

  /* Мокрый борд — тот, где легко собрать стрит или флеш. На нём опасно
     ставить средней рукой: это ровно то, что разбирается на занятии 5. */
  function boardWet(board) {
    if (board.length < 3) return false;
    const suits = {};
    board.forEach(c => { suits[c.s] = (suits[c.s] || 0) + 1; });
    if (Object.values(suits).some(v => v >= 2)) return true;
    const v = board.map(c => ORD[c.r]).sort((a, b) => a - b);
    for (let i = 0; i < v.length - 1; i++) if (v[i + 1] - v[i] <= 2) return true;
    return false;
  }

  global.Bots = { chen: chen, positions: positions, posOf: posOf, botAct: botAct, boardWet: boardWet };
})(typeof window !== 'undefined' ? window : globalThis);
