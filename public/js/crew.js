/* FlightTalk crew console. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem('ft_crew') || '';
  let data = null;
  let socket = null;

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const btn = (label, fn, cls = 'ghost small') => el('button', { class: cls, type: 'button', onclick: fn }, label);
  const t = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'x-crew-token': token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/crew/login') {
      sessionStorage.removeItem('ft_crew');
      location.reload();
    }
    if (!res.ok) throw new Error(json.error || 'Request failed');
    return json;
  }

  function toast(text, kind) {
    const n = el('div', { class: `toast ${kind || ''}` }, text);
    $('toasts').append(n);
    setTimeout(() => n.remove(), 4000);
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/crew/login', { pin: $('pin').value });
      token = r.token;
      sessionStorage.setItem('ft_crew', token);
      start();
    } catch (err) {
      $('loginError').textContent = err.message;
    }
  });

  let refreshTimer = null;
  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  }

  async function refresh() {
    data = await api('/api/crew/overview');
    render();
  }

  function addAlert(a) {
    const box = $('alerts');
    box.querySelector('.empty')?.remove();
    box.prepend(el('div', { class: `alert-item ${a.kind}` }, el('time', {}, t(Date.now())), a.text));
  }

  function render() {
    const { cabin, stats } = data;
    $('flightTitle').textContent = cabin.flightLock ? `Flight ${cabin.flightLock}` : 'No flight lock set';
    if (document.activeElement !== $('flightLock')) $('flightLock').value = cabin.flightLock || '';
    $('quietMode').checked = cabin.quietMode;

    const stat = (label, value, alert) => el('div', { class: `stat${alert ? ' alert' : ''}` }, el('span', {}, label), el('strong', {}, value));
    $('stats').replaceChildren(
      stat('Passengers', stats.passengers),
      stat('Online now', stats.online),
      stat('Barcode verified', stats.verifiedByBarcode),
      stat('Messages', stats.messages),
      stat('Rooms', stats.rooms),
      stat('Open reports', stats.openReports, stats.openReports > 0));

    const reports = $('reports');
    reports.replaceChildren();
    if (!data.reports.length) reports.append(el('p', { class: 'empty' }, 'No open reports.'));
    for (const r of data.reports) {
      reports.append(el('div', { class: 'report' },
        el('div', {}, el('b', {}, r.target ? `${r.target.displayName} · seat ${r.target.seat}` : 'Unknown'), ` — ${r.reason}`,
          el('span', { class: 'hint' }, ` · by ${r.reporter ? `seat ${r.reporter.seat}` : '?'} at ${t(r.createdAt)}`)),
        r.message ? el('blockquote', {}, `Reported message: “${r.message}”`) : null,
        r.details ? el('blockquote', {}, r.details) : null,
        el('div', { class: 'actions' },
          r.target ? btn('Mute 30 min', () => act(`/api/crew/users/${r.target.id}/mute`, { minutes: 30 }, 'Muted')) : null,
          r.target ? btn('Remove from FlightTalk', () => removeUser(r.target)) : null,
          btn('Dismiss', () => act(`/api/crew/reports/${r.id}`, { status: 'dismissed' }, 'Dismissed')))));
    }
    renderPassengers();

    $('audit').replaceChildren(...data.audit.map((a) => el('div', {}, `${t(a.created_at)}  ${a.actor.padEnd(6)} ${a.action}${a.details ? `  ${a.details}` : ''}`)));
  }

  function renderPassengers() {
    const q = $('search').value.trim().toLowerCase();
    const rows = data.passengers.filter((p) => !q || p.seat.toLowerCase().includes(q) || p.displayName.toLowerCase().includes(q));
    const head = el('tr', {}, ['Seat', 'Display name', 'Verified', 'Status', 'Reports', ''].map((h) => el('th', {}, h)));
    const body = rows.map((p) => {
      const status = p.removed ? el('span', { class: 'pill bad' }, 'removed')
        : p.mutedUntil ? el('span', { class: 'pill warn' }, `muted to ${t(p.mutedUntil)}`)
          : el('span', { class: `pill ${p.online ? 'ok' : ''}` }, p.online ? 'online' : 'away');
      const verified = el('span', { class: `pill ${p.verifiedBy === 'barcode' ? 'ok' : 'warn'}` }, p.verifiedBy);
      return el('tr', {},
        el('td', {}, el('b', {}, p.seat)), el('td', {}, p.displayName), el('td', {}, verified), el('td', {}, status),
        el('td', {}, p.reports ? el('span', { class: 'pill bad' }, p.reports) : '0'),
        el('td', {}, el('div', { class: 'actions' },
          p.removed ? null : (p.mutedUntil
            ? btn('Unmute', () => act(`/api/crew/users/${p.id}/mute`, { minutes: 0 }, 'Unmuted'))
            : btn('Mute 30m', () => act(`/api/crew/users/${p.id}/mute`, { minutes: 30 }, 'Muted'))),
          p.removed ? null : btn('Remove', () => removeUser(p)),
          btn('Release seat', () => releaseSeat(p)))));
    });
    $('passengers').replaceChildren(el('thead', {}, head), el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: 6, class: 'empty' }, 'No passengers yet.'))));
  }
  $('search').addEventListener('input', () => data && renderPassengers());

  async function act(path, body, ok) {
    try {
      await api(path, body);
      toast(ok);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function removeUser(p) {
    if (confirm(`Remove ${p.displayName} (seat ${p.seat}) from FlightTalk for the rest of the flight?`)) act(`/api/crew/users/${p.id}/remove`, {}, 'Removed');
  }
  function releaseSeat(p) {
    if (confirm(`Release seat ${p.seat}? The current profile is deleted so the real passenger can scan their boarding pass.`)) act(`/api/crew/users/${p.id}/release-seat`, {}, 'Seat released');
  }

  $('flightForm').addEventListener('submit', (e) => {
    e.preventDefault();
    act('/api/crew/settings', { flightLock: $('flightLock').value }, 'Flight lock updated');
  });
  $('quietMode').addEventListener('change', () => act('/api/crew/settings', { quietMode: $('quietMode').checked }, $('quietMode').checked ? 'Quiet mode ON' : 'Quiet mode OFF'));
  $('announceForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!$('announceText').value.trim()) return;
    act('/api/crew/announce', { text: $('announceText').value, level: $('announceLevel').value }, 'Announcement sent');
    $('announceText').value = '';
  });
  $('clearAnnounce').addEventListener('click', () => act('/api/crew/announce', { text: '' }, 'Banner cleared'));
  $('endFlight').addEventListener('click', async () => {
    const typed = prompt('This permanently erases all FlightTalk data on this aircraft. Type END to confirm.');
    if (typed !== 'END') return;
    try {
      const r = await api('/api/crew/end-flight', {});
      toast(`Erased ${r.erased.passengers} passengers, ${r.erased.messages} messages, ${r.erased.files} files`);
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  function start() {
    $('login').classList.add('hidden');
    $('console').classList.remove('hidden');
    refresh().catch(() => {});
    socket = io({ auth: { crewToken: token } });
    socket.on('connect', () => $('conn').classList.remove('off'));
    socket.on('disconnect', () => $('conn').classList.add('off'));
    socket.on('crew:dirty', refreshSoon);
    socket.on('crew:alert', (a) => {
      addAlert(a);
      refreshSoon();
    });
    setInterval(refreshSoon, 15000);
  }

  if (token) start();
}());
