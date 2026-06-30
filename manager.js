"use strict";

/* Tabpane manager — v1.1
 * Security: no innerHTML for any data (tabs, group titles, window/session names).
 *           All text via textContent. No inline handlers. CSP forbids inline/eval.
 *           Stored data (window names, sessions) is local-only; never transmitted.
 * Memory:   single shared scheduler (one timer); board interaction is fully
 *           delegated (click + 4 drag listeners on the board container, regardless
 *           of tab count). All chrome + storage listeners removed on pagehide.
 * CPU:      steady state idle; changes coalesce into one rAF-batched render;
 *           no work while the tab is hidden.
 */

const board = document.getElementById("board");
const searchEl = document.getElementById("search");
const statTabs = document.querySelector("#stat-tabs strong");
const statWindows = document.querySelector("#stat-windows strong");
const statDupes = document.getElementById("stat-dupes");
const statDupesNum = statDupes.querySelector("strong");
const btnDedupe = document.getElementById("btn-dedupe");
const btnSortDomain = document.getElementById("btn-sortdomain");
const btnSessions = document.getElementById("btn-sessions");
const sessionsPanel = document.getElementById("sessions-panel");
const sessionsList = document.getElementById("sessions-list");
const sessionsEmpty = document.getElementById("sessions-empty");
const btnSaveSession = document.getElementById("btn-save-session");
const btnSaveTop = document.getElementById("btn-save-top");

const MANAGER_URL = chrome.runtime.getURL("manager.html");

const WINDOW_NAMES_KEY = "windowNames"; // { [windowId:string]: name }
const SESSIONS_KEY = "sessions";        // [{ id, name, createdAt, tabs:[{url,title}] }]

let allWindows = [];   // [{ id, focused, tabs, groups: Map<groupId, {title,color}> }]
let groupBySite = false;
let query = "";
let windowNames = {};  // mirror of storage
let sessions = [];     // mirror of storage

/* Chrome tab-group color name -> hex (for the chip + left band) */
const GROUP_COLORS = {
  grey: "#9aa3b5", blue: "#5b8cff", red: "#ff6b6b", yellow: "#ffd23f",
  green: "#3ddc97", pink: "#ff7eb6", purple: "#b48cff", cyan: "#4cd6e0",
  orange: "#ffa454"
};

/* ---------- helpers (pure) ---------- */
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}
function prettyUrl(url) {
  try {
    const u = new URL(url);
    // Internal/non-web pages (chrome:, about:, edge:, data:, view-source:) —
    // show the original so they read as "chrome://settings", not "settings".
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch { return url || ""; }
}
function haystack(tab) {
  return ((tab.title || "") + " " + (tab.url || "")).toLowerCase();
}
function uid() {
  return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  return new Date(ts).toLocaleDateString();
}

/* ---------- storage (local only) ---------- */
async function loadStored() {
  try {
    const got = await chrome.storage.local.get([WINDOW_NAMES_KEY, SESSIONS_KEY]);
    windowNames = got[WINDOW_NAMES_KEY] || {};
    sessions = Array.isArray(got[SESSIONS_KEY]) ? got[SESSIONS_KEY] : [];
  } catch {
    windowNames = {}; sessions = [];
  }
}
async function saveWindowNames() {
  try { await chrome.storage.local.set({ [WINDOW_NAMES_KEY]: windowNames }); } catch {}
}
async function saveSessions() {
  try { await chrome.storage.local.set({ [SESSIONS_KEY]: sessions }); } catch {}
}

/* ---------- data ---------- */
async function load() {
  if (pageUnloading) return;
  let wins, groups;
  try {
    [wins, groups] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      chrome.tabGroups ? chrome.tabGroups.query({}) : Promise.resolve([])
    ]);
  } catch {
    return;
  }
  const groupById = new Map();
  for (const g of groups) groupById.set(g.id, { title: g.title || "", color: g.color });

  allWindows = wins.map(w => ({
    id: w.id,
    focused: w.focused,
    tabs: (w.tabs || [])
      .filter(t => t.url !== MANAGER_URL)
      .map(t => ({
        id: t.id, windowId: t.windowId, url: t.url, title: t.title,
        favIconUrl: t.favIconUrl, active: t.active, audible: t.audible,
        pinned: t.pinned, groupId: t.groupId
      })),
    groupById
  })).filter(w => w.tabs.length > 0);

  // prune names for windows that no longer exist
  const liveIds = new Set(allWindows.map(w => String(w.id)));
  let changed = false;
  for (const k of Object.keys(windowNames)) {
    if (!liveIds.has(k)) { delete windowNames[k]; changed = true; }
  }
  if (changed) saveWindowNames();

  render();
}

function computeDuplicates() {
  const seen = new Map();
  for (const w of allWindows)
    for (const t of w.tabs)
      seen.set(t.url, (seen.get(t.url) || 0) + 1);
  return seen;
}

// Counts how many tabs the "Close duplicates" action would actually close,
// using the SAME rules as closeDuplicates (skip pinned + internal pages).
// Keeps the button count/visibility honest with the action.
function countCloseableDuplicates() {
  const seen = new Set();
  let n = 0;
  for (const w of allWindows)
    for (const t of w.tabs) {
      if (t.pinned) continue;
      if (!/^https?:/.test(t.url)) { seen.add(t.url); continue; }
      if (seen.has(t.url)) n++;
      else seen.add(t.url);
    }
  return n;
}

/* ---------- DOM builders (no innerHTML on any data) ---------- */
function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}
function setHighlighted(parent, text, q) {
  parent.textContent = "";
  if (!q) { parent.textContent = text; return; }
  const idx = text.toLowerCase().indexOf(q);
  if (idx === -1) { parent.textContent = text; return; }
  parent.appendChild(document.createTextNode(text.slice(0, idx)));
  const mark = document.createElement("mark");
  mark.textContent = text.slice(idx, idx + q.length);
  parent.appendChild(mark);
  parent.appendChild(document.createTextNode(text.slice(idx + q.length)));
}
function buildFavicon(tab) {
  const wrap = el("div", "tab-fav");
  const letter = (hostOf(tab.url)[0] || "•").toUpperCase();
  if (tab.favIconUrl && /^https?:|^data:image\//.test(tab.favIconUrl)) {
    const img = document.createElement("img");
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
    img.src = tab.favIconUrl;
    img.addEventListener("error", () => {
      const span = el("span", "fallback"); span.textContent = letter; img.replaceWith(span);
    }, { once: true });
    wrap.appendChild(img);
  } else {
    const span = el("span", "fallback"); span.textContent = letter; wrap.appendChild(span);
  }
  return wrap;
}
function buildTab(tab, q, isDupe) {
  const row = el("div", "tab");
  row.dataset.tabId = String(tab.id);
  row.dataset.windowId = String(tab.windowId);
  row.draggable = true;
  row.classList.toggle("is-active", !!tab.active);
  row.classList.toggle("is-dupe", !!isDupe);

  row.appendChild(buildFavicon(tab));

  const body = el("div", "tab-body");
  const title = el("div", "tab-title");
  setHighlighted(title, tab.title || "(untitled)", q);
  const url = el("div", "tab-url");
  setHighlighted(url, prettyUrl(tab.url), q);
  body.append(title, url);
  row.appendChild(body);

  if (tab.audible) {
    const a = el("span", "tab-audio"); a.title = "Playing audio"; a.textContent = "♪";
    row.appendChild(a);
  }
  const x = el("button", "tab-x");
  x.title = "Close tab"; x.textContent = "✕"; x.dataset.action = "close-tab";
  row.appendChild(x);
  return row;
}

/* ---------- render ---------- */
let isRendering = false;
let pageUnloading = false;
let isEditing = false;        // true while a window/session name input is open
let renderQueuedDuringEdit = false;
function render() {
  if (pageUnloading) return;          // page is being torn down — do nothing
  if (isEditing) { renderQueuedDuringEdit = true; return; } // don't clobber an open input
  if (isRendering) return;            // never re-enter (prevents render storms)
  isRendering = true;
  try {
    renderInner();
  } catch (err) {
    console.error("Tabpane render error:", err);
  } finally {
    isRendering = false;
  }
}
function renderInner() {
  const q = query.trim().toLowerCase();
  const dupeCount = computeDuplicates();
  let totalTabs = 0;
  const totalDupes = countCloseableDuplicates();

  const frag = document.createDocumentFragment();

  allWindows.forEach((win, idx) => {
    totalTabs += win.tabs.length;
    const visible = q ? win.tabs.filter(t => haystack(t).includes(q)) : win.tabs;
    if (visible.length === 0) return;

    const named = windowNames[String(win.id)];
    const col = el("section", "window-col" + (win.focused ? " is-current" : "") + (named ? " is-named" : ""));
    col.dataset.windowId = String(win.id);

    // head
    const head = el("div", "window-head");
    const dot = el("span", "window-dot");
    const wtitle = el("span", "window-title");
    wtitle.dataset.action = "rename-window";
    wtitle.title = "Double-click to rename";
    wtitle.textContent = named || (win.focused ? "Current window" : "Window " + (idx + 1));
    const rename = el("button", "window-rename");
    rename.dataset.action = "rename-window";
    rename.title = "Rename window"; rename.textContent = "✎";
    const wcount = el("span", "window-count");
    wcount.textContent = q ? `${visible.length} / ${win.tabs.length}` : String(win.tabs.length);
    const wclose = el("button", "window-close");
    wclose.title = "Close this window"; wclose.textContent = "✕";
    wclose.dataset.action = "close-window"; wclose.dataset.windowId = String(win.id);
    head.append(dot, wtitle, rename, wcount, wclose);
    col.appendChild(head);

    // tab list
    const list = el("div", "tab-list");
    list.dataset.windowId = String(win.id);

    if (groupBySite) {
      for (const [label, tabs] of groupByHost(visible)) {
        if (label) { const gl = el("div", "group-label"); gl.textContent = label; list.appendChild(gl); }
        for (const tab of tabs) list.appendChild(buildTab(tab, q, dupeCount.get(tab.url) > 1));
      }
    } else {
      // preserve order but surface chrome tab-group bands
      let currentGroup = null, groupWrap = null;
      for (const tab of visible) {
        const gid = (tab.groupId != null && tab.groupId !== -1) ? tab.groupId : null;
        if (gid !== currentGroup) {
          currentGroup = gid;
          if (gid != null && win.groupById.has(gid)) {
            const meta = win.groupById.get(gid);
            const color = GROUP_COLORS[meta.color] || GROUP_COLORS.grey;
            const band = el("div", "group-band");
            const chip = el("span", "group-chip"); chip.style.background = color;
            const name = el("span"); name.textContent = meta.title || "Group";
            band.append(chip, name);
            list.appendChild(band);
            groupWrap = el("div", "group-tabs");
            groupWrap.style.setProperty("--group-color", color);
            list.appendChild(groupWrap);
          } else {
            groupWrap = null;
          }
        }
        const node = buildTab(tab, q, dupeCount.get(tab.url) > 1);
        (groupWrap || list).appendChild(node);
      }
    }
    col.appendChild(list);
    frag.appendChild(col);
  });

  // Capture scroll position of each window's tab list (keyed by window id,
  // which is stable across renders) so a background re-render doesn't yank
  // the user back to the top while they're scrolling.
  const scrollByWindow = new Map();
  for (const listEl of board.querySelectorAll(".tab-list")) {
    if (listEl.scrollTop > 0) scrollByWindow.set(listEl.dataset.windowId, listEl.scrollTop);
  }

  board.replaceChildren(frag);

  // Restore scroll positions onto the freshly built lists.
  if (scrollByWindow.size) {
    for (const listEl of board.querySelectorAll(".tab-list")) {
      const prev = scrollByWindow.get(listEl.dataset.windowId);
      if (prev) listEl.scrollTop = prev;
    }
  }

  statTabs.textContent = String(totalTabs);
  statWindows.textContent = String(allWindows.length);
  const showDupes = totalDupes > 0;
  statDupes.hidden = !showDupes; btnDedupe.hidden = !showDupes;
  if (showDupes) statDupesNum.textContent = String(totalDupes);
}

function groupByHost(tabs) {
  const map = new Map();
  for (const t of tabs) {
    const h = hostOf(t.url) || "other";
    if (!map.has(h)) map.set(h, []);
    map.get(h).push(t);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
}

/* ---------- tab actions ---------- */
function findTab(id) {
  for (const w of allWindows) { const t = w.tabs.find(t => t.id === id); if (t) return t; }
  return null;
}
async function switchTo(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { scheduleLoad(); }
}
async function closeTab(id) {
  // optimistic local prune for instant feedback
  for (const w of allWindows) w.tabs = w.tabs.filter(t => t.id !== id);
  allWindows = allWindows.filter(w => w.tabs.length > 0);
  render();
  // perform the actual removal; the onRemoved event will reconcile via the
  // single debounced scheduler — closeTab never triggers its own reload.
  try { await chrome.tabs.remove(id); } catch {}
}
async function closeDuplicates() {
  const seen = new Set();
  const toClose = [];
  for (const w of allWindows)
    for (const t of w.tabs) {
      if (t.pinned) continue;            // never close pinned tabs
      if (!/^https?:/.test(t.url)) { seen.add(t.url); continue; } // ignore internal pages
      if (seen.has(t.url)) toClose.push(t.id);
      else seen.add(t.url);
    }
  if (!toClose.length) return;

  // Remove one at a time so a single failing id (already closed, restricted,
  // etc.) doesn't abort the whole batch the way chrome.tabs.remove([...]) does.
  let closed = 0;
  for (const id of toClose) {
    try { await chrome.tabs.remove(id); closed++; }
    catch (err) { console.warn("Tabpane: could not close tab", id, err); }
  }
  if (closed === 0) console.warn("Tabpane: no duplicate tabs could be closed");
  scheduleLoad();
}

/* ---------- window naming ---------- */
function beginRename(windowId) {
  const col = board.querySelector(`.window-col[data-window-id="${windowId}"]`);
  if (!col) return;
  const titleEl = col.querySelector(".window-title");
  if (!titleEl || col.querySelector(".window-name-input")) return;

  isEditing = true;

  const input = el("input", "window-name-input");
  input.type = "text";
  input.maxLength = 60;
  input.value = windowNames[String(windowId)] || "";
  input.placeholder = "Window name";
  titleEl.replaceWith(input);
  input.focus(); input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) windowNames[String(windowId)] = v;
      else delete windowNames[String(windowId)];
      saveWindowNames();
    }
    isEditing = false;
    renderQueuedDuringEdit = false;
    render();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true), { once: true });
}

/* ---------- drag & drop: move a tab into another window ---------- */
let dragTabId = null;
function clearDropMarkers() {
  for (const n of board.querySelectorAll(".drop-target"))
    n.classList.remove("drop-target");
  for (const n of board.querySelectorAll(".drop-before, .drop-after"))
    n.classList.remove("drop-before", "drop-after");
}
board.addEventListener("dragstart", e => {
  const row = e.target.closest(".tab");
  if (!row) return;
  dragTabId = Number(row.dataset.tabId);
  row.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", String(dragTabId)); } catch {}
});
board.addEventListener("dragend", () => {
  const d = board.querySelector(".tab.dragging");
  if (d) d.classList.remove("dragging");
  clearDropMarkers();
  dragTabId = null;
});
board.addEventListener("dragover", e => {
  if (dragTabId == null) return;
  const col = e.target.closest(".window-col");
  if (!col) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  clearDropMarkers();
  col.classList.add("drop-target");
  const overTab = e.target.closest(".tab");
  if (overTab && !overTab.classList.contains("dragging")) {
    const r = overTab.getBoundingClientRect();
    overTab.classList.add((e.clientY - r.top) < r.height / 2 ? "drop-before" : "drop-after");
  }
});
board.addEventListener("drop", async e => {
  if (dragTabId == null) return;
  const col = e.target.closest(".window-col");
  if (!col) { clearDropMarkers(); return; }
  e.preventDefault();
  const targetWindowId = Number(col.dataset.windowId);

  // compute destination index from the drop marker
  let index = -1; // -1 = append
  const overTab = e.target.closest(".tab");
  if (overTab && !overTab.classList.contains("dragging")) {
    const list = col.querySelector(".tab-list");
    const rows = [...list.querySelectorAll(".tab")];
    const pos = rows.indexOf(overTab);
    const after = overTab.classList.contains("drop-after");
    index = pos + (after ? 1 : 0);
  }
  const movingId = dragTabId;
  clearDropMarkers();
  dragTabId = null;
  try {
    await chrome.tabs.move(movingId, { windowId: targetWindowId, index });
    await chrome.tabs.update(movingId, { active: true });
  } catch {}
  scheduleLoad();
});

/* ---------- board click delegation ---------- */
board.addEventListener("click", e => {
  const action = e.target.dataset && e.target.dataset.action;
  if (action === "close-tab") {
    e.stopPropagation();
    const row = e.target.closest(".tab");
    if (row) closeTab(Number(row.dataset.tabId));
    return;
  }
  if (action === "close-window") {
    e.stopPropagation();
    chrome.windows.remove(Number(e.target.dataset.windowId)).catch(() => scheduleLoad());
    return;
  }
  if (action === "rename-window") {
    e.stopPropagation();
    const col = e.target.closest(".window-col");
    if (col) beginRename(Number(col.dataset.windowId));
    return;
  }
  const row = e.target.closest(".tab");
  if (row) { const tab = findTab(Number(row.dataset.tabId)); if (tab) switchTo(tab); }
});
board.addEventListener("dblclick", e => {
  const titleEl = e.target.closest(".window-title");
  if (!titleEl) return;
  const col = e.target.closest(".window-col");
  if (col) beginRename(Number(col.dataset.windowId));
});

/* ---------- sessions ---------- */
function toggleSessions() {
  const open = sessionsPanel.hidden;
  sessionsPanel.hidden = !open;
  btnSessions.setAttribute("aria-pressed", String(open));
  btnSessions.classList.toggle("ghost", !open);
  if (open) renderSessions();
}
function renderSessions() {
  sessionsList.replaceChildren();
  sessionsEmpty.hidden = sessions.length > 0;
  for (const s of sessions) {
    const li = el("li", "session-card");
    li.dataset.sessionId = s.id;

    const top = el("div", "session-top");
    const name = el("span", "session-name");
    name.dataset.action = "rename-session";
    name.title = "Click to rename";
    name.textContent = s.name;
    top.appendChild(name);
    li.appendChild(top);

    const meta = el("div", "session-meta");
    meta.textContent = `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"} · ${timeAgo(s.createdAt)}`;
    li.appendChild(meta);

    const actions = el("div", "session-actions");
    const open = el("button", "btn"); open.textContent = "Open"; open.dataset.action = "open-session";
    const openNew = el("button", "btn ghost"); openNew.textContent = "New window"; openNew.dataset.action = "open-session-new";
    const del = el("button", "btn ghost"); del.textContent = "Delete"; del.dataset.action = "delete-session";
    actions.append(open, openNew, del);
    li.appendChild(actions);

    sessionsList.appendChild(li);
  }
}
async function saveCurrentSession() {
  const tabs = [];
  for (const w of allWindows)
    for (const t of w.tabs)
      if (/^https?:/.test(t.url)) tabs.push({ url: t.url, title: t.title || "" });
  if (!tabs.length) return 0;
  const stamp = new Date().toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  sessions.unshift({ id: uid(), name: "Session — " + stamp, createdAt: Date.now(), tabs });
  if (sessions.length > 50) sessions.length = 50; // cap storage growth
  await saveSessions();
  renderSessions();
  return tabs.length;
}
async function openSession(id, newWindow) {
  const s = sessions.find(x => x.id === id);
  if (!s || !s.tabs.length) return;
  const urls = s.tabs.map(t => t.url).filter(u => /^https?:/.test(u));
  if (!urls.length) return;
  try {
    if (newWindow) {
      await chrome.windows.create({ url: urls });
    } else {
      for (const url of urls) await chrome.tabs.create({ url, active: false });
    }
  } catch {}
  scheduleLoad();
}
async function deleteSession(id) {
  sessions = sessions.filter(s => s.id !== id);
  await saveSessions();
  renderSessions();
}
function beginRenameSession(id) {
  const card = sessionsList.querySelector(`.session-card[data-session-id="${id}"]`);
  if (!card) return;
  const nameEl = card.querySelector(".session-name");
  if (!nameEl || card.querySelector(".session-name-input")) return;
  const s = sessions.find(x => x.id === id);
  if (!s) return;

  const input = el("input", "session-name-input");
  input.type = "text"; input.maxLength = 80; input.value = s.name;
  nameEl.replaceWith(input);
  input.focus(); input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) { s.name = v; await saveSessions(); }
    }
    renderSessions();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(true); }
    else if (e.key === "Escape") { e.preventDefault(); commit(false); }
  });
  input.addEventListener("blur", () => commit(true), { once: true });
}
sessionsList.addEventListener("click", e => {
  const card = e.target.closest(".session-card");
  if (!card) return;
  const id = card.dataset.sessionId;
  const action = e.target.dataset && e.target.dataset.action;
  if (action === "open-session") openSession(id, false);
  else if (action === "open-session-new") openSession(id, true);
  else if (action === "delete-session") deleteSession(id);
  else if (action === "rename-session") beginRenameSession(id);
});

/* ---------- controls ---------- */
searchEl.addEventListener("input", e => { query = e.target.value; render(); });
searchEl.addEventListener("keydown", e => {
  if (e.key === "Enter") { const first = board.querySelector(".tab"); if (first) first.click(); }
  else if (e.key === "Escape") { searchEl.value = ""; query = ""; render(); searchEl.blur(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "/" && document.activeElement !== searchEl &&
      !(document.activeElement && document.activeElement.tagName === "INPUT")) {
    e.preventDefault(); searchEl.focus();
  }
});
btnDedupe.addEventListener("click", closeDuplicates);
btnSortDomain.addEventListener("click", () => {
  groupBySite = !groupBySite;
  btnSortDomain.classList.toggle("ghost", groupBySite);
  btnSortDomain.textContent = groupBySite ? "Ungroup" : "Group by site";
  render();
});
btnSessions.addEventListener("click", toggleSessions);
btnSaveSession.addEventListener("click", saveCurrentSession);

let saveFlashTimer = null;
btnSaveTop.addEventListener("click", async () => {
  const n = await saveCurrentSession();
  const label = n > 0 ? `Saved ${n} tab${n === 1 ? "" : "s"}` : "No tabs to save";
  btnSaveTop.textContent = label;
  btnSaveTop.disabled = true;
  if (saveFlashTimer !== null) clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(() => {
    btnSaveTop.textContent = "Save";
    btnSaveTop.disabled = false;
    saveFlashTimer = null;
  }, 1400);
});

/* ---------- single shared scheduler ---------- */
let loadTimer = null, rafPending = false, pendingWhileHidden = false;
function scheduleLoad() {
  if (pageUnloading) return;
  if (loadTimer !== null) return;
  loadTimer = setTimeout(() => {
    loadTimer = null;
    if (pageUnloading) return;
    if (document.hidden) { pendingWhileHidden = true; return; }
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; load(); });
  }, 150);
}
const onAnyTabChange = () => scheduleLoad();

// onUpdated fires very frequently (every loading-status flip, favicon byte,
// etc.). Only react to changes that affect what we render, so background tab
// churn doesn't cause constant re-renders while the user is scrolling.
const RELEVANT_UPDATE_KEYS = ["title", "url", "favIconUrl", "pinned", "groupId", "audible"];
const onTabUpdated = (_id, changeInfo) => {
  if (changeInfo.status === "complete") { scheduleLoad(); return; }
  for (const k of RELEVANT_UPDATE_KEYS) {
    if (k in changeInfo) { scheduleLoad(); return; }
  }
  // otherwise (e.g. status:"loading") ignore — nothing visible changed
};

const tabEvents = ["onCreated", "onRemoved", "onMoved",
                   "onActivated", "onAttached", "onDetached", "onReplaced"];
const registered = [];
for (const name of tabEvents) {
  const ev = chrome.tabs[name];
  if (ev && ev.addListener) { ev.addListener(onAnyTabChange); registered.push(ev); }
}
if (chrome.tabs.onUpdated && chrome.tabs.onUpdated.addListener) {
  chrome.tabs.onUpdated.addListener(onTabUpdated);
}
const groupEvents = [];
if (chrome.tabGroups) {
  for (const name of ["onCreated", "onUpdated", "onMoved", "onRemoved"]) {
    const ev = chrome.tabGroups[name];
    if (ev && ev.addListener) { ev.addListener(onAnyTabChange); groupEvents.push(ev); }
  }
}
chrome.windows.onRemoved.addListener(onAnyTabChange);
chrome.windows.onCreated.addListener(onAnyTabChange);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pendingWhileHidden) { pendingWhileHidden = false; load(); }
});

/* ---------- teardown ---------- */
window.addEventListener("pagehide", () => {
  pageUnloading = true;
  for (const ev of registered) { try { ev.removeListener(onAnyTabChange); } catch {} }
  for (const ev of groupEvents) { try { ev.removeListener(onAnyTabChange); } catch {} }
  try { chrome.tabs.onUpdated.removeListener(onTabUpdated); } catch {}
  try { chrome.windows.onRemoved.removeListener(onAnyTabChange); } catch {}
  try { chrome.windows.onCreated.removeListener(onAnyTabChange); } catch {}
  if (loadTimer !== null) clearTimeout(loadTimer);
  if (saveFlashTimer !== null) clearTimeout(saveFlashTimer);
}, { once: true });

/* ---------- boot ---------- */
(async () => { await loadStored(); await load(); })();
