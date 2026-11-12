/*
 * Draws a classic 15x15 Ludo board with CSS grid.
 * Server progress model: -1 yard, 0..50 shared track, 51..55 home column, 56 home.
 */
(function () {
  'use strict';

  // The 52 shared squares, clockwise, starting at red's start square.
  const TRACK = [
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5],
    [5, 6], [4, 6], [3, 6], [2, 6], [1, 6], [0, 6],
    [0, 7],
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8],
    [6, 9], [6, 10], [6, 11], [6, 12], [6, 13], [6, 14],
    [7, 14],
    [8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9],
    [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8],
    [14, 7],
    [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6],
    [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    [7, 0],
    [6, 0]
  ];
  const START = { red: 0, green: 13, yellow: 26, blue: 39 };
  const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
  const HOME_COL = {
    red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
    green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
    yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
    blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]]
  };
  const CENTER = { red: [7, 6], green: [6, 7], yellow: [7, 8], blue: [8, 7] };
  const YARD = {
    red: [[1, 1], [1, 4], [4, 1], [4, 4]],
    green: [[1, 10], [1, 13], [4, 10], [4, 13]],
    yellow: [[10, 10], [10, 13], [13, 10], [13, 13]],
    blue: [[10, 1], [10, 4], [13, 1], [13, 4]]
  };
  const YARD_AREA = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };

  function cellFor(color, progress, pieceIdx) {
    if (progress < 0) return YARD[color][pieceIdx];
    if (progress <= 50) return TRACK[(START[color] + progress) % 52];
    if (progress <= 55) return HOME_COL[color][progress - 51];
    return CENTER[color];
  }

  function baseBoard() {
    const grid = document.createElement('div');
    grid.className = 'ludo-board';
    const cells = new Map();
    const put = (r, c, cls) => {
      const el = document.createElement('div');
      el.className = `lc ${cls || ''}`;
      el.style.gridRow = String(r + 1);
      el.style.gridColumn = String(c + 1);
      grid.appendChild(el);
      cells.set(`${r},${c}`, el);
      return el;
    };
    for (const [color, [r0, c0]] of Object.entries(YARD_AREA)) {
      const yard = document.createElement('div');
      yard.className = `yard ${color}`;
      yard.style.gridRow = `${r0 + 1} / span 6`;
      yard.style.gridColumn = `${c0 + 1} / span 6`;
      grid.appendChild(yard);
      for (const [r, c] of YARD[color]) put(r, c, `slot ${color}`);
    }
    TRACK.forEach(([r, c], i) => {
      let cls = 'track';
      if (SAFE.has(i)) cls += ' safe';
      for (const [color, s] of Object.entries(START)) if (s === i) cls += ` start ${color}`;
      put(r, c, cls);
    });
    for (const [color, list] of Object.entries(HOME_COL)) for (const [r, c] of list) put(r, c, `homecol ${color}`);
    const center = document.createElement('div');
    center.className = 'ludo-center';
    center.style.gridRow = '7 / span 3';
    center.style.gridColumn = '7 / span 3';
    grid.appendChild(center);
    for (const [color, [r, c]] of Object.entries(CENTER)) {
      const el = document.createElement('div');
      el.className = `lc finish ${color}`;
      el.style.gridRow = String(r + 1);
      el.style.gridColumn = String(c + 1);
      grid.appendChild(el);
      cells.set(`${r},${c}`, el);
    }
    return { grid, cells };
  }

  function render(container, state, myId, onPiece) {
    const { grid, cells } = baseBoard();
    const me = state.players[state.turn];
    const myTurn = me && me.id === myId && state.status === 'playing';
    const movable = new Set(myTurn && state.rolled ? (state.legal || []).map((m) => m.piece) : []);
    const last = state.lastMove;

    state.players.forEach((p) => {
      if (p.out) return;
      p.pieces.forEach((progress, idx) => {
        const [r, c] = cellFor(p.color, progress, idx);
        const cell = cells.get(`${r},${c}`);
        if (!cell) return;
        const token = document.createElement('button');
        token.type = 'button';
        token.className = `token ${p.color}`;
        token.setAttribute('aria-label', `${p.color} piece ${idx + 1}`);
        const isMine = p.id === myId;
        if (isMine && movable.has(idx)) {
          token.classList.add('movable');
          token.addEventListener('click', () => onPiece(idx));
        } else {
          token.disabled = true;
        }
        if (last && last.color === p.color && last.piece === idx) token.classList.add('last');
        cell.appendChild(token);
        const n = cell.querySelectorAll('.token').length;
        if (n > 1) cell.classList.add('stack');
      });
    });
    container.appendChild(grid);
  }

  window.FTLudo = { render };
}());
