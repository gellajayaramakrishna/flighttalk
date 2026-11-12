'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const games = require('../server/games');

const A = 'alice';
const B = 'bob';

function play(state, moves) {
  let s = state;
  for (const [who, action] of moves) s = games.applyAction(s, who, action);
  return s;
}

test('tic-tac-toe: win, turn order and illegal moves', () => {
  const s0 = games.createGame('tictactoe', [{ id: A }, { id: B }]);
  assert.throws(() => games.applyAction(s0, B, { cell: 0 }), /Not your turn/);
  const s1 = games.applyAction(s0, A, { cell: 0 });
  assert.throws(() => games.applyAction(s1, B, { cell: 0 }), /taken/);
  assert.equal(s0.board[0], null, 'state is immutable');
  const s = play(s1, [[B, { cell: 3 }], [A, { cell: 1 }], [B, { cell: 4 }], [A, { cell: 2 }]]);
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, A);
  assert.throws(() => games.applyAction(s, B, { cell: 8 }), /over/);
});

test('tic-tac-toe: draw', () => {
  const order = [0, 1, 2, 4, 3, 5, 7, 6, 8];
  const s = play(games.createGame('tictactoe', [{ id: A }, { id: B }]), order.map((c, i) => [i % 2 ? B : A, { cell: c }]));
  assert.equal(s.draw, true);
  assert.equal(s.winner, null);
});

test('connect four: vertical and diagonal wins, full column', () => {
  let s = games.createGame('connectfour', [{ id: A }, { id: B }]);
  s = play(s, [[A, { col: 0 }], [B, { col: 1 }], [A, { col: 0 }], [B, { col: 1 }], [A, { col: 0 }], [B, { col: 1 }], [A, { col: 0 }]]);
  assert.equal(s.winner, A);

  // Diagonal for A: (5,0) (4,1) (3,2) (2,3)
  s = games.createGame('connectfour', [{ id: A }, { id: B }]);
  s = play(s, [
    [A, { col: 0 }], [B, { col: 1 }], [A, { col: 1 }], [B, { col: 2 }], [A, { col: 2 }], [B, { col: 3 }],
    [A, { col: 2 }], [B, { col: 3 }], [A, { col: 3 }], [B, { col: 6 }], [A, { col: 3 }]
  ]);
  assert.equal(s.winner, A);

  s = games.createGame('connectfour', [{ id: A }, { id: B }]);
  for (let i = 0; i < 6; i += 1) s = games.applyAction(s, i % 2 ? B : A, { col: 4 });
  assert.throws(() => games.applyAction(s, A, { col: 4 }), /full/);
});

function rngSeq(...dice) {
  const seq = dice.map((d) => (d - 1) / 6 + 0.01);
  return () => seq.shift();
}

test('ludo: need a 6 to leave the yard, and a 6 gives another roll', () => {
  let s = games.createGame('ludo', [{ id: A }, { id: B }]);
  assert.deepEqual(s.players.map((p) => p.color), ['red', 'yellow']);
  s = games.applyAction(s, A, { kind: 'roll' }, rngSeq(3));
  assert.equal(s.turn, 1, 'no legal move -> turn passes');
  s = games.applyAction(s, B, { kind: 'roll' }, rngSeq(6));
  assert.equal(s.rolled, true);
  s = games.applyAction(s, B, { kind: 'move', piece: 0 });
  assert.equal(s.players[1].pieces[0], 0);
  assert.equal(s.turn, 1, 'rolled a 6 -> same player again');
});

test('ludo: capture sends the victim home and grants a bonus roll; safe squares protect', () => {
  let s = games.createGame('ludo', [{ id: A }, { id: B }]);
  // red piece at progress 10 (abs 10); yellow piece at progress 36 => abs (26+36)%52 = 10
  s.players[0].pieces = [10, -1, -1, -1];
  s.players[1].pieces = [33, -1, -1, -1];
  s.turn = 1;
  s = games.applyAction(s, B, { kind: 'roll' }, rngSeq(3));
  s = games.applyAction(s, B, { kind: 'move', piece: 0 });
  assert.equal(s.players[0].pieces[0], -1, 'red captured');
  assert.equal(s.turn, 1, 'capture -> bonus roll');

  // Safe square: red on abs 8 (star) cannot be captured.
  s = games.createGame('ludo', [{ id: A }, { id: B }]);
  s.players[0].pieces = [8, -1, -1, -1];
  s.players[1].pieces = [32, -1, -1, -1]; // abs 6
  s.turn = 1;
  s = games.applyAction(s, B, { kind: 'roll' }, rngSeq(2)); // -> progress 34 = abs 8
  s = games.applyAction(s, B, { kind: 'move', piece: 0 });
  assert.equal(s.players[0].pieces[0], 8, 'still there');
});

test('ludo: exact roll needed to finish, all four home wins', () => {
  let s = games.createGame('ludo', [{ id: A }, { id: B }]);
  s.players[0].pieces = [56, 56, 56, 53];
  s = games.applyAction(s, A, { kind: 'roll' }, rngSeq(5));
  assert.equal(s.turn, 1, '53+5 overshoots -> no move');
  s.turn = 0;
  s = games.applyAction(s, A, { kind: 'roll' }, rngSeq(3));
  s = games.applyAction(s, A, { kind: 'move', piece: 3 });
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, A);
});

test('ludo: three sixes in a row forfeits the turn', () => {
  let s = games.createGame('ludo', [{ id: A }, { id: B }]);
  s.players[0].pieces = [5, -1, -1, -1];
  for (let i = 0; i < 2; i += 1) {
    s = games.applyAction(s, A, { kind: 'roll' }, rngSeq(6));
    s = games.applyAction(s, A, { kind: 'move', piece: 0 });
  }
  s = games.applyAction(s, A, { kind: 'roll' }, rngSeq(6));
  assert.equal(s.turn, 1);
});

test('forfeit: two-player game ends, Ludo continues without the player', () => {
  let s = games.createGame('connectfour', [{ id: A }, { id: B }]);
  s = games.forfeit(s, A);
  assert.equal(s.winner, B);
  let l = games.createGame('ludo', [{ id: A }, { id: B }, { id: 'c' }]);
  l = games.forfeit(l, A);
  assert.equal(l.status, 'playing');
  assert.equal(l.turn, 1, 'turn moved past the player who left');
});

function randomGame(type, botFirst, level) {
  const players = botFirst ? [{ id: 'bot', bot: true, level }, { id: 'rnd' }] : [{ id: 'rnd' }, { id: 'bot', bot: true, level }];
  let s = games.createGame(type, players);
  while (s.status === 'playing') {
    const cur = games.currentPlayer(s);
    const action = cur.bot ? games.botAction(s) : games.autoAction(s);
    s = games.applyAction(s, cur.id, action);
  }
  return s.winner === 'bot' ? 'win' : s.winner ? 'loss' : 'draw';
}

test('tic-tac-toe bot (hard) never loses in 300 games vs random play', () => {
  const r = { win: 0, loss: 0, draw: 0 };
  for (let i = 0; i < 300; i += 1) r[randomGame('tictactoe', i % 2 === 0, 'hard')] += 1;
  assert.equal(r.loss, 0, JSON.stringify(r));
});

test('connect four bot (hard) beats random play at least 95% of the time', () => {
  const r = { win: 0, loss: 0, draw: 0 };
  for (let i = 0; i < 60; i += 1) r[randomGame('connectfour', i % 2 === 0, 'hard')] += 1;
  assert.ok(r.win / 60 >= 0.95, JSON.stringify(r));
});

test('ludo bots always finish a 4-bot game with only legal moves', () => {
  let s = games.createGame('ludo', [1, 2, 3, 4].map((i) => ({ id: `b${i}`, bot: true })));
  let steps = 0;
  while (s.status === 'playing' && steps < 20000) {
    const cur = games.currentPlayer(s);
    s = games.applyAction(s, cur.id, games.botAction(s));
    steps += 1;
  }
  assert.equal(s.status, 'finished');
  assert.ok(s.players.find((p) => p.id === s.winner).pieces.every((p) => p === 56));
});
