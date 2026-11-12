#!/usr/bin/env node
/* How strong are the offline game bots? Plays N games against a random-move opponent. */
'use strict';
const fs = require('fs');
const path = require('path');
const games = require('../server/games');

function play(type, botFirst, level, opponent = 'random') {
  const bot = { id: 'bot', bot: true, level };
  const other = opponent === 'random' ? { id: 'rnd' } : { id: 'rnd', bot: true, level: opponent };
  let s = games.createGame(type, botFirst ? [bot, other] : [other, bot]);
  const times = [];
  while (s.status === 'playing') {
    const cur = games.currentPlayer(s);
    const t = process.hrtime.bigint();
    const isBot = cur.id === 'bot' || (opponent !== 'random');
    const action = isBot ? games.botAction(s) : games.autoAction(s);
    if (cur.id === 'bot') times.push(Number(process.hrtime.bigint() - t) / 1e6);
    s = games.applyAction(s, cur.id, action);
  }
  return { result: s.winner === 'bot' ? 'win' : s.winner ? 'loss' : 'draw', times };
}

function run(type, level, n, opponent) {
  const r = { win: 0, loss: 0, draw: 0 };
  let all = [];
  for (let i = 0; i < n; i += 1) {
    const g = play(type, i % 2 === 0, level, opponent);
    r[g.result] += 1;
    all = all.concat(g.times);
  }
  all.sort((a, b) => a - b);
  return { type, level, vs: opponent, games: n, ...r, winRate: `${((100 * r.win) / n).toFixed(1)}%`, lossRate: `${((100 * r.loss) / n).toFixed(1)}%`, medianMoveMs: +all[Math.floor(all.length / 2)].toFixed(2), p95MoveMs: +all[Math.floor(all.length * 0.95)].toFixed(2) };
}

const rows = [
  run('tictactoe', 'hard', 1000, 'random'),
  run('tictactoe', 'easy', 1000, 'random'),
  run('connectfour', 'hard', 200, 'random'),
  run('connectfour', 'hard', 100, 'easy'),
  run('ludo', 'hard', 300, 'random'),
  run('ludo', 'hard', 300, 'easy')
];
console.table(rows);
fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results', 'bot-strength.json'), JSON.stringify(rows, null, 2));
