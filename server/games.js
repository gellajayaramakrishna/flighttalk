'use strict';

/*
 * Server-authoritative game engine.
 *
 * Every game state has the same outer shape so the server and the UI can treat
 * games generically:
 *   {
 *     type, status: 'playing' | 'finished',
 *     players: [{ id, bot, mark|color, out }],
 *     turn,            // index into players
 *     winner,          // player id or null
 *     draw,            // boolean
 *     moves,           // number of applied actions
 *     lastMove,        // last action (for UI highlight)
 *     log: []          // short human-readable history, newest first
 *   }
 *
 * Clients only ever send *intentions* ("put my mark in cell 4"). This module decides
 * whether that is legal. A modified client cannot cheat.
 */

const TTT_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

const C4_ROWS = 6;
const C4_COLS = 7;

// Ludo -----------------------------------------------------------------------
// A piece's "progress" p:
//   -1        in the yard
//   0..50     on the shared 52-square track, counted from that colour's start square
//   51..55    in that colour's private home column
//   56        finished (home)
const LUDO_COLORS = ['red', 'green', 'yellow', 'blue'];
const LUDO_START = { red: 0, green: 13, yellow: 26, blue: 39 };
const LUDO_SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const LUDO_HOME = 56;
const LUDO_LAST_TRACK = 50;

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function log(state, line) {
  state.log.unshift(line);
  state.log = state.log.slice(0, 8);
}

function basePlayers(players, max) {
  return players.slice(0, max).map((p) => ({
    id: typeof p === 'string' ? p : p.id,
    bot: Boolean(p.bot),
    level: p.level === 'easy' ? 'easy' : 'hard',
    out: false
  }));
}

function baseState(type, players) {
  return {
    type,
    status: 'playing',
    players,
    turn: 0,
    winner: null,
    draw: false,
    moves: 0,
    lastMove: null,
    log: []
  };
}

function finish(state, winnerId) {
  state.status = 'finished';
  state.winner = winnerId || null;
  if (!winnerId) state.draw = true;
  return state;
}

function nextActiveTurn(state) {
  const n = state.players.length;
  for (let i = 1; i <= n; i += 1) {
    const idx = (state.turn + i) % n;
    if (!state.players[idx].out) {
      state.turn = idx;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Tic-Tac-Toe
// ---------------------------------------------------------------------------

function tttWinner(board) {
  for (const [a, b, c] of TTT_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function createTicTacToe(players) {
  const ps = basePlayers(players, 2);
  ps[0].mark = 'X';
  ps[1].mark = 'O';
  return Object.assign(baseState('tictactoe', ps), { board: Array(9).fill(null) });
}

function tttLegal(state) {
  return state.board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
}

function applyTicTacToe(state, action) {
  const cell = Number(action.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('Invalid cell');
  if (state.board[cell] !== null) throw new Error('That cell is taken');
  const me = state.players[state.turn];
  state.board[cell] = me.mark;
  state.lastMove = { cell };
  const w = tttWinner(state.board);
  if (w) return finish(state, me.id);
  if (state.board.every((v) => v !== null)) return finish(state, null);
  state.turn = 1 - state.turn;
  return state;
}

function tttMinimax(board, mark, me, depth) {
  const w = tttWinner(board);
  if (w) return { score: w === me ? 10 - depth : depth - 10 };
  const empties = board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  if (!empties.length) return { score: 0 };
  let best = null;
  for (const i of empties) {
    board[i] = mark;
    const r = tttMinimax(board, mark === 'X' ? 'O' : 'X', me, depth + 1);
    board[i] = null;
    const better = !best || (mark === me ? r.score > best.score : r.score < best.score);
    if (better) best = { score: r.score, cell: i };
  }
  return best;
}

function botTicTacToe(state) {
  const me = state.players[state.turn];
  const legal = tttLegal(state);
  if (me.level === 'easy' && Math.random() < 0.45) {
    return { cell: legal[Math.floor(Math.random() * legal.length)] };
  }
  // Perfect play: full minimax (at most 9! positions). Random choice among equally good moves.
  const board = state.board.slice();
  const opp = me.mark === 'X' ? 'O' : 'X';
  let best = -Infinity;
  let options = [];
  for (const cell of legal) {
    board[cell] = me.mark;
    const score = tttWinner(board) ? 10 : tttMinimax(board, opp, me.mark, 1).score;
    board[cell] = null;
    if (score > best) { best = score; options = [cell]; } else if (score === best) options.push(cell);
  }
  return { cell: options[Math.floor(Math.random() * options.length)] };
}

// ---------------------------------------------------------------------------
// Connect Four
// ---------------------------------------------------------------------------

function createConnectFour(players) {
  const ps = basePlayers(players, 2);
  ps[0].mark = 'R';
  ps[1].mark = 'Y';
  return Object.assign(baseState('connectfour', ps), {
    board: Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(null))
  });
}

function c4DropRow(board, col) {
  for (let r = C4_ROWS - 1; r >= 0; r -= 1) if (board[r][col] === null) return r;
  return -1;
}

function c4Wins(board, row, col, mark) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let count = 1;
    for (const s of [-1, 1]) {
      let r = row + dr * s;
      let c = col + dc * s;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS && board[r][c] === mark) {
        count += 1;
        r += dr * s;
        c += dc * s;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function c4Legal(board) {
  const cols = [];
  for (let c = 0; c < C4_COLS; c += 1) if (board[0][c] === null) cols.push(c);
  return cols;
}

function applyConnectFour(state, action) {
  const col = Number(action.col);
  if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) throw new Error('Invalid column');
  const row = c4DropRow(state.board, col);
  if (row < 0) throw new Error('That column is full');
  const me = state.players[state.turn];
  state.board[row][col] = me.mark;
  state.lastMove = { row, col };
  if (c4Wins(state.board, row, col, me.mark)) return finish(state, me.id);
  if (c4Legal(state.board).length === 0) return finish(state, null);
  state.turn = 1 - state.turn;
  return state;
}

function c4ScoreWindow(cells, me, opp) {
  const mine = cells.filter((c) => c === me).length;
  const theirs = cells.filter((c) => c === opp).length;
  const empty = cells.filter((c) => c === null).length;
  if (mine === 4) return 1000;
  if (mine === 3 && empty === 1) return 6;
  if (mine === 2 && empty === 2) return 2;
  if (theirs === 3 && empty === 1) return -8;
  if (theirs === 2 && empty === 2) return -1;
  return 0;
}

function c4Evaluate(board, me, opp) {
  let score = 0;
  for (let r = 0; r < C4_ROWS; r += 1) if (board[r][3] === me) score += 3; // centre column control
  for (let r = 0; r < C4_ROWS; r += 1) {
    for (let c = 0; c < C4_COLS; c += 1) {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const cells = [];
        for (let k = 0; k < 4; k += 1) {
          const rr = r + dr * k;
          const cc = c + dc * k;
          if (rr < 0 || rr >= C4_ROWS || cc < 0 || cc >= C4_COLS) break;
          cells.push(board[rr][cc]);
        }
        if (cells.length === 4) score += c4ScoreWindow(cells, me, opp);
      }
    }
  }
  return score;
}

const C4_ORDER = [3, 2, 4, 1, 5, 0, 6];

function c4Negamax(board, depth, alpha, beta, me, opp) {
  const legal = C4_ORDER.filter((c) => board[0][c] === null);
  if (!legal.length) return { score: 0 };
  if (depth === 0) return { score: c4Evaluate(board, me, opp) };
  let best = { score: -Infinity, col: legal[0] };
  for (const col of legal) {
    const row = c4DropRow(board, col);
    board[row][col] = me;
    let score;
    if (c4Wins(board, row, col, me)) score = 100000 + depth;
    else score = -c4Negamax(board, depth - 1, -beta, -alpha, opp, me).score;
    board[row][col] = null;
    if (score > best.score) best = { score, col };
    alpha = Math.max(alpha, score);
    if (alpha >= beta) break;
  }
  return best;
}

function botConnectFour(state) {
  const me = state.players[state.turn];
  const opp = me.mark === 'R' ? 'Y' : 'R';
  const board = clone(state.board);
  const legal = C4_ORDER.filter((c) => board[0][c] === null);
  // Easy bot: still takes an immediate win, otherwise makes a random move 35% of the time.
  if (me.level === 'easy' && Math.random() < 0.35) {
    const win = legal.find((c) => { const r = c4DropRow(board, c); board[r][c] = me.mark; const w = c4Wins(board, r, c, me.mark); board[r][c] = null; return w; });
    return { col: win !== undefined ? win : legal[Math.floor(Math.random() * legal.length)] };
  }
  const depth = me.level === 'easy' ? 2 : 6;
  // Score every root move, then pick randomly among the best so games are not identical every time.
  let best = -Infinity;
  let options = [];
  for (const col of legal) {
    const row = c4DropRow(board, col);
    board[row][col] = me.mark;
    const score = c4Wins(board, row, col, me.mark) ? 100000 + depth : -c4Negamax(board, depth - 1, -Infinity, Infinity, opp, me.mark).score;
    board[row][col] = null;
    if (score > best) { best = score; options = [col]; } else if (score === best) options.push(col);
  }
  return { col: options[Math.floor(Math.random() * options.length)] };
}

// ---------------------------------------------------------------------------
// Ludo
// ---------------------------------------------------------------------------

function ludoColorsFor(n) {
  if (n === 2) return ['red', 'yellow']; // opposite corners = fair start
  if (n === 3) return ['red', 'green', 'yellow'];
  return LUDO_COLORS.slice(0, n);
}

function createLudo(players) {
  const ps = basePlayers(players, 4);
  const colors = ludoColorsFor(ps.length);
  ps.forEach((p, i) => {
    p.color = colors[i];
    p.pieces = [-1, -1, -1, -1];
  });
  return Object.assign(baseState('ludo', ps), { dice: null, rolled: false, sixes: 0, legal: [] });
}

function ludoAbs(color, progress) {
  return (LUDO_START[color] + progress) % 52;
}

function ludoLegalMoves(state) {
  const player = state.players[state.turn];
  const dice = state.dice;
  const moves = [];
  if (!dice) return moves;
  player.pieces.forEach((p, piece) => {
    if (p === LUDO_HOME) return;
    if (p === -1) {
      if (dice === 6) moves.push({ piece, to: 0 });
      return;
    }
    const to = p + dice;
    if (to > LUDO_HOME) return; // needs the exact number to finish
    moves.push({ piece, to });
  });
  // Work out captures for each candidate.
  for (const m of moves) {
    if (m.to > LUDO_LAST_TRACK) continue;
    const abs = ludoAbs(player.color, m.to);
    if (LUDO_SAFE.has(abs)) continue;
    state.players.forEach((other, oi) => {
      if (oi === state.turn || other.out) return;
      other.pieces.forEach((op, opIdx) => {
        if (op >= 0 && op <= LUDO_LAST_TRACK && ludoAbs(other.color, op) === abs) {
          m.capture = m.capture || [];
          m.capture.push({ player: oi, piece: opIdx });
        }
      });
    });
  }
  return moves;
}

function ludoEndTurn(state, bonus) {
  state.dice = null;
  state.rolled = false;
  state.legal = [];
  if (!bonus) {
    state.sixes = 0;
    nextActiveTurn(state);
  }
}

function applyLudo(state, action, rng) {
  const player = state.players[state.turn];
  if (action.kind === 'roll') {
    if (state.rolled) throw new Error('You already rolled — move a piece');
    const dice = 1 + Math.floor((rng || Math.random)() * 6);
    state.dice = dice;
    state.rolled = true;
    state.lastMove = { roll: dice, color: player.color };
    if (dice === 6) state.sixes += 1;
    if (state.sixes === 3) {
      log(state, `${player.color} rolled three 6s — turn lost`);
      ludoEndTurn(state, false);
      return state;
    }
    state.legal = ludoLegalMoves(state);
    if (!state.legal.length) {
      log(state, `${player.color} rolled ${dice} — no move`);
      ludoEndTurn(state, false);
    }
    return state;
  }

  if (action.kind === 'move') {
    if (!state.rolled) throw new Error('Roll the dice first');
    const piece = Number(action.piece);
    const move = ludoLegalMoves(state).find((m) => m.piece === piece);
    if (!move) throw new Error('That piece cannot move');
    player.pieces[piece] = move.to;
    state.lastMove = { color: player.color, piece, to: move.to, roll: state.dice };
    let bonus = state.dice === 6;
    if (move.capture) {
      for (const cap of move.capture) state.players[cap.player].pieces[cap.piece] = -1;
      log(state, `${player.color} captured ${move.capture.map((c) => state.players[c.player].color).join(', ')}`);
      bonus = true;
    }
    if (move.to === LUDO_HOME) {
      log(state, `${player.color} brought a piece home`);
      bonus = true;
    }
    if (player.pieces.every((p) => p === LUDO_HOME)) return finish(state, player.id);
    ludoEndTurn(state, bonus);
    return state;
  }

  throw new Error('Unknown action');
}

function botLudo(state) {
  if (!state.rolled) return { kind: 'roll' };
  const player = state.players[state.turn];
  const moves = ludoLegalMoves(state);
  const danger = (color, progress) => {
    // Is an opponent 1-6 squares behind this square?
    if (progress > LUDO_LAST_TRACK) return false;
    const abs = ludoAbs(color, progress);
    if (LUDO_SAFE.has(abs)) return false;
    return state.players.some((o) => o.color !== color && !o.out && o.pieces.some((op) => {
      if (op < 0 || op > LUDO_LAST_TRACK) return false;
      const d = (abs - ludoAbs(o.color, op) + 52) % 52;
      return d >= 1 && d <= 6;
    }));
  };
  let best = null;
  for (const m of moves) {
    const from = player.pieces[m.piece];
    let score = 0;
    if (m.capture) score += 100;
    if (m.to === LUDO_HOME) score += 80;
    if (from === -1) score += 60;
    if (m.to > LUDO_LAST_TRACK && from <= LUDO_LAST_TRACK) score += 40; // reach the safe home column
    if (m.to <= LUDO_LAST_TRACK && LUDO_SAFE.has(ludoAbs(player.color, m.to))) score += 25;
    if (danger(player.color, from) && !danger(player.color, m.to)) score += 30;
    if (danger(player.color, m.to)) score -= 35;
    score += m.to / 10; // prefer advancing the leader slightly
    if (player.level === 'easy') score += Math.random() * 80;
    if (!best || score > best.score) best = { score, piece: m.piece };
  }
  return { kind: 'move', piece: best.piece };
}

// ---------------------------------------------------------------------------
// Generic API
// ---------------------------------------------------------------------------

const ENGINES = {
  tictactoe: { create: createTicTacToe, apply: applyTicTacToe, bot: botTicTacToe, min: 2, max: 2 },
  connectfour: { create: createConnectFour, apply: applyConnectFour, bot: botConnectFour, min: 2, max: 2 },
  ludo: { create: createLudo, apply: applyLudo, bot: botLudo, min: 2, max: 4 }
};

function engine(type) {
  const e = ENGINES[type];
  if (!e) throw new Error('Unknown game');
  return e;
}

function createGame(type, players) {
  const e = engine(type);
  if (players.length < e.min) throw new Error(`Need at least ${e.min} players`);
  return e.create(players);
}

function currentPlayer(state) {
  return state.players[state.turn];
}

function applyAction(state, playerId, action, rng) {
  if (state.status !== 'playing') throw new Error('Game is over');
  const next = clone(state);
  const cur = currentPlayer(next);
  if (!cur || cur.id !== playerId) throw new Error('Not your turn');
  engine(next.type).apply(next, action || {}, rng);
  next.moves += 1;
  return next;
}

function botAction(state) {
  return engine(state.type).bot(state);
}

/** Used when a human runs out of time: make a random legal move so the game never stalls. */
function autoAction(state) {
  if (state.type === 'tictactoe') {
    const legal = tttLegal(state);
    return { cell: legal[Math.floor(Math.random() * legal.length)] };
  }
  if (state.type === 'connectfour') {
    const legal = c4Legal(state.board);
    return { col: legal[Math.floor(Math.random() * legal.length)] };
  }
  if (state.type === 'ludo') {
    if (!state.rolled) return { kind: 'roll' };
    const legal = ludoLegalMoves(state);
    return { kind: 'move', piece: legal[Math.floor(Math.random() * legal.length)].piece };
  }
  throw new Error('Unknown game');
}

/** A player left or forfeited. */
function forfeit(state, playerId) {
  const next = clone(state);
  if (next.status !== 'playing') return next;
  const idx = next.players.findIndex((p) => p.id === playerId);
  if (idx < 0 || next.players[idx].out) return next;
  next.players[idx].out = true;
  log(next, `${next.players[idx].color || next.players[idx].mark} left the game`);
  const remaining = next.players.filter((p) => !p.out);
  if (remaining.length === 1) return finish(next, remaining[0].id);
  if (remaining.length === 0) return finish(next, null);
  if (next.turn === idx) {
    if (next.type === 'ludo') ludoEndTurn(next, false);
    else nextActiveTurn(next);
  }
  return next;
}

module.exports = {
  createGame,
  applyAction,
  botAction,
  autoAction,
  forfeit,
  currentPlayer,
  minPlayers: (t) => engine(t).min,
  maxPlayers: (t) => engine(t).max,
  ludoLegalMoves,
  GAME_TYPES: Object.keys(ENGINES),
  _internal: { tttWinner, c4Wins, LUDO_HOME, LUDO_START, ludoAbs }
};
