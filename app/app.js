// Leonida Ledger — a single-page, offline trophy guide for Grand Theft Auto VI.
// All state (earned trophies, counters, notes, settings) lives in localStorage under one key.

const STORE_KEY = 'leonida-ledger/v1';

const KIND_LABELS = {
  story: 'Story',
  side: 'Side strands',
  collectibles: 'Collectibles',
  activities: 'Activities',
  robbery: 'Robberies',
  misc: 'Odd jobs',
  completion: 'Completion',
  online: 'Online',
};

const DEFAULT_STATE = {
  earned: [],
  counts: {},
  notes: {},
  spoiler: true,
  theme: 'night',
};

const state = { ...DEFAULT_STATE, ...load() };
let doc = null;
let view = 'checklist';
let selectedId = null;
let query = '';
let kinds = new Set();
let missableOnly = false;
let grade = 'all';
let status = 'all';
let sort = 'roadmap';
let visible = [];
let focusIndex = -1;
let toastTimer = null;

const $ = (id) => document.getElementById(id);
const byId = new Map();

/* ---------- storage ---------- */

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      earned: state.earned,
      counts: state.counts,
      notes: state.notes,
      spoiler: state.spoiler,
      theme: state.theme,
    }));
  } catch {
    toast('Could not save: browser storage is full or blocked.');
  }
}

const isEarned = (id) => state.earned.includes(id);
const noteOf = (id) => state.notes[id] ?? '';
const countOf = (id) => state.counts[id] ?? 0;

/* ---------- helpers ---------- */

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function money(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return '$' + fmt(n);
}

function countLabel(t, value) {
  const v = t.countMoney ? money(value) : fmt(value);
  const total = t.countMoney ? money(t.count) : fmt(t.count);
  return `${v} / ${total} ${t.countUnit}`;
}

function medalClass(g) { return `medal medal-${g}`; }
function gradeLabel(g) { return g.charAt(0).toUpperCase() + g.slice(1); }

function hidden(t) {
  return state.spoiler && t.kind === 'story' && !isEarned(t.id);
}

function displayName(t) { return hidden(t) ? 'Hidden story trophy' : t.name; }
function displayDesc(t) { return hidden(t) ? 'Earned in the main story. Mark it earned to reveal the name.' : t.description; }

function stageOf(t) { return doc.stages.find((s) => s.id === t.stage); }

function progress() {
  const earned = state.earned.length;
  return { earned, total: doc.trophies.length, pct: Math.round((earned / doc.trophies.length) * 100) };
}

function stageStats(stageId) {
  const list = doc.trophies.filter((t) => t.stage === stageId);
  const done = list.filter((t) => isEarned(t.id)).length;
  return { list, done, total: list.length, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
}

function counterPct(t) {
  const c = countOf(t.id);
  return t.count ? Math.min(100, Math.round((c / t.count) * 100)) : 0;
}

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 2600);
}

/* ---------- mutations ---------- */

function setEarned(id, on, quiet = false) {
  const t = byId.get(id);
  if (!t) return;
  const had = isEarned(id);
  if (on === had) return;
  if (on) {
    state.earned = [...state.earned, id];
    if (t.count) state.counts[id] = t.count;
  } else {
    state.earned = state.earned.filter((x) => x !== id);
  }
  save();
  renderAll();
  if (!quiet) toast(on ? `Earned: ${displayName(t)}` : `Un-earned: ${displayName(t)}`);
}

function toggleEarned(id) { setEarned(id, !isEarned(id)); }

function setCount(id, value) {
  const t = byId.get(id);
  if (!t || !t.count) return;
  const clamped = Math.max(0, Math.min(t.count, Math.round(value)));
  state.counts[id] = clamped;
  if (clamped >= t.count && !isEarned(id)) {
    state.earned = [...state.earned, id];
    save();
    renderAll();
    toast(`Counter complete: ${displayName(t)}`);
    return;
  }
  if (clamped < t.count && isEarned(id) && t.kind !== 'story') {
    state.earned = state.earned.filter((x) => x !== id);
  }
  save();
  renderAll();
}

function setNote(id, text) {
  if (text.trim()) state.notes[id] = text;
  else delete state.notes[id];
  save();
}

/* ---------- filtering ---------- */

function matches(t) {
  if (missableOnly && !t.missable) return false;
  if (kinds.size && !kinds.has(t.kind)) return false;
  if (grade !== 'all' && t.grade !== grade) return false;
  if (status === 'earned' && !isEarned(t.id)) return false;
  if (status === 'remaining' && isEarned(t.id)) return false;
  if (query) {
    const hay = [t.name, t.description, t.guide, KIND_LABELS[t.kind] ?? t.kind, t.grade,
      t.missable ? 'missable' : '', t.count ? `${t.count} ${t.countUnit}` : ''].join(' ').toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}

function sortList(list) {
  const copy = [...list];
  if (sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === 'grade') {
    const order = { platinum: 0, gold: 1, silver: 2, bronze: 3 };
    copy.sort((a, b) => order[a.grade] - order[b.grade] || a.id - b.id);
  } else if (sort === 'remaining') {
    copy.sort((a, b) => Number(isEarned(a.id)) - Number(isEarned(b.id)) || a.stage - b.stage || a.id - b.id);
  } else {
    copy.sort((a, b) => a.stage - b.stage || (b.missable ? 1 : 0) - (a.missable ? 1 : 0) || a.id - b.id);
  }
  return copy;
}

function kindCounts() {
  const counts = {};
  for (const t of doc.trophies) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  return counts;
}

/* ---------- shared fragments ---------- */

function medal(g) { return `<span class="${medalClass(g)}" aria-hidden="true"></span>`; }

function tag(text, cls = '') { return `<span class="tag ${cls}">${esc(text)}</span>`; }

/* ---------- header ---------- */

function renderHeader() {
  const p = progress();
  $('earnedCount').textContent = p.earned;
  $('headerBar').style.width = `${p.pct}%`;
  $('headerSub').textContent = `${p.total - p.earned} to go · ${p.pct}% complete`;

  const strip = $('stageStrip');
  if (strip) {
    strip.innerHTML = '<span class="strip-label">Roadmap</span>' + doc.stages.map((s) => {
      const st = stageStats(s.id);
      return `<span class="strip-item${st.done === st.total ? ' is-done' : ''}" title="Stage ${s.id} ${esc(s.title)}: ${st.done}/${st.total}">
        <span class="strip-n">${s.id}</span>
        <span class="strip-bar"><i style="width:${st.pct}%"></i></span>
      </span>`;
    }).join('');
  }

  const plat = doc.trophies.find((t) => t.grade === 'platinum');
  const platDone = plat ? isEarned(plat.id) : false;
  const othersLeft = p.total - p.earned - (platDone ? 0 : 1);
  const chip = $('platinumChip');
  chip.classList.toggle('is-on', platDone);
  $('platinumText').textContent = platDone ? 'Platinum earned' : othersLeft === 0 ? 'Platinum ready to unlock' : `Platinum in ${othersLeft} more`;
}

/* ---------- checklist ---------- */

function renderChips() {
  const counts = kindCounts();
  const total = doc.trophies.length;
  const none = kinds.size === 0 && !missableOnly;
  const missableN = doc.trophies.filter((t) => t.missable).length;
  const parts = [`<button type="button" class="chip" data-kind="all" aria-pressed="${none}">All <span class="chip-n">${total}</span></button>`];
  for (const [k, label] of Object.entries(KIND_LABELS)) {
    if (!counts[k]) continue;
    parts.push(`<button type="button" class="chip" data-kind="${k}" aria-pressed="${kinds.has(k)}">${esc(label)} <span class="chip-n">${counts[k]}</span></button>`);
  }
  parts.push(`<button type="button" class="chip chip-missable" data-kind="missable" aria-pressed="${missableOnly}">Missable <span class="chip-n">${missableN}</span></button>`);
  if (!counts.online) {
    parts.push(`<button type="button" class="chip chip-empty" disabled title="The official list has no online trophies">Online <span class="chip-n">0</span></button>`);
  }
  $('kindChips').innerHTML = parts.join('');
}

function renderList() {
  const prevTop = $('trophyList').scrollTop;
  visible = sortList(doc.trophies.filter(matches));
  const list = $('trophyList');
  $('listCount').textContent = `${visible.length} of ${doc.trophies.length} trophies`;

  if (!visible.length) {
    list.innerHTML = `<div class="empty"><strong>No trophies match</strong>Clear the search or loosen a filter to see the rest of the list.</div>`;
    return;
  }

  list.innerHTML = visible.map((t) => {
    const earned = isEarned(t.id);
    const meta = [
      t.missable ? tag('Missable', 'tag-missable') : '',
      t.count ? tag(countLabel(t, countOf(t.id)), 'tag-count') : '',
      `<span class="${medalClass(t.grade)}" title="${gradeLabel(t.grade)}" aria-label="${gradeLabel(t.grade)}"></span>`,
    ].join('');
    return `<div class="trow${earned ? ' is-earned' : ''}${t.id === selectedId ? ' is-selected' : ''}" role="listitem" tabindex="0" data-id="${t.id}"${t.id === selectedId ? ' aria-current="true"' : ''}>
      <button type="button" class="check" role="checkbox" aria-checked="${earned}" data-check="${t.id}" aria-label="Mark ${esc(displayName(t))} earned">&#10003;</button>
      <span class="${medalClass(t.grade)}" aria-hidden="true"></span>
      <span class="t-main"><span class="t-name">${esc(displayName(t))}</span><span class="t-desc">${esc(displayDesc(t))}</span></span>
      <span class="t-meta">${meta}</span>
    </div>`;
  }).join('');
  $('trophyList').scrollTop = prevTop;
}

function renderGuide() {
  const pane = $('guidePane');
  const t = selectedId ? byId.get(selectedId) : null;
  if (!t) {
    pane.innerHTML = `<div class="guide-empty"><h2>Pick a trophy</h2><p>Select any row to read its guide, sources, counter and notes here. <kbd>/</kbd> searches, <kbd>?</kbd> lists every shortcut.</p></div>`;
    return;
  }
  const earned = isEarned(t.id);
  const stage = stageOf(t);
  const spoiler = hidden(t);

  const counter = t.count ? `
    <div class="counter-box">
      <div class="counter-top">
        <span>PSN <span class="counter-of">${esc(countLabel(t, countOf(t.id)))}</span></span>
        <span class="counter-pct">${counterPct(t)}%</span>
      </div>
      <div class="counter-track"><i style="width:${counterPct(t)}%"></i></div>
      <div class="counter-ctl">
        <button type="button" data-count-step="${t.id}|-${t.countStep}" aria-label="Decrease counter">&minus;</button>
        <input type="number" min="0" max="${t.count}" step="${t.countStep}" value="${countOf(t.id)}" data-count-input="${t.id}" aria-label="Counter value for ${esc(t.name)}">
        <button type="button" data-count-step="${t.id}|${t.countStep}" aria-label="Increase counter">+</button>
        <button type="button" class="btn btn-ghost" data-count-max="${t.id}">Set max</button>
      </div>
      <p class="counter-note">${t.countMoney ? 'Money counter, steps of ' + fmt(t.countStep) + '. ' : ''}Counter and earned tick stay in sync.</p>
    </div>` : '';

  const missable = t.missable ? `
    <div class="missable-note"><b>Missable</b>${esc(t.missableWhy)} ${esc(t.missableWhen)}</div>` : '';

  pane.innerHTML = `
    <div class="guide-head">
      <div class="guide-eyebrow">
        ${medal(t.grade)}
        ${tag(gradeLabel(t.grade))}
        ${tag(KIND_LABELS[t.kind] ?? t.kind)}
        ${t.missable ? tag('Missable', 'tag-missable') : ''}
        ${earned ? tag('Earned', 'tag-spoiler') : ''}
      </div>
      <h2 class="guide-title">${esc(displayName(t))}</h2>
      <p class="guide-desc">${spoiler ? 'Official description hidden while spoiler-safe is on.' : '&ldquo;' + esc(t.description) + '&rdquo;'}</p>
      <div class="guide-actions">
        <button type="button" class="btn ${earned ? 'is-on' : 'btn-primary'}" data-toggle="${t.id}">${earned ? '&#10003; Earned — undo' : 'Mark earned'}</button>
        <button type="button" class="btn btn-ghost" data-spoiler-flip>${state.spoiler ? 'Spoilers: hidden' : 'Spoilers: shown'}</button>
      </div>
    </div>
    <div class="guide-body">
      ${spoiler ? `<div class="spoiler-card"><div class="lock" aria-hidden="true">&#128274;</div><h3>Hidden story trophy</h3><p>Its name and description stay hidden until it is earned. The guide and sources below are still safe to read.</p></div>` : ''}
      <div class="facts">
        <span class="fact"><span class="fact-k">Stage</span> ${stage ? esc(stage.title) : '—'}</span>
        <span class="fact"><span class="fact-k">Kind</span> ${esc(KIND_LABELS[t.kind] ?? t.kind)}</span>
        <span class="fact"><span class="fact-k">Missable</span> ${t.missable ? 'Yes' : 'No'}</span>
        <span class="fact"><span class="fact-k">Counter</span> ${t.count ? esc(countLabel(t, countOf(t.id))) : 'None'}</span>
      </div>
      ${missable}
      <h3>How to get it</h3>
      <p class="guide-text">${esc(t.guide)}</p>
      <h3>Sources</h3>
      <p class="sources">${esc(t.sources)}</p>
      ${t.missable && !earned ? '' : ''}
      ${counter}
      <h3>Your notes</h3>
      <div class="notes-box">
        <textarea data-note="${t.id}" placeholder="Where you left off, which district, what failed…">${esc(noteOf(t.id))}</textarea>
        <div class="notes-meta"><span>Saved as you type</span><span data-note-status="${t.id}">${noteOf(t.id) ? 'Saved' : ''}</span></div>
      </div>
    </div>`;
}

function renderChecklist() {
  renderChips();
  renderList();
  renderGuide();
}

/* ---------- roadmap ---------- */

function renderRoadmap() {
  const p = progress();
  $('roadmapEarned').textContent = p.earned;

  $('stageRail').innerHTML = doc.stages.map((s) => {
    const st = stageStats(s.id);
    return `<button type="button" class="rail-item${st.done === st.total ? ' is-done' : ''}" data-stage-jump="${s.id}">
      <span class="rail-k">Stage ${s.id}</span>
      <span class="rail-t">${esc(s.title)}</span>
      <span class="rail-bar"><i style="width:${st.pct}%"></i></span>
      <span class="rail-n">${st.done}/${st.total}</span>
    </button>`;
  }).join('');

  const currentStage = doc.stages.find((s) => stageStats(s.id).done < stageStats(s.id).total)?.id ?? null;
  $('roadmapStages').innerHTML = doc.stages.map((s) => {
    const st = stageStats(s.id);
    const rows = st.list.map((t) => {
      const earned = isEarned(t.id);
      const meta = t.count ? `${fmt(countOf(t.id))}/${fmt(t.count)}` : earned ? 'done' : '—';
      return `<div class="srow${earned ? ' is-earned' : ''}" data-open="${t.id}" role="button" tabindex="0">
        <button type="button" class="check" role="checkbox" aria-checked="${earned}" data-check="${t.id}" aria-label="Mark ${esc(displayName(t))} earned">&#10003;</button>
        <span class="${medalClass(t.grade)}" aria-hidden="true"></span>
        <span><span class="srow-name">${esc(displayName(t))}</span><span class="srow-desc">${esc(displayDesc(t))}</span></span>
        <span class="srow-meta">${t.missable ? 'missable · ' : ''}${esc(meta)}</span>
      </div>`;
    }).join('');
    return `<section class="stage${st.done === st.total ? ' is-done' : ''}${currentStage === s.id ? ' is-current' : ''}" id="stage-${s.id}">
      <div class="stage-head">
        <div class="stage-num">${s.id}</div>
        <div>
          <h3 class="stage-title">${esc(s.title)}</h3>
          <div class="stage-kicker">${esc(s.kicker)}</div>
          <p class="stage-blurb">${esc(s.blurb)}</p>
        </div>
        <div class="stage-prog">
          ${currentStage === s.id ? '<div class="stage-now">You are here</div>' : ''}
          <div class="stage-prog-n">${st.done} / ${st.total}</div>
          <div class="stage-prog-l">${st.pct}% complete</div>
          <div class="bar" style="margin-top:6px"><i style="width:${st.pct}%"></i></div>
        </div>
      </div>
      <div class="stage-list">${rows}</div>
    </section>`;
  }).join('');
}

/* ---------- missables ---------- */

function renderMissables() {
  const list = doc.trophies.filter((t) => t.missable);
  const left = list.filter((t) => !isEarned(t.id)).length;
  $('missableLeft').textContent = left;
  $('missableTabN').textContent = left || list.length;

  $('missableGrid').innerHTML = list.map((t) => {
    const earned = isEarned(t.id);
    const stage = stageOf(t);
    return `<article class="mcard${earned ? ' is-earned' : ''}">
      <div class="mcard-top">
        <div>
          <h3 class="mcard-name">${esc(displayName(t))}</h3>
          <p class="mcard-desc">${esc(displayDesc(t))}</p>
        </div>
        <span class="${medalClass(t.grade)}" aria-hidden="true"></span>
      </div>
      <div class="mcard-block"><b>Why it can be missed</b>${esc(t.missableWhy)}</div>
      <div class="mcard-block"><b>When to do it</b>${esc(t.missableWhen)}</div>
      <div class="mcard-foot">
        <span class="mcard-stage">Stage ${t.stage} · ${esc(stage ? stage.title : '')}</span>
        <button type="button" class="btn ${earned ? 'is-on' : ''}" data-toggle="${t.id}">${earned ? '&#10003; Earned' : 'Mark earned'}</button>
      </div>
    </article>`;
  }).join('');
}

/* ---------- planner ---------- */

function plannerQueue() {
  const remaining = doc.trophies.filter((t) => !isEarned(t.id));
  const score = (t) => {
    let s = t.stage * 100 + t.id;
    if (t.missable) s -= 10000;
    if (t.count && counterPct(t) >= 60) s -= 2500;
    return s;
  };
  return remaining.sort((a, b) => score(a) - score(b));
}

function plannerReason(t) {
  if (t.missable) return 'Missable — do it now';
  if (t.count && counterPct(t) >= 60) return 'Counter nearly done';
  const stage = stageOf(t);
  return stage ? `Stage ${t.stage} · ${stage.title}` : 'Cleanup';
}

function renderPlanner() {
  const queue = plannerQueue();
  const p = progress();
  $('plannerLeft').textContent = p.total - p.earned;

  const top = queue[0];
  if (top) {
    const stage = stageOf(top);
    $('suggestHero').innerHTML = `
      <div class="suggest-eyebrow">Next up</div>
      <h3 class="suggest-title">${esc(displayName(top))}</h3>
      <p class="suggest-why"><b>${esc(plannerReason(top))}.</b> ${esc(displayDesc(top))} ${top.missable ? esc(top.missableWhen) : stage ? esc(stage.blurb) : ''}</p>
      <div class="suggest-actions">
        <button type="button" class="btn btn-primary" data-open="${top.id}">Open the guide</button>
        <button type="button" class="btn" data-toggle="${top.id}">Mark earned</button>
      </div>`;
  } else {
    $('suggestHero').innerHTML = `<div class="suggest-eyebrow">Done</div><h3 class="suggest-title">The list is complete</h3><p class="suggest-why">Every trophy is earned. Enjoy the platinum.</p>`;
  }

  $('queueCount').textContent = `${queue.length} remaining`;
  $('plannerQueue').innerHTML = queue.length
    ? queue.slice(0, 40).map((t, i) => `<div class="qrow" data-open="${t.id}" role="button" tabindex="0">
        <span class="qrow-n">${String(i + 1).padStart(2, '0')}</span>
        <span class="${medalClass(t.grade)}" aria-hidden="true"></span>
        <span><span class="qrow-name">${esc(displayName(t))}</span><span class="qrow-sub">${esc(displayDesc(t))}</span></span>
        <span class="qrow-why${t.missable || (t.count && counterPct(t) >= 60) ? '' : ' is-clean'}">${esc(plannerReason(t))}</span>
        <button type="button" class="check" role="checkbox" aria-checked="false" data-check="${t.id}" aria-label="Mark ${esc(displayName(t))} earned">&#10003;</button>
      </div>`).join('')
    : `<div class="empty"><strong>Nothing left</strong>Every trophy is earned.</div>`;

  $('plannerStages').innerHTML = doc.stages.map((s) => {
    const st = stageStats(s.id);
    return `<div class="mini-stage"><div class="mini-top"><b>${esc(s.title)}</b><span>${st.done}/${st.total}</span></div><div class="mini-bar"><i style="width:${st.pct}%"></i></div></div>`;
  }).join('');

  const counters = doc.trophies
    .filter((t) => t.count && !isEarned(t.id))
    .map((t) => ({ t, pct: counterPct(t) }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
  $('closeCounters').innerHTML = counters.length
    ? counters.map(({ t, pct }) => `<div class="cc"><div class="cc-top"><span>${esc(displayName(t))}</span><b>${fmt(countOf(t.id))}/${fmt(t.count)}</b></div><div class="cc-bar"><i style="width:${pct}%"></i></div></div>`).join('')
    : `<p class="side-note">No tracked counters are still open.</p>`;

}

/* ---------- settings ---------- */

function renderSettings() {
  const p = progress();
  $('settingsEarned').textContent = p.earned;
  $('settingsSpoiler').checked = state.spoiler;
  $('spoilerToggle').checked = state.spoiler;
  for (const btn of document.querySelectorAll('.theme-option')) {
    btn.setAttribute('aria-checked', String(btn.dataset.themeValue === state.theme));
  }
  const notes = Object.keys(state.notes).length;
  const counters = Object.keys(state.counts).length;
  $('saveSummary').textContent = `${p.earned} earned · ${counters} counters · ${notes} notes · theme ${state.theme}.`;
  $('gradeKey').innerHTML = ['platinum', 'gold', 'silver', 'bronze']
    .map((g) => `<span>${medal(g)}${gradeLabel(g)}</span>`).join('');
}

/* ---------- render orchestration ---------- */

function syncSettingsInputs() {
  $('spoilerToggle').checked = state.spoiler;
  $('settingsSpoiler').checked = state.spoiler;
  $('plannerSpoiler').checked = state.spoiler;
  $('plannerTheme').value = state.theme;
}

function renderAll() {
  renderHeader();
  syncSettingsInputs();
  if (view === 'checklist') renderChecklist();
  if (view === 'roadmap') renderRoadmap();
  if (view === 'missables') renderMissables();
  if (view === 'planner') renderPlanner();
  if (view === 'settings') renderSettings();
  if (view === 'checklist') renderGuide();
}

function setView(next, opts = {}) {
  if (!['checklist', 'roadmap', 'missables', 'planner', 'settings'].includes(next)) return;
  view = next;
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.view === next) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  for (const sec of document.querySelectorAll('.view')) sec.hidden = sec.id !== `view-${next}`;
  renderAll();
  if (opts.focus !== false) window.scrollTo({ top: 0, behavior: 'auto' });
}

function openTrophy(id, opts = {}) {
  selectedId = id;
  if (view !== 'checklist') setView('checklist', { focus: false });
  else renderChecklist();
  const t = byId.get(id);
  if (t && opts.scroll !== false) {
    const row = document.querySelector(`.trow[data-id="${id}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
}

/* ---------- export / import ---------- */

function exportSave() {
  const payload = {
    app: 'leonida-ledger',
    version: 1,
    exportedAt: new Date().toISOString(),
    game: doc.game,
    list: doc.list,
    earned: state.earned.map((id) => byId.get(id)?.name).filter(Boolean),
    earnedIds: state.earned,
    counts: Object.fromEntries(Object.entries(state.counts).map(([id, v]) => [byId.get(Number(id))?.name ?? id, v])),
    countsById: state.counts,
    notes: state.notes,
    spoiler: state.spoiler,
    theme: state.theme,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'leonida-ledger-progress.json';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Exported progress and notes.');
}

function idFromName(name) {
  const t = doc.trophies.find((x) => x.name === name);
  return t ? t.id : null;
}

async function importSave(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast('That file is not valid JSON.');
    return false;
  }
  const fromArray = Array.isArray(data);
  let ids = [];
  let counts = {};
  let notes = {};
  let spoiler = state.spoiler;
  let theme = state.theme;

  if (fromArray) {
    ids = data.map((v) => (typeof v === 'number' ? v : idFromName(String(v)))).filter((v) => v != null);
  } else if (data && typeof data === 'object') {
    const rawEarned = data.earnedIds ?? data.earned ?? [];
    if (Array.isArray(rawEarned)) ids = rawEarned.map((v) => (typeof v === 'number' ? v : idFromName(String(v)))).filter((v) => v != null);
    const rawCounts = data.countsById ?? data.counts ?? {};
    if (rawCounts && typeof rawCounts === 'object') {
      for (const [k, v] of Object.entries(rawCounts)) {
        const id = Number.isFinite(Number(k)) && byId.has(Number(k)) ? Number(k) : idFromName(k);
        if (id != null && Number.isFinite(Number(v))) counts[id] = Number(v);
      }
    }
    if (data.notes && typeof data.notes === 'object') notes = { ...data.notes };
    if (typeof data.spoiler === 'boolean') spoiler = data.spoiler;
    if (['night', 'midnight', 'parchment'].includes(data.theme)) theme = data.theme;
  } else {
    toast('That file does not look like a save.');
    return false;
  }

  const unique = [...new Set(ids)];
  if (!unique.length && !Object.keys(counts).length) {
    toast('No trophies found in that file.');
    return false;
  }

  state.earned = unique;
  state.counts = counts;
  state.notes = notes;
  state.spoiler = spoiler;
  state.theme = theme;
  applyTheme();
  save();
  renderAll();
  toast(`Imported ${unique.length} earned trophies and ${Object.keys(notes).length} notes.`);
  return true;
}

/* ---------- reset ---------- */

function resetAll() {
  state.earned = [];
  state.counts = {};
  state.notes = {};
  state.spoiler = true;
  state.theme = 'night';
  applyTheme();
  save();
  renderAll();
  toast('Everything reset.');
}

/* ---------- shortcuts ---------- */

function shortcutTargetIsField(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function moveSelection(delta) {
  if (view !== 'checklist') setView('checklist', { focus: false });
  if (!visible.length) visible = sortList(doc.trophies.filter(matches));
  if (!visible.length) return;
  const current = visible.findIndex((t) => t.id === selectedId);
  const next = current === -1 ? (delta > 0 ? 0 : visible.length - 1) : (current + delta + visible.length) % visible.length;
  focusIndex = next;
  openTrophy(visible[next].id);
}

function bindShortcuts() {
  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const inField = shortcutTargetIsField(document.activeElement);

    if (event.key === 'Escape') {
      const openDialog = document.querySelector('dialog[open]');
      if (openDialog) { openDialog.close(); return; }
      if (inField && document.activeElement.id === 'search') {
        $('search').value = '';
        query = '';
        renderChecklist();
        $('search').blur();
      }
      return;
    }

    if (event.key === '?' && !inField) {
      event.preventDefault();
      if (!$('shortcutDialog').open) $('shortcutDialog').showModal();
      return;
    }

    if (inField) return;

    if (event.key === '/') {
      event.preventDefault();
      setView('checklist', { focus: false });
      $('search').focus();
      $('search').select();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key === 'e' || event.key === 'E') {
      if (!selectedId) return;
      event.preventDefault();
      toggleEarned(selectedId);
      return;
    }

    if (event.key === 'n' || event.key === 'N') {
      if (!selectedId) return;
      const box = document.querySelector(`[data-note="${selectedId}"]`);
      if (box) { event.preventDefault(); box.focus(); }
      return;
    }

    const views = ['checklist', 'roadmap', 'missables', 'planner', 'settings'];
    if (/^[1-5]$/.test(event.key)) {
      event.preventDefault();
      setView(views[Number(event.key) - 1]);
    }
  });
}

/* ---------- wiring ---------- */

function bindEvents() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setView(tab.dataset.view));
  });

  $('shortcutBtn').addEventListener('click', () => { if (!$('shortcutDialog').open) $('shortcutDialog').showModal(); });

  $('kindChips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-kind]');
    if (!chip) return;
    const k = chip.dataset.kind;
    if (k === 'all') { kinds.clear(); missableOnly = false; }
    else if (k === 'missable') { missableOnly = !missableOnly; }
    else if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    renderChecklist();
  });

  $('search').addEventListener('input', (event) => {
    query = event.target.value.trim().toLowerCase();
    renderList();
  });

  $('gradeFilter').addEventListener('change', (event) => { grade = event.target.value; renderList(); });
  $('statusFilter').addEventListener('change', (event) => { status = event.target.value; renderList(); });
  $('sortFilter').addEventListener('change', (event) => { sort = event.target.value; renderList(); });

  $('spoilerToggle').addEventListener('change', (event) => {
    state.spoiler = event.target.checked;
    save();
    renderAll();
    toast(state.spoiler ? 'Spoiler-safe on' : 'Spoilers shown');
  });

  $('settingsSpoiler').addEventListener('change', (event) => {
    state.spoiler = event.target.checked;
    save();
    renderAll();
  });

  $('plannerSpoiler').addEventListener('change', (event) => {
    state.spoiler = event.target.checked;
    save();
    renderAll();
  });

  $('plannerTheme').addEventListener('change', (event) => {
    state.theme = event.target.value;
    applyTheme();
    save();
    renderSettings();
    renderPlanner();
  });

  $('themeOptions').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-theme-value]');
    if (!btn) return;
    state.theme = btn.dataset.themeValue;
    applyTheme();
    save();
    renderSettings();
  });

  $('exportBtn').addEventListener('click', exportSave);
  $('importInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (file) await importSave(file);
    event.target.value = '';
  });

  $('resetBtn').addEventListener('click', () => $('confirmDialog').showModal());
  $('confirmReset').addEventListener('click', () => { $('confirmDialog').close(); resetAll(); });

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('dialog')?.close());
  });

  document.addEventListener('click', (event) => {
    const check = event.target.closest('[data-check]');
    if (check) {
      event.preventDefault();
      event.stopPropagation();
      toggleEarned(Number(check.dataset.check));
      return;
    }

    const toggle = event.target.closest('[data-toggle]');
    if (toggle) { toggleEarned(Number(toggle.dataset.toggle)); return; }

    const open = event.target.closest('[data-open]');
    if (open) { openTrophy(Number(open.dataset.open)); return; }

    const jump = event.target.closest('[data-stage-jump]');
    if (jump) {
      const el = $(`stage-${jump.dataset.stageJump}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const step = event.target.closest('[data-count-step]');
    if (step) {
      const [id, delta] = step.dataset.countStep.split('|').map(Number);
      setCount(id, countOf(id) + delta);
      return;
    }

    const max = event.target.closest('[data-count-max]');
    if (max) {
      const t = byId.get(Number(max.dataset.countMax));
      if (t) setCount(t.id, t.count);
      return;
    }

    const flip = event.target.closest('[data-spoiler-flip]');
    if (flip) {
      state.spoiler = !state.spoiler;
      save();
      renderAll();
      toast(state.spoiler ? 'Spoiler-safe on' : 'Spoilers shown');
      return;
    }

    const row = event.target.closest('.trow');
    if (row) { openTrophy(Number(row.dataset.id)); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.trow[data-id], .srow[data-open], .qrow[data-open]');
    if (!row || event.target !== row) return;
    event.preventDefault();
    const id = row.dataset.id ?? row.dataset.open;
    openTrophy(Number(id));
  });

  document.addEventListener('input', (event) => {
    const input = event.target.closest('[data-count-input]');
    if (input) {
      setCount(Number(input.dataset.countInput), Number(input.value) || 0);
      return;
    }
    const note = event.target.closest('[data-note]');
    if (note) {
      setNote(Number(note.dataset.note), note.value);
      const status = document.querySelector(`[data-note-status="${note.dataset.note}"]`);
      if (status) status.textContent = 'Saved';
    }
  });
}

/* ---------- boot ---------- */

async function boot() {
  doc = await (await fetch('data/trophies.json')).json();
  for (const t of doc.trophies) byId.set(t.id, t);
  state.earned = [...new Set((state.earned ?? []).map(Number).filter((id) => byId.has(id)))];
  applyTheme();
  selectedId = doc.trophies.find((t) => !isEarned(t.id))?.id ?? doc.trophies[0].id;
  bindEvents();
  bindShortcuts();
  setView('checklist', { focus: false });
}

boot();
