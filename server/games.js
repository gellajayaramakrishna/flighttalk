'use strict';

const TTT_WINS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

const LUDO_START = [0, 13, 26, 39];
const LUDO_SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createTicTacToe(playerIds) {
  return {
    type: 'tictactoe',
    players: playerIds.slice(0, 2),
    board: Array(9).fill(null),
    turn: 0,
    winner: null,
    draw: false
  };
}

function applyTicTacToe(state, userId, action) {
  if (state.winner || state.draw) throw new Error('Game already finished');
  const idx = state.players.indexOf(userId);
  if (idx !== state.turn) throw new Error('Not your turn');
  const cell = Number(action.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('Invalid cell');
  if (state.board[cell] !== null) throw new Error('Cell occupied');
  const mark = idx === 0 ? 'X' : 'O';
  state.board[cell] = mark;
  for (const line of TTT_WINS) {
    if (line.every((i) => state.board[i] === mark)) {
      state.winner = userId;
      return state;
    }
  }
  if (state.board.every((v) => v !== null)) state.draw = true;
  else state.turn = 1 - state.turn;
  return state;
}

function createConnectFour(playerIds) {
  return {
    type: 'connectfour',
    players: playerIds.slice(0, 2),
    board: Array.from({ length: 6 }, () => Array(7).fill(null)),
    turn: 0,
    winner: null,
    draw: false
  };
}

function connectFourWin(board, row, col, mark) {
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    let count = 1;
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < 6 && c >= 0 && c < 7 && board[r][c] === mark) {
        count += 1;
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (count >= 4) return true;
  }
  return false;
}

function applyConnectFour(state, userId, action) {
  if (state.winner || state.draw) throw new Error('Game already finished');
  const idx = state.players.indexOf(userId);
  if (idx !== state.turn) throw new Error('Not your turn');
  const col = Number(action.col);
  if (!Number.isInteger(col) || col < 0 || col > 6) throw new Error('Invalid column');
  let row = -1;
  for (let r = 5; r >= 0; r -= 1) {
    if (state.board[r][col] === null) {
      row = r;
      break;
    }
  }
  if (row === -1) throw new Error('Column full');
  const mark = idx === 0 ? 'R' : 'Y';
  state.board[row][col] = mark;
  if (connectFourWin(state.board, row, col, mark)) state.winner = userId;
  else if (state.board.every((line) => line.every((cell) => cell !== null))) state.draw = true;
  else state.turn = 1 - state.turn;
  return state;
}

function createLudo(playerIds) {
  const colors = ['red', 'green', 'yellow', 'blue'];
  const players = playerIds.slice(0, 4).map((id, i) => ({
    userId: id,
    color: colors[i],
    pieces: [-1, -1, -1, -1]
  }));
  return {
    type: 'ludo',
    players,
    turn: 0,
    dice: null,
    rolled: false,
    extra: false,
    winner: null,
    log: []
  };
}

function ludoToAbs(playerIndex, steps) {
  return (LUDO_START[playerIndex] + steps) % 52;
}

function applyLudo(state, userId, action) {
  if (state.winner) throw new Error('Game already finished');
  const pIndex = state.players.findIndex((p) => p.userId === userId);
  if (pIndex !== state.turn) throw new Error('Not your turn');
  const player = state.players[pIndex];

  if (action.kind === 'roll') {
    if (state.rolled) throw new Error('Dice already rolled');
    state.dice = 1 + Math.floor(Math.random() * 6);
    state.rolled = true;
    state.extra = state.dice === 6;
    const moves = legalLudoMoves(state, pIndex);
    if (moves.length === 0) {
      state.log.unshift('No legal move');
      advanceLudoTurn(state);
    }
    return state;
  }

  if (action.kind === 'move') {
    if (!state.rolled || !state.dice) throw new Error('Roll first');
    const piece = Number(action.piece);
    if (!Number.isInteger(piece) || piece < 0 || piece > 3) throw new Error('Invalid piece');
    const moves = legalLudoMoves(state, pIndex);
    const chosen = moves.find((m) => m.piece === piece);
    if (!chosen) throw new Error('Illegal move');
    player.pieces[piece] = chosen.next;
    if (chosen.capture) {
      const victim = state.players[chosen.capture.player];
      victim.pieces[chosen.capture.piece] = -1;
      state.extra = true;
      state.log.unshift(`${player.color} captured a piece`);
    }
    if (player.pieces.every((pos) => pos === 106)) {
      state.winner = userId;
      return state;
    }
    if (state.extra) {
      state.rolled = false;
      state.dice = null;
      state.extra = false;
    } else {
      advanceLudoTurn(state);
    }
    return state;
  }

  throw new Error('Unknown action');
}

function legalLudoMoves(state, pIndex) {
  const dice = state.dice;
  const player = state.players[pIndex];
  const moves = [];
  player.pieces.forEach((pos, piece) => {
    if (pos === 106) return;
    if (pos === -1) {
      if (dice === 6) moves.push({ piece, next: 0 });
      return;
    }
    if (pos >= 0 && pos <= 51) {
      const nextSteps = pos + dice;
      if (nextSteps === 51) {
        moves.push({ piece, next: 100 });
        return;
      }
      if (nextSteps > 51) {
        const homePos = 100 + (nextSteps - 52);
        if (homePos <= 105) moves.push({ piece, next: homePos });
        return;
      }
      const abs = ludoToAbs(pIndex, nextSteps);
      const capture = findCapture(state, pIndex, abs);
      moves.push({ piece, next: nextSteps, capture });
      return;
    }
    if (pos >= 100 && pos <= 105) {
      const next = pos + dice;
      if (next === 106) moves.push({ piece, next: 106 });
      else if (next < 106) moves.push({ piece, next });
    }
  });
  return moves;
}

function findCapture(state, pIndex, absPos) {
  if (LUDO_SAFE.has(absPos)) return null;
  for (let i = 0; i < state.players.length; i += 1) {
    if (i === pIndex) continue;
    const other = state.players[i];
    for (let p = 0; p < 4; p += 1) {
      const pos = other.pieces[p];
      if (pos >= 0 && pos <= 51 && ludoToAbs(i, pos) === absPos) {
        return { player: i, piece: p };
      }
    }
  }
  return null;
}

function advanceLudoTurn(state) {
  state.rolled = false;
  state.dice = null;
  state.extra = false;
  state.turn = (state.turn + 1) % state.players.length;
}

function createGame(type, playerIds) {
  if (type === 'tictactoe') return createTicTacToe(playerIds);
  if (type === 'connectfour') return createConnectFour(playerIds);
  if (type === 'ludo') return createLudo(playerIds);
  throw new Error('Unknown game');
}

function applyAction(state, userId, action) {
  const next = clone(state);
  if (next.type === 'tictactoe') return applyTicTacToe(next, userId, action);
  if (next.type === 'connectfour') return applyConnectFour(next, userId, action);
  if (next.type === 'ludo') return applyLudo(next, userId, action);
  throw new Error('Unknown game');
}

function minPlayers(type) {
  if (type === 'ludo') return 2;
  return 2;
}

function maxPlayers(type) {
  if (type === 'ludo') return 4;
  return 2;
}

module.exports = {
  createGame,
  applyAction,
  minPlayers,
  maxPlayers,
  legalLudoMoves
};
