// Live Quiz – a lightweight Slido/Menti-style quiz with speed scoring.
// Zero dependencies: needs Node.js 18+ only. Run:  node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || 'quizmaster';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const GRACE_MS = 500; // small allowance for network lag at the buzzer
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// ---------- Quiz content ----------
let quiz = loadQuiz();

function loadQuiz() {
  const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  const s = raw.settings || {};
  const settings = {
    secondsPerQuestion: s.secondsPerQuestion ?? 20,
    basePoints: s.basePoints ?? 500,
    speedBonus: s.speedBonus ?? 500,
    revealWhenAllAnswered: s.revealWhenAllAnswered ?? true,
  };
  if (!Array.isArray(raw.questions) || !raw.questions.length) throw new Error('questions.json needs a "questions" list');
  const questions = raw.questions.map((q, i) => {
    const n = i + 1;
    if (!q.text) throw new Error(`Question ${n}: missing "text"`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) throw new Error(`Question ${n}: needs 2 to 6 "options"`);
    if (!Number.isInteger(q.correct) || q.correct < 1 || q.correct > q.options.length) throw new Error(`Question ${n}: "correct" must be the option number (1 = first option)`);
    return { text: q.text, options: q.options.map(String), answerIdx: q.correct - 1, seconds: q.seconds || settings.secondsPerQuestion };
  });
  return { title: raw.title || 'Live Quiz', settings, questions };
}

// ---------- Game state (in memory – export before stopping the server) ----------
const state = freshState();
function freshState() {
  return { phase: 'lobby', qIndex: -1, qStartedAt: 0, qEndsAt: 0, revealedUpTo: -1, players: new Map(), answers: [] };
}
let timer = null;
const clients = new Set();

const currentQ = () => quiz.questions[state.qIndex];
const secs = (ms) => Math.round(ms / 10) / 100;
const nameOf = (id) => state.players.get(id)?.name || '(left)';

function leaderboard() {
  return [...state.players.values()]
    .map((p) => ({
      id: p.id, name: p.name, score: p.score, correct: p.correct, answered: p.answered, wins: p.wins,
      avgCorrectSecs: p.correct ? secs(p.correctMs / p.correct) : null,
      fastestSecs: p.fastestMs == null ? null : secs(p.fastestMs),
    }))
    .sort((a, b) => b.score - a.score || b.correct - a.correct || (a.avgCorrectSecs ?? 1e9) - (b.avgCorrectSecs ?? 1e9))
    .map((p, i) => ({ rank: i + 1, ...p }));
}

function questionStats(i) {
  const q = quiz.questions[i];
  const list = state.answers[i] || [];
  const correct = list.filter((a) => a.correct).sort((a, b) => a.ms - b.ms);
  return {
    counts: q.options.map((_, k) => list.filter((a) => a.choice === k).length),
    answered: list.length,
    correctCount: correct.length,
    fastest: correct.slice(0, 5).map((a) => ({ name: nameOf(a.playerId), secs: secs(a.ms), points: a.points })),
  };
}

function summary() {
  const out = [];
  for (let i = 0; i <= state.revealedUpTo; i++) {
    const st = questionStats(i);
    const list = state.answers[i] || [];
    out.push({
      n: i + 1, text: quiz.questions[i].text, answered: st.answered,
      pctCorrect: st.answered ? Math.round((st.correctCount / st.answered) * 100) : 0,
      avgSecs: list.length ? secs(list.reduce((t, a) => t + a.ms, 0) / list.length) : null,
      fastest: st.fastest[0] || null,
    });
  }
  return out;
}

function awards() {
  const asked = state.revealedUpTo + 1;
  const lb = leaderboard();
  let fastestSingle = null;
  state.answers.slice(0, asked).forEach((list, i) => list.forEach((a) => {
    if (a.correct && (!fastestSingle || a.ms < fastestSingle.ms)) fastestSingle = { ms: a.ms, name: nameOf(a.playerId), q: i + 1 };
  }));
  const winsTop = [...lb].sort((a, b) => b.wins - a.wins)[0];
  const minCorrect = Math.max(1, Math.ceil(asked / 2));
  const avgTop = lb.filter((p) => p.correct >= minCorrect).sort((a, b) => a.avgCorrectSecs - b.avgCorrectSecs)[0];
  return {
    fastestSingle: fastestSingle && { name: fastestSingle.name, secs: secs(fastestSingle.ms), q: fastestSingle.q },
    mostFastestFinger: winsTop && winsTop.wins > 0 ? { name: winsTop.name, wins: winsTop.wins } : null,
    quickestAverage: avgTop ? { name: avgTop.name, secs: avgTop.avgCorrectSecs, minCorrect } : null,
  };
}

function joinUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return `http://${n.address}:${PORT}`;
  }
  return `http://localhost:${PORT}`;
}

// What each connected screen is allowed to see
function viewFor(c) {
  const q = currentQ();
  const v = { phase: state.phase, title: quiz.title, qNumber: state.qIndex + 1, qTotal: quiz.questions.length, playerCount: state.players.size };
  if (q && (state.phase === 'question' || state.phase === 'reveal')) {
    v.question = { text: q.text, options: q.options, seconds: q.seconds, remainingMs: Math.max(0, state.qEndsAt - Date.now()) };
    if (state.phase === 'reveal') { v.question.correct = q.answerIdx; v.stats = questionStats(state.qIndex); }
  }
  const lb = leaderboard();
  if (c.role === 'host') {
    Object.assign(v, {
      joinUrl: joinUrl(), players: [...state.players.values()].map((p) => p.name),
      answered: (state.answers[state.qIndex] || []).length, leaderboard: lb, summary: summary(),
      isLast: state.qIndex + 1 >= quiz.questions.length,
    });
    if (state.phase === 'finished') v.awards = awards();
    return v;
  }
  const p = state.players.get(c.playerId);
  if (!p) return { unknownPlayer: true };
  const me = lb.find((x) => x.id === p.id);
  v.me = { name: p.name, score: p.score, rank: me.rank, correct: p.correct, wins: p.wins };
  const a = (state.answers[state.qIndex] || []).find((x) => x.playerId === p.id);
  if (state.phase === 'question' && a) v.myAnswer = { choice: a.choice, secs: secs(a.ms) };
  if (state.phase === 'reveal') v.myAnswer = a ? { choice: a.choice, secs: secs(a.ms), correct: a.correct, points: a.points, speedRank: a.speedRank || null } : null;
  if (state.phase === 'leaderboard' || state.phase === 'finished') v.top = lb.slice(0, 5).map(({ rank, name, score }) => ({ rank, name, score }));
  return v;
}

function send(c) { c.res.write(`data: ${JSON.stringify(viewFor(c))}\n\n`); }
function broadcast() { for (const c of clients) send(c); }
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000);

// ---------- Game flow ----------
function startQuestion() {
  clearTimeout(timer);
  state.qIndex++;
  const q = currentQ();
  state.phase = 'question';
  state.qStartedAt = Date.now();
  state.qEndsAt = state.qStartedAt + q.seconds * 1000;
  state.answers[state.qIndex] = [];
  const idx = state.qIndex;
  timer = setTimeout(() => { if (state.qIndex === idx) revealQuestion(); }, q.seconds * 1000 + GRACE_MS);
  broadcast();
}

function revealQuestion() {
  if (state.phase !== 'question') return;
  clearTimeout(timer);
  const list = state.answers[state.qIndex];
  const correct = list.filter((a) => a.correct).sort((a, b) => a.ms - b.ms);
  correct.forEach((a, i) => { a.speedRank = i + 1; });
  for (const a of list) {
    const p = state.players.get(a.playerId);
    if (!p) continue;
    p.answered++; p.score += a.points;
    if (a.correct) { p.correct++; p.correctMs += a.ms; if (p.fastestMs == null || a.ms < p.fastestMs) p.fastestMs = a.ms; }
  }
  if (correct[0] && state.players.get(correct[0].playerId)) state.players.get(correct[0].playerId).wins++;
  state.revealedUpTo = state.qIndex;
  state.phase = 'reveal';
  broadcast();
}

function finishQuiz() {
  if (state.phase === 'question') revealQuestion();
  state.phase = 'finished';
  broadcast();
}

function resetQuiz() {
  clearTimeout(timer);
  quiz = loadQuiz(); // picks up any edits to questions.json
  Object.assign(state, freshState());
  broadcast();
}

// ---------- CSV exports ----------
function csv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // stop Excel treating names as formulas
    return `"${s.replace(/"/g, '""')}"`;
  };
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

function responsesCsv() {
  const rows = [['Question #', 'Question', 'Participant', 'Answer given', 'Correct answer', 'Correct?', 'Response time (s)', 'Speed rank (correct answers)', 'Points']];
  for (let i = 0; i <= state.revealedUpTo; i++) {
    const q = quiz.questions[i];
    const list = state.answers[i] || [];
    for (const p of state.players.values()) {
      const a = list.find((x) => x.playerId === p.id);
      rows.push([i + 1, q.text, p.name, a ? q.options[a.choice] : 'No answer', q.options[q.answerIdx],
        a ? (a.correct ? 'Yes' : 'No') : 'No', a ? secs(a.ms) : '', a?.speedRank || '', a ? a.points : 0]);
    }
  }
  return csv(rows);
}

function leaderboardCsv() {
  const rows = [['Rank', 'Participant', 'Score', 'Correct answers', 'Questions answered', 'Questions asked', 'Fastest-finger wins', 'Avg time on correct answers (s)', 'Fastest correct answer (s)']];
  for (const p of leaderboard()) rows.push([p.rank, p.name, p.score, p.correct, p.answered, state.revealedUpTo + 1, p.wins, p.avgCorrectSecs ?? '', p.fastestSecs ?? '']);
  return csv(rows);
}

// ---------- HTTP ----------
function json(res, code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function readJson(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function sendFile(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
}
const isHost = (req, url) => (req.headers['x-host-key'] || url.searchParams.get('key')) === HOST_KEY;
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/join')) return sendFile(res, 'player.html');
    if (req.method === 'GET' && p === '/host') return sendFile(res, 'host.html');

    if (req.method === 'GET' && p === '/events') {
      const role = url.searchParams.get('role') === 'host' ? 'host' : 'player';
      if (role === 'host' && !isHost(req, url)) { res.writeHead(401); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      const c = { res, role, playerId: url.searchParams.get('id') };
      clients.add(c); send(c);
      req.on('close', () => clients.delete(c));
      return;
    }

    if (req.method === 'POST' && p === '/api/join') {
      if (state.phase === 'finished') return json(res, 409, { error: 'This quiz has finished.' });
      const body = await readJson(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (!name) return json(res, 400, { error: 'Please enter a name.' });
      const taken = new Set([...state.players.values()].map((x) => x.name.toLowerCase()));
      let finalName = name, n = 2;
      while (taken.has(finalName.toLowerCase())) finalName = `${name} (${n++})`;
      const id = crypto.randomUUID();
      state.players.set(id, { id, name: finalName, score: 0, correct: 0, answered: 0, wins: 0, correctMs: 0, fastestMs: null });
      json(res, 200, { id, name: finalName });
      return broadcast();
    }

    if (req.method === 'POST' && p === '/api/answer') {
      const now = Date.now();
      const body = await readJson(req);
      const player = state.players.get(body.id);
      if (!player) return json(res, 404, { error: 'Please re-join the quiz.' });
      if (state.phase !== 'question' || now > state.qEndsAt + GRACE_MS) return json(res, 409, { error: "Time's up!" });
      const q = currentQ();
      const choice = Number(body.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return json(res, 400, { error: 'Invalid answer.' });
      const list = state.answers[state.qIndex];
      if (list.some((a) => a.playerId === player.id)) return json(res, 409, { error: 'You have already answered.' });
      const ms = Math.max(0, now - state.qStartedAt);
      const correct = choice === q.answerIdx;
      const { basePoints, speedBonus } = quiz.settings;
      const points = correct ? basePoints + Math.round(speedBonus * Math.max(0, 1 - ms / (q.seconds * 1000))) : 0;
      list.push({ playerId: player.id, choice, ms, correct, points });
      json(res, 200, { ok: true, secs: secs(ms) });
      if (quiz.settings.revealWhenAllAnswered && list.length >= state.players.size) return revealQuestion();
      return broadcast();
    }

    if (p.startsWith('/api/host/') || p.startsWith('/api/export/')) {
      if (!isHost(req, url)) return json(res, 401, { error: 'Wrong host key.' });
      if (req.method === 'GET' && p === '/api/export/responses.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quiz-responses-${stamp()}.csv"` });
        return res.end(responsesCsv());
      }
      if (req.method === 'GET' && p === '/api/export/leaderboard.csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="quiz-leaderboard-${stamp()}.csv"` });
        return res.end(leaderboardCsv());
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
      const action = p.slice('/api/host/'.length);
      if (action === 'check') return json(res, 200, { ok: true });
      if (action === 'next') {
        if (state.phase === 'question') return json(res, 409, { error: 'Reveal the answer first.' });
        if (state.phase === 'finished') return json(res, 409, { error: 'Quiz has finished. Reset to run again.' });
        if (state.qIndex + 1 >= quiz.questions.length) finishQuiz(); else startQuestion();
        return json(res, 200, { ok: true });
      }
      if (action === 'reveal') { revealQuestion(); return json(res, 200, { ok: true }); }
      if (action === 'leaderboard') {
        if (state.phase === 'question') revealQuestion();
        if (state.phase !== 'finished') { state.phase = 'leaderboard'; broadcast(); }
        return json(res, 200, { ok: true });
      }
      if (action === 'finish') { finishQuiz(); return json(res, 200, { ok: true }); }
      if (action === 'reset') { resetQuiz(); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'Unknown action.' });
    }

    res.writeHead(404); res.end('Not found');
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\nLive Quiz running: "${quiz.title}" (${quiz.questions.length} questions)`);
  console.log(`  Host screen : http://localhost:${PORT}/host   (host key: ${HOST_KEY})`);
  console.log(`  Players join: ${joinUrl()}\n`);
  if (HOST_KEY === 'quizmaster') console.log('  Tip: set your own key, e.g.  HOST_KEY=mysecret node server.js\n');
});
