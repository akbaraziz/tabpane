"use strict";

/* Tabpane manager — v1.1
 * Security: no innerHTML for any data (tabs, group titles, window/session names).
 *           All text via textContent. No inline handlers. CSP forbids inline/eval.
 *           Window names are local-only. Saved sessions use chrome.storage.sync
 *           when available so they can follow the signed-in Chrome profile.
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
const sessionsHint = document.getElementById("sessions-hint");
const sessionsList = document.getElementById("sessions-list");
const sessionsEmpty = document.getElementById("sessions-empty");
const btnSaveSession = document.getElementById("btn-save-session");
const btnSaveTop = document.getElementById("btn-save-top");

const MANAGER_URL = chrome.runtime.getURL("manager.html");

const WINDOW_NAMES_KEY = "windowNames"; // { [windowId:string]: name }
const ACTIVE_GROUP_CONTEXT_KEY = "activeGroupContext";
const LEGACY_SESSIONS_KEY = "sessions"; // pre-sync local sessions
const SYNC_SESSIONS_INDEX_KEY = "ss:v1:i";
const SYNC_SESSION_CHUNK_PREFIX = "ss:v1:t:";
const MAX_SESSIONS = 50;
const MAX_SESSION_TITLE_CHARS = 240;
const MAX_GROUP_TITLE_CHARS = 80;
const MAX_SYNC_ITEM_BYTES = 7600;       // Chrome sync limit is ~8 KB per item.
const MAX_SYNC_TOTAL_BYTES = 95000;     // Chrome sync limit is ~100 KB total.
const MAX_SYNC_ITEMS_USED = 450;        // Leave room under Chrome's 512 item cap.

let allWindows = [];   // [{ id, focused, tabs, groupById: Map<groupId, {title,color,windowId}> }]
let groupBySite = false;
let query = "";
let windowNames = {};  // mirror of storage
let sessions = [];     // mirror of storage
let sessionsSyncReady = true;
let activeGroupContext = null;
let lastWindowsSignature = "";

/* Chrome tab-group color name -> hex (for the chip + left band) */
const GROUP_COLORS = {
  grey: "#9aa3b5", blue: "#5b8cff", red: "#ff6b6b", yellow: "#ffd23f",
  green: "#3ddc97", pink: "#ff7eb6", purple: "#b48cff", cyan: "#4cd6e0",
  orange: "#ffa454"
};
const VALID_GROUP_COLORS = new Set(Object.keys(GROUP_COLORS));

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

/* ---------- storage ---------- */
async function loadStored() {
  try {
    await restrictSyncStorageAccess();
    const got = await chrome.storage.local.get([WINDOW_NAMES_KEY, LEGACY_SESSIONS_KEY]);
    windowNames = got[WINDOW_NAMES_KEY] || {};
    sessions = await loadSyncedSessions() || [];
    const legacySessions = normalizeSessions(got[LEGACY_SESSIONS_KEY]);
    if (legacySessions.length > 0) {
      const merged = mergeSessions(legacySessions, sessions);
      if (!sameSessions(sessions, merged)) {
        sessions = merged;
        if (await saveSessions()) {
          try { await chrome.storage.local.remove(LEGACY_SESSIONS_KEY); } catch {}
        }
      }
    }
  } catch {
    windowNames = {}; sessions = [];
  }
}
async function saveWindowNames() {
  try { await chrome.storage.local.set({ [WINDOW_NAMES_KEY]: windowNames }); } catch {}
}
async function saveSessions() {
  const snapshot = normalizeSessions(sessions);
  const payload = buildSyncSessionsPayload(snapshot);
  try {
    await writeSyncedSessions(payload);
    sessions = payload.sessions;
    sessionsSyncReady = true;
    return true;
  } catch (err) {
    sessionsSyncReady = false;
    console.warn("Tabpane: saved sessions could not sync; keeping local fallback", err);
    try { await chrome.storage.local.set({ [LEGACY_SESSIONS_KEY]: snapshot }); } catch {}
    return false;
  }
}
async function writeSyncedSessions(payload) {
  const staleKeys = (await getSyncSessionKeys()).filter(key => !payload.activeKeys.has(key));
  try {
    await chrome.storage.sync.set(payload.values);
  } catch (err) {
    if (staleKeys.length === 0) throw err;
    await chrome.storage.sync.remove(staleKeys);
    await chrome.storage.sync.set(payload.values);
    return;
  }
  if (staleKeys.length > 0) await chrome.storage.sync.remove(staleKeys);
}
async function restrictSyncStorageAccess() {
  try {
    if (chrome.storage.sync.setAccessLevel) {
      await chrome.storage.sync.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
  } catch {}
}
async function loadSyncedSessions() {
  try {
    const got = await chrome.storage.sync.get(SYNC_SESSIONS_INDEX_KEY);
    const index = Array.isArray(got[SYNC_SESSIONS_INDEX_KEY]) ? got[SYNC_SESSIONS_INDEX_KEY] : [];
    const chunkKeys = [];
    for (const entry of index) {
      if (!Array.isArray(entry.chunks)) continue;
      for (const key of entry.chunks) {
        if (isSyncSessionChunkKey(key)) chunkKeys.push(key);
      }
    }
    const chunks = chunkKeys.length > 0 ? await chrome.storage.sync.get(chunkKeys) : {};
    const loaded = [];
    for (const entry of index) {
      if (!entry || typeof entry !== "object" || !Array.isArray(entry.chunks)) continue;
      const tabs = [];
      for (const key of entry.chunks) {
        const chunk = chunks[key];
        if (Array.isArray(chunk)) tabs.push(...chunk);
      }
      const [session] = normalizeSessions([{ ...entry, tabs }]);
      if (session) loaded.push(session);
    }
    sessionsSyncReady = true;
    return loaded.slice(0, MAX_SESSIONS);
  } catch (err) {
    sessionsSyncReady = false;
    console.warn("Tabpane: saved sessions could not be loaded from sync storage", err);
    return null;
  }
}
async function getSyncSessionKeys() {
  const area = chrome.storage.sync;
  try {
    if (area.getKeys) return (await area.getKeys()).filter(isSyncSessionKey);
  } catch {}
  try {
    return Object.keys(await area.get(null)).filter(isSyncSessionKey);
  } catch {
    return [];
  }
}
function isSyncSessionKey(key) {
  return key === SYNC_SESSIONS_INDEX_KEY || isSyncSessionChunkKey(key);
}
function isSyncSessionChunkKey(key) {
  return typeof key === "string" && key.startsWith(SYNC_SESSION_CHUNK_PREFIX);
}
function normalizeSessions(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const session of value) {
    if (!session || typeof session !== "object") continue;
    const id = String(session.id || uid()).slice(0, 80);
    const name = String(session.name || "Session").trim().slice(0, 80) || "Session";
    const createdAt = Number.isFinite(session.createdAt) ? Number(session.createdAt) : Date.now();
    const tabs = [];
    if (Array.isArray(session.tabs)) {
      for (const tab of session.tabs) {
        const clean = normalizeSessionTab(tab);
        if (clean) tabs.push(clean);
      }
    }
    if (tabs.length > 0) normalized.push({ id, name, createdAt, tabs });
    if (normalized.length >= MAX_SESSIONS) break;
  }
  return normalized.sort((a, b) => b.createdAt - a.createdAt);
}
function normalizeSessionTab(tab) {
  if (!tab || typeof tab !== "object" || !/^https?:/.test(tab.url || "")) return null;
  const clean = {
    url: String(tab.url),
    title: String(tab.title || "").slice(0, MAX_SESSION_TITLE_CHARS)
  };
  const groupKey = String(tab.groupKey || "").trim().slice(0, 120);
  if (groupKey) {
    clean.groupKey = groupKey;
    clean.groupTitle = normalizeGroupTitle(tab.groupTitle || "Group");
    if (VALID_GROUP_COLORS.has(tab.groupColor)) clean.groupColor = tab.groupColor;
  }
  return clean;
}
function mergeSessions(primary, secondary) {
  const byId = new Map();
  for (const session of [...normalizeSessions(primary), ...normalizeSessions(secondary)]) {
    if (!byId.has(session.id)) byId.set(session.id, session);
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_SESSIONS);
}
function sameSessions(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function syncItemBytes(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}
function normalizeGroupTitle(title) {
  return String(title || "").trim().slice(0, MAX_GROUP_TITLE_CHARS) || "Group";
}
function validGroupColor(color) {
  return VALID_GROUP_COLORS.has(color) ? color : "grey";
}
function nativeGroupId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id !== -1 ? id : null;
}
function buildSyncSessionsPayload(inputSessions) {
  const source = normalizeSessions(inputSessions);
  for (let count = source.length; count >= 0; count--) {
    const attempt = tryBuildSyncSessionsPayload(source.slice(0, count));
    if (attempt) return attempt;
  }
  return {
    sessions: [],
    values: { [SYNC_SESSIONS_INDEX_KEY]: [] },
    activeKeys: new Set([SYNC_SESSIONS_INDEX_KEY])
  };
}
function tryBuildSyncSessionsPayload(sourceSessions) {
  const values = {};
  const activeKeys = new Set([SYNC_SESSIONS_INDEX_KEY]);
  const index = [];
  const savedSessions = [];
  let totalBytes = 0;

  for (const session of sourceSessions) {
    const chunks = [];
    let current = [];
    let chunkIndex = 0;
    for (const tab of session.tabs) {
      const key = `${SYNC_SESSION_CHUNK_PREFIX}${session.id}:${chunkIndex}`;
      if (syncItemBytes(key, [tab]) > MAX_SYNC_ITEM_BYTES) continue;
      const next = current.concat(tab);
      if (current.length > 0 && syncItemBytes(key, next) > MAX_SYNC_ITEM_BYTES) {
        chunks.push({ key, tabs: current });
        activeKeys.add(key);
        chunkIndex += 1;
        current = [tab];
      } else {
        current = next;
      }
    }
    if (current.length > 0) {
      const key = `${SYNC_SESSION_CHUNK_PREFIX}${session.id}:${chunkIndex}`;
      chunks.push({ key, tabs: current });
      activeKeys.add(key);
    }
    if (chunks.length === 0) continue;
    index.push({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      tabCount: chunks.reduce((sum, chunk) => sum + chunk.tabs.length, 0),
      chunks: chunks.map(chunk => chunk.key)
    });
    savedSessions.push({
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      tabs: chunks.flatMap(chunk => chunk.tabs)
    });
    for (const chunk of chunks) values[chunk.key] = chunk.tabs;
  }

  values[SYNC_SESSIONS_INDEX_KEY] = index;
  if (syncItemBytes(SYNC_SESSIONS_INDEX_KEY, index) > MAX_SYNC_ITEM_BYTES) return null;
  const keys = Object.keys(values);
  if (keys.length > MAX_SYNC_ITEMS_USED) return null;
  for (const key of keys) totalBytes += syncItemBytes(key, values[key]);
  if (totalBytes > MAX_SYNC_TOTAL_BYTES) return null;
  return { sessions: savedSessions, values, activeKeys };
}

/* ---------- data ---------- */
async function load() {
  if (pageUnloading) return;
  let wins, groups, nextActiveGroupContext;
  try {
    [wins, groups, nextActiveGroupContext] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      chrome.tabGroups ? chrome.tabGroups.query({}) : Promise.resolve([]),
      loadActiveGroupContext()
    ]);
  } catch {
    return;
  }
  activeGroupContext = nextActiveGroupContext;
  const groupById = new Map();
  for (const g of groups) groupById.set(g.id, { id: g.id, title: g.title || "", color: g.color, windowId: g.windowId });

  const nextWindows = wins.map(w => {
    const rawTabs = (w.tabs || []).filter(t => t.url !== MANAGER_URL);
    for (const tab of rawTabs) {
      const groupId = nativeGroupId(tab.groupId);
      if (groupId === null || groupById.has(groupId)) continue;
      const captured = activeGroupContext && activeGroupContext.groupId === groupId ? activeGroupContext : null;
      groupById.set(groupId, {
        id: groupId,
        title: captured ? captured.groupTitle : "",
        color: captured ? captured.groupColor : "grey",
        windowId: w.id
      });
    }
    return {
      id: w.id,
      focused: w.focused,
      tabs: rawTabs.map(t => {
        const groupId = nativeGroupId(t.groupId);
        const meta = groupId !== null ? groupById.get(groupId) : null;
        return {
          id: t.id, windowId: t.windowId, index: t.index, url: t.url, title: t.title,
          favIconUrl: t.favIconUrl, active: t.active, audible: t.audible,
          pinned: t.pinned, groupId: t.groupId,
          groupTitle: meta ? normalizeGroupTitle(meta.title) : "",
          groupColor: meta ? validGroupColor(meta.color) : ""
        };
      }),
      groupById
    };
  }).filter(w => w.tabs.length > 0);
  const nextSignature = windowsSignature(nextWindows, activeGroupContext);
  const windowsChanged = nextSignature !== lastWindowsSignature;
  allWindows = nextWindows;
  lastWindowsSignature = nextSignature;

  // prune names for windows that no longer exist
  const liveIds = new Set(allWindows.map(w => String(w.id)));
  let changed = false;
  for (const k of Object.keys(windowNames)) {
    if (!liveIds.has(k)) { delete windowNames[k]; changed = true; }
  }
  if (changed) saveWindowNames();

  if (windowsChanged || changed) render();
}
async function loadActiveGroupContext() {
  try {
    const got = await chrome.storage.local.get(ACTIVE_GROUP_CONTEXT_KEY);
    return normalizeActiveGroupContext(got[ACTIVE_GROUP_CONTEXT_KEY]);
  } catch {
    return null;
  }
}
function normalizeActiveGroupContext(value) {
  if (!value || typeof value !== "object") return null;
  const windowId = Number(value.windowId);
  const groupId = Number(value.groupId);
  const capturedAt = Number(value.capturedAt);
  if (!Number.isFinite(windowId) || !Number.isFinite(groupId)) return null;
  if (Number.isFinite(capturedAt) && Date.now() - capturedAt > 30 * 60 * 1000) return null;
  return {
    windowId,
    tabId: Number.isFinite(value.tabId) ? Number(value.tabId) : null,
    groupId,
    groupTitle: String(value.groupTitle || "").slice(0, MAX_GROUP_TITLE_CHARS),
    groupColor: validGroupColor(value.groupColor),
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : 0
  };
}
function windowsSignature(windows, selectedContext) {
  return JSON.stringify({
    selectedContext,
    windows: windows.map(win => ({
      id: win.id,
      focused: !!win.focused,
      tabs: win.tabs.map(tab => ({
        id: tab.id,
        index: tab.index,
        url: tab.url,
        title: tab.title,
        active: !!tab.active,
        audible: !!tab.audible,
        pinned: !!tab.pinned,
        groupId: tab.groupId,
        groupTitle: tab.groupTitle,
        groupColor: tab.groupColor
      }))
    }))
  });
}

// Count duplicate URLs using the SAME rules as closeDuplicates (skip pinned +
// internal pages) so the red "duplicate" highlight only marks tabs the
// "Close duplicates" action would actually close — never a pinned or
// chrome:// tab the button silently ignores.
function computeDuplicates() {
  const seen = new Map();
  for (const w of allWindows)
    for (const t of w.tabs) {
      if (t.pinned || !/^https?:/.test(t.url)) continue;
      seen.set(t.url, (seen.get(t.url) || 0) + 1);
    }
  return seen;
}
// A tab is shown as a duplicate only if it is itself closeable (non-pinned,
// http(s)) and another closeable tab shares its URL.
function isDupeTab(tab, dupeCount) {
  return !tab.pinned && /^https?:/.test(tab.url) && dupeCount.get(tab.url) > 1;
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
  const faviconUrl = faviconURL(tab.url);
  if (faviconUrl) {
    const img = document.createElement("img");
    img.alt = ""; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
    img.src = faviconUrl;
    img.addEventListener("error", () => {
      const span = el("span", "fallback"); span.textContent = letter; img.replaceWith(span);
    }, { once: true });
    wrap.appendChild(img);
  } else {
    const span = el("span", "fallback"); span.textContent = letter; wrap.appendChild(span);
  }
  return wrap;
}
function faviconURL(pageUrl) {
  if (!/^https?:/.test(pageUrl || "")) return "";
  const url = new URL(chrome.runtime.getURL("/_favicon/"));
  url.searchParams.set("pageUrl", pageUrl);
  url.searchParams.set("size", "32");
  return url.toString();
}
function buildTab(tab, q, isDupe, showGroupBadge = false) {
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
    const a = el("span", "tab-audio");
    a.title = "Playing audio"; a.textContent = "♪";
    a.setAttribute("role", "img"); a.setAttribute("aria-label", "Playing audio");
    row.appendChild(a);
  }
  if (showGroupBadge && tab.groupTitle) {
    const badge = el("span", "tab-group-badge");
    badge.title = "Chrome tab group";
    badge.textContent = tab.groupTitle;
    badge.style.setProperty("--tab-group-color", GROUP_COLORS[validGroupColor(tab.groupColor)]);
    row.appendChild(badge);
  }
  const x = el("button", "tab-x");
  x.title = "Close tab"; x.textContent = "✕"; x.dataset.action = "close-tab";
  x.setAttribute("aria-label", "Close tab");
  row.appendChild(x);
  return row;
}
function getWindowBoundGroup(win) {
  if (!win || !win.tabs || win.tabs.length === 0) return null;
  const firstGroupId = nativeGroupId(win.tabs[0].groupId);
  if (firstGroupId === null) return null;
  for (const tab of win.tabs) {
    if (nativeGroupId(tab.groupId) !== firstGroupId) return null;
  }
  const meta = win.groupById && win.groupById.get(firstGroupId);
  return meta ? { id: firstGroupId, meta } : null;
}
function getWindowGroupTitles(win) {
  if (!win || !win.groupById) return [];
  const titles = [];
  const seen = new Set();
  for (const tab of win.tabs || []) {
    const groupId = nativeGroupId(tab.groupId);
    if (groupId === null || seen.has(groupId)) continue;
    const meta = win.groupById.get(groupId);
    if (!meta) continue;
    seen.add(groupId);
    titles.push(normalizeGroupTitle(meta.title));
  }
  return titles;
}
function formatWindowGroupSuffix(titles) {
  if (!titles.length) return "";
  if (titles.length <= 2) return titles.join(", ");
  return `${titles[0]}, ${titles[1]} +${titles.length - 2}`;
}
function getSelectedWindowGroupSuffix(win) {
  if (!activeGroupContext || activeGroupContext.windowId !== win.id) return null;
  if (activeGroupContext.groupId == null || activeGroupContext.groupId === -1) return "";
  const meta = win.groupById && win.groupById.get(activeGroupContext.groupId);
  return normalizeGroupTitle(meta ? meta.title : activeGroupContext.groupTitle);
}
function findGroupMeta(groupId) {
  for (const win of allWindows) {
    if (win.groupById && win.groupById.has(groupId)) return win.groupById.get(groupId);
  }
  return null;
}
function buildWindowPanels(win, windowIndex) {
  const groupPanels = new Map();
  const ungroupedTabs = [];
  let firstUngroupedIndex = Infinity;

  for (const tab of win.tabs || []) {
    const groupId = nativeGroupId(tab.groupId);
    const meta = groupId !== null && win.groupById ? win.groupById.get(groupId) : null;
    if (!meta) {
      ungroupedTabs.push(tab);
      firstUngroupedIndex = Math.min(firstUngroupedIndex, tab.index);
      continue;
    }
    if (!groupPanels.has(groupId)) {
      groupPanels.set(groupId, {
        kind: "group",
        win,
        windowIndex,
        groupId,
        meta,
        tabs: [],
        firstIndex: tab.index
      });
    }
    const panel = groupPanels.get(groupId);
    panel.tabs.push(tab);
    panel.firstIndex = Math.min(panel.firstIndex, tab.index);
  }

  if (!groupPanels.size) {
    return [{
      kind: "window",
      win,
      windowIndex,
      tabs: win.tabs || [],
      firstIndex: 0,
      hasSiblingGroups: false
    }];
  }

  const panels = [];
  if (ungroupedTabs.length) {
    panels.push({
      kind: "window",
      win,
      windowIndex,
      tabs: ungroupedTabs,
      firstIndex: firstUngroupedIndex,
      hasSiblingGroups: true
    });
  }
  panels.push(...groupPanels.values());
  return panels.sort((a, b) => a.firstIndex - b.firstIndex);
}
function panelIsFocused(panel) {
  return !!(panel.win.focused && panel.tabs.some(tab => tab.active));
}

/* ---------- render ---------- */
let isRendering = false;
let pageUnloading = false;
let isEditing = false;        // true while a window/session name input is open
let renderQueuedDuringEdit = false;
let renderRaf = null;
function scheduleRender() {
  if (pageUnloading || renderRaf !== null) return;
  renderRaf = requestAnimationFrame(() => {
    renderRaf = null;
    render();
  });
}
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
  const panels = [];

  const frag = document.createDocumentFragment();

  allWindows.forEach((win, idx) => {
    totalTabs += win.tabs.length;
    panels.push(...buildWindowPanels(win, idx));
  });

  panels.forEach((panel, panelIdx) => {
    const win = panel.win;
    const visible = q ? panel.tabs.filter(t => haystack(t).includes(q)) : panel.tabs;
    if (visible.length === 0) return;

    const isGroupPanel = panel.kind === "group";
    const boundGroup = isGroupPanel ? { id: panel.groupId, meta: panel.meta } : getWindowBoundGroup({ ...win, tabs: panel.tabs });
    const named = boundGroup ? normalizeGroupTitle(boundGroup.meta.title) : windowNames[String(win.id)];
    const focused = panelIsFocused(panel);
    const baseTitle = named || (focused ? "Current window" : "Window " + (panelIdx + 1));
    const selectedGroupSuffix = boundGroup ? null : getSelectedWindowGroupSuffix(win);
    const groupSuffix = boundGroup || panel.hasSiblingGroups ? "" : (selectedGroupSuffix ?? formatWindowGroupSuffix(getWindowGroupTitles(win)));
    const displayTitle = groupSuffix ? `${baseTitle} (${groupSuffix})` : baseTitle;
    const col = el("section", "window-col" + (focused ? " is-current" : "") + (named ? " is-named" : "") + (boundGroup ? " is-group-window" : ""));
    col.dataset.windowId = String(win.id);
    col.dataset.panelKind = panel.kind;
    col.dataset.panelId = boundGroup ? `${win.id}:g:${boundGroup.id}` : `${win.id}:w:${panel.firstIndex}`;
    if (boundGroup) {
      col.dataset.groupId = String(boundGroup.id);
      col.style.setProperty("--window-group-color", GROUP_COLORS[validGroupColor(boundGroup.meta.color)]);
    }

    // head
    const head = el("div", "window-head");
    const dot = el("span", "window-dot");
    const wtitle = el("span", "window-title");
    wtitle.dataset.action = boundGroup ? "rename-group" : "rename-window";
    if (boundGroup) wtitle.dataset.groupId = String(boundGroup.id);
    wtitle.title = boundGroup ? "Double-click to rename Chrome tab group" : "Double-click to rename";
    wtitle.textContent = displayTitle;
    const rename = el("button", "window-rename");
    rename.dataset.action = boundGroup ? "rename-group" : "rename-window";
    if (boundGroup) rename.dataset.groupId = String(boundGroup.id);
    rename.title = boundGroup ? "Rename Chrome tab group" : "Rename window"; rename.textContent = "✎";
    rename.setAttribute("aria-label", boundGroup ? "Rename Chrome tab group" : "Rename window");
    const wcount = el("span", "window-count");
    wcount.textContent = q ? `${visible.length} / ${panel.tabs.length}` : String(panel.tabs.length);
    const wclose = el("button", "window-close");
    wclose.title = boundGroup ? "Close this tab group" : "Close this window"; wclose.textContent = "✕";
    wclose.dataset.action = boundGroup ? "close-group" : "close-window";
    wclose.dataset.windowId = String(win.id);
    if (boundGroup) wclose.dataset.groupId = String(boundGroup.id);
    wclose.setAttribute("aria-label", boundGroup ? "Close this tab group" : "Close this window");
    head.append(dot, wtitle, rename, wcount, wclose);
    col.appendChild(head);

    // tab list
    const list = el("div", "tab-list");
    list.dataset.windowId = String(win.id);
    list.dataset.panelId = col.dataset.panelId;

    if (groupBySite) {
      for (const [label, tabs] of groupByHost(visible)) {
        if (label) { const gl = el("div", "group-label"); gl.textContent = label; list.appendChild(gl); }
        for (const tab of tabs) list.appendChild(buildTab(tab, q, isDupeTab(tab, dupeCount), !isGroupPanel));
      }
    } else if (isGroupPanel || panel.hasSiblingGroups) {
      for (const tab of visible) list.appendChild(buildTab(tab, q, isDupeTab(tab, dupeCount)));
    } else {
      // preserve order but surface chrome tab-group bands
      let currentGroup = null, groupWrap = null;
      for (const tab of visible) {
        const gid = nativeGroupId(tab.groupId);
        if (gid !== currentGroup) {
          currentGroup = gid;
          if (gid != null && win.groupById.has(gid)) {
            const meta = win.groupById.get(gid);
            const color = GROUP_COLORS[meta.color] || GROUP_COLORS.grey;
            const band = el("div", "group-band");
            band.dataset.groupId = String(gid);
            const chip = el("span", "group-chip"); chip.style.background = color;
            const name = el("button", "group-title");
            name.type = "button";
            name.dataset.action = "rename-group";
            name.dataset.groupId = String(gid);
            name.title = "Rename Chrome tab group";
            name.textContent = normalizeGroupTitle(meta.title);
            band.append(chip, name);
            list.appendChild(band);
            groupWrap = el("div", "group-tabs");
            groupWrap.style.setProperty("--group-color", color);
            list.appendChild(groupWrap);
          } else {
            groupWrap = null;
          }
        }
        const node = buildTab(tab, q, isDupeTab(tab, dupeCount));
        (groupWrap || list).appendChild(node);
      }
    }
    col.appendChild(list);
    frag.appendChild(col);
  });

  // Capture scroll position of each window's tab list (keyed by window id,
  // which is stable across renders) so a background re-render doesn't yank
  // the user back to the top while they're scrolling.
  const scrollByPanel = new Map();
  for (const listEl of board.querySelectorAll(".tab-list")) {
    if (listEl.scrollTop > 0) scrollByPanel.set(listEl.dataset.panelId, listEl.scrollTop);
  }

  board.replaceChildren(frag);

  // Restore scroll positions onto the freshly built lists.
  if (scrollByPanel.size) {
    for (const listEl of board.querySelectorAll(".tab-list")) {
      const prev = scrollByPanel.get(listEl.dataset.panelId);
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
async function closeGroupTabs(windowId, groupId) {
  const win = allWindows.find(w => w.id === windowId);
  const ids = win ? win.tabs.filter(t => nativeGroupId(t.groupId) === groupId).map(t => t.id) : [];
  if (!ids.length) return;
  for (const w of allWindows) w.tabs = w.tabs.filter(t => !ids.includes(t.id));
  allWindows = allWindows.filter(w => w.tabs.length > 0);
  render();
  for (const id of ids) {
    try { await chrome.tabs.remove(id); }
    catch (err) { console.warn("Tabpane: could not close grouped tab", id, err); }
  }
  scheduleLoad();
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
function beginRename(windowId, targetCol) {
  const col = targetCol || board.querySelector(`.window-col[data-window-id="${windowId}"]`);
  if (!col) return;
  const titleEl = col.querySelector(".window-title");
  if (!titleEl || col.querySelector(".window-name-input")) return;

  const groupId = Number(col.dataset.groupId);
  if (Number.isFinite(groupId)) {
    beginRenameGroup(groupId, titleEl, "window-name-input");
    return;
  }

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

function beginRenameGroup(groupId, targetEl, inputClass = "group-name-input") {
  const target = targetEl || board.querySelector(`.group-band[data-group-id="${groupId}"] .group-title`);
  if (!target || target.parentElement.querySelector(`.${inputClass}`)) return;

  const meta = findGroupMeta(groupId);
  isEditing = true;

  const input = el("input", inputClass);
  input.type = "text";
  input.maxLength = MAX_GROUP_TITLE_CHARS;
  input.value = meta ? meta.title || "" : "";
  input.placeholder = "Group name";
  target.replaceWith(input);
  input.focus(); input.select();

  let done = false;
  const commit = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const title = normalizeGroupTitle(input.value);
      try {
        await chrome.tabGroups.update(groupId, { title });
        const live = findGroupMeta(groupId);
        if (live) live.title = title;
      } catch (err) {
        console.warn("Tabpane: could not rename Chrome tab group", err);
      }
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
let dropTargetCol = null;
let dropMarkerTab = null;
let dropMarkerClass = null;
function clearDropMarkers() {
  if (dropTargetCol) dropTargetCol.classList.remove("drop-target");
  if (dropMarkerTab && dropMarkerClass) dropMarkerTab.classList.remove(dropMarkerClass);
  dropTargetCol = null;
  dropMarkerTab = null;
  dropMarkerClass = null;
}
function setDropMarkers(col, tab, markerClass) {
  if (dropTargetCol === col && dropMarkerTab === tab && dropMarkerClass === markerClass) return;
  clearDropMarkers();
  dropTargetCol = col;
  dropMarkerTab = tab;
  dropMarkerClass = markerClass;
  if (dropTargetCol) dropTargetCol.classList.add("drop-target");
  if (dropMarkerTab && dropMarkerClass) dropMarkerTab.classList.add(dropMarkerClass);
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
  const overTab = e.target.closest(".tab");
  let markerClass = null;
  if (overTab && !overTab.classList.contains("dragging")) {
    const r = overTab.getBoundingClientRect();
    markerClass = (e.clientY - r.top) < r.height / 2 ? "drop-before" : "drop-after";
  }
  setDropMarkers(col, overTab, markerClass);
});
board.addEventListener("drop", async e => {
  if (dragTabId == null) return;
  const col = e.target.closest(".window-col");
  if (!col) { clearDropMarkers(); return; }
  e.preventDefault();
  const targetWindowId = Number(col.dataset.windowId);
  const targetGroupId = Number(col.dataset.groupId);
  const targetIsGroup = Number.isFinite(targetGroupId);

  // Compute destination index from the drop marker. Use the target tab's real
  // Chrome tab index (not its position among the rendered rows) so the drop
  // lands correctly even when a search filter is hiding tabs between them.
  let index = -1; // -1 = append
  const overTab = e.target.closest(".tab");
  if (overTab && !overTab.classList.contains("dragging")) {
    const overTabObj = findTab(Number(overTab.dataset.tabId));
    if (overTabObj) {
      const after = overTab.classList.contains("drop-after");
      index = overTabObj.index + (after ? 1 : 0);
    }
  } else if (targetIsGroup) {
    const targetWindow = allWindows.find(w => w.id === targetWindowId);
    const groupTabs = targetWindow ? targetWindow.tabs.filter(t => nativeGroupId(t.groupId) === targetGroupId) : [];
    if (groupTabs.length) index = Math.max(...groupTabs.map(t => t.index)) + 1;
  }
  const movingId = dragTabId;
  clearDropMarkers();
  dragTabId = null;
  try {
    await chrome.tabs.move(movingId, { windowId: targetWindowId, index });
    if (targetIsGroup && chrome.tabs.group) {
      await chrome.tabs.group({ tabIds: movingId, groupId: targetGroupId });
    } else if (col.dataset.panelKind === "window" && chrome.tabs.ungroup) {
      try { await chrome.tabs.ungroup(movingId); } catch {}
    }
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
  if (action === "close-group") {
    e.stopPropagation();
    const col = e.target.closest(".window-col");
    const windowId = Number(e.target.dataset.windowId || col?.dataset.windowId);
    const groupId = Number(e.target.dataset.groupId || col?.dataset.groupId);
    if (Number.isFinite(windowId) && Number.isFinite(groupId)) closeGroupTabs(windowId, groupId);
    return;
  }
  if (action === "rename-window") {
    e.stopPropagation();
    const col = e.target.closest(".window-col");
    if (col) beginRename(Number(col.dataset.windowId), col);
    return;
  }
  if (action === "rename-group") {
    e.stopPropagation();
    const col = e.target.closest(".window-col");
    const groupId = Number(e.target.dataset.groupId || e.target.closest(".group-band")?.dataset.groupId || col?.dataset.groupId);
    const target = col?.querySelector(".window-title") || e.target.closest(".window-title") || undefined;
    if (Number.isFinite(groupId)) beginRenameGroup(groupId, target, col ? "window-name-input" : "group-name-input");
    return;
  }
  const row = e.target.closest(".tab");
  if (row) { const tab = findTab(Number(row.dataset.tabId)); if (tab) switchTo(tab); }
});
board.addEventListener("dblclick", e => {
  const titleEl = e.target.closest(".window-title");
  if (!titleEl) return;
  const col = e.target.closest(".window-col");
  if (!col) return;
  const groupId = Number(col.dataset.groupId);
  if (Number.isFinite(groupId)) beginRenameGroup(groupId, titleEl, "window-name-input");
  else beginRename(Number(col.dataset.windowId), col);
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
  renderSessionsHint();
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
    const groupCount = countSessionGroups(s);
    const groupText = groupCount > 0 ? ` · ${groupCount} group${groupCount === 1 ? "" : "s"}` : "";
    meta.textContent = `${s.tabs.length} tab${s.tabs.length === 1 ? "" : "s"}${groupText} · ${timeAgo(s.createdAt)}`;
    li.appendChild(meta);

    const actions = el("div", "session-actions");
    const open = el("button", "btn"); open.textContent = "Open"; open.dataset.action = "open-session";
    open.title = "Open saved tabs. Saved Chrome tab groups open in their own windows.";
    const openNew = el("button", "btn ghost"); openNew.textContent = "New window"; openNew.dataset.action = "open-session-new";
    openNew.title = "Open ungrouped tabs in a new window. Saved Chrome tab groups always open in their own windows.";
    const del = el("button", "btn ghost"); del.textContent = "Delete"; del.dataset.action = "delete-session";
    actions.append(open, openNew, del);
    li.appendChild(actions);

    sessionsList.appendChild(li);
  }
}
function renderSessionsHint() {
  sessionsHint.textContent = sessionsSyncReady
    ? "A session stores the tabs open right now so you can reopen them later. Synced with your Chrome profile when Chrome Sync is on."
    : "Sync is unavailable right now. New session changes are saved locally on this device.";
}
function countSessionGroups(session) {
  return new Set((session.tabs || []).map(tab => tab.groupKey).filter(Boolean)).size;
}
async function saveCurrentSession() {
  const tabs = [];
  for (const w of allWindows) {
    for (const t of w.tabs) {
      if (!/^https?:/.test(t.url)) continue;
      const savedTab = { url: t.url, title: t.title || "" };
      const meta = (t.groupId != null && t.groupId !== -1) ? w.groupById.get(t.groupId) : null;
      if (meta) {
        savedTab.groupKey = `${w.id}:${t.groupId}`;
        savedTab.groupTitle = normalizeGroupTitle(meta.title);
        savedTab.groupColor = validGroupColor(meta.color);
      }
      tabs.push(savedTab);
    }
  }
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
  const { groups, ungrouped } = splitSessionTabsByGroup(s.tabs);
  for (const group of groups) {
    try {
      await openSavedGroupInOwnWindow(group);
    } catch (err) {
      console.warn("Tabpane: could not open saved tab group", err);
    }
  }
  try {
    const urls = ungrouped.map(t => t.url).filter(u => /^https?:/.test(u));
    if (urls.length) {
      if (newWindow) {
        await chrome.windows.create({ url: urls });
      } else {
        for (const url of urls) await chrome.tabs.create({ url, active: false });
      }
    }
  } catch (err) {
    console.warn("Tabpane: could not open saved session", err);
  }
  scheduleLoad();
}
function splitSessionTabsByGroup(tabs) {
  const groupsByKey = new Map();
  const ungrouped = [];
  for (const tab of tabs) {
    if (!tab || !/^https?:/.test(tab.url || "")) continue;
    if (!tab.groupKey) {
      ungrouped.push(tab);
      continue;
    }
    if (!groupsByKey.has(tab.groupKey)) {
      groupsByKey.set(tab.groupKey, {
        key: tab.groupKey,
        title: normalizeGroupTitle(tab.groupTitle),
        color: validGroupColor(tab.groupColor),
        tabs: []
      });
    }
    groupsByKey.get(tab.groupKey).tabs.push(tab);
  }
  return {
    groups: [...groupsByKey.values()].filter(group => group.tabs.length > 0),
    ungrouped
  };
}
async function openSavedGroupInOwnWindow(group) {
  const urls = group.tabs.map(t => t.url).filter(u => /^https?:/.test(u));
  if (!urls.length) return;
  const created = await chrome.windows.create({ url: urls });
  let createdTabs = Array.isArray(created && created.tabs) ? created.tabs : [];
  if (created && created.id != null && createdTabs.length < urls.length) {
    createdTabs = await chrome.tabs.query({ windowId: created.id });
  }
  const tabIds = createdTabs
    .filter(tab => tab && tab.id != null && /^https?:/.test(tab.url || ""))
    .sort((a, b) => a.index - b.index)
    .map(tab => tab.id);
  if (!tabIds.length || !chrome.tabs.group || !chrome.tabGroups) return;
  const groupId = await chrome.tabs.group({ tabIds });
  await chrome.tabGroups.update(groupId, {
    title: normalizeGroupTitle(group.title),
    color: validGroupColor(group.color)
  });
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
searchEl.addEventListener("input", e => { query = e.target.value; scheduleRender(); });
searchEl.addEventListener("keydown", e => {
  if (e.key === "Enter") { const first = board.querySelector(".tab"); if (first) first.click(); }
  else if (e.key === "Escape") { searchEl.value = ""; query = ""; scheduleRender(); searchEl.blur(); }
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
  scheduleRender();
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
const onStorageChanged = (changes, areaName) => {
  if (areaName === "local" && ACTIVE_GROUP_CONTEXT_KEY in changes) {
    scheduleLoad();
    return;
  }
  if (areaName !== "sync") return;
  if (!Object.keys(changes).some(isSyncSessionKey)) return;
  refreshSessionsFromSync();
};
let syncRefreshInFlight = false;
async function refreshSessionsFromSync() {
  if (pageUnloading || syncRefreshInFlight) return;
  syncRefreshInFlight = true;
  try {
    const next = await loadSyncedSessions();
    if (next === null) {
      if (!sessionsPanel.hidden) renderSessionsHint();
      return;
    }
    if (!sameSessions(sessions, next)) {
      sessions = next;
      if (!sessionsPanel.hidden) renderSessions();
    } else if (!sessionsPanel.hidden) {
      renderSessionsHint();
    }
  } finally {
    syncRefreshInFlight = false;
  }
}

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
chrome.storage.onChanged.addListener(onStorageChanged);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (pendingWhileHidden) pendingWhileHidden = false;
    scheduleLoad();
  }
});
window.addEventListener("focus", onAnyTabChange);

// Brave/Chromium builds can miss tabGroups events when groups are changed from
// the native tab strip. Poll only while visible, and render only on signature
// changes so this stays low-cost.
const visibleRefreshTimer = setInterval(() => {
  if (!document.hidden) scheduleLoad();
}, 5000);

/* ---------- teardown ---------- */
window.addEventListener("pagehide", () => {
  pageUnloading = true;
  for (const ev of registered) { try { ev.removeListener(onAnyTabChange); } catch {} }
  for (const ev of groupEvents) { try { ev.removeListener(onAnyTabChange); } catch {} }
  try { chrome.tabs.onUpdated.removeListener(onTabUpdated); } catch {}
  try { chrome.windows.onRemoved.removeListener(onAnyTabChange); } catch {}
  try { chrome.windows.onCreated.removeListener(onAnyTabChange); } catch {}
  try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch {}
  try { window.removeEventListener("focus", onAnyTabChange); } catch {}
  if (loadTimer !== null) clearTimeout(loadTimer);
  if (visibleRefreshTimer !== null) clearInterval(visibleRefreshTimer);
  if (renderRaf !== null) cancelAnimationFrame(renderRaf);
  if (saveFlashTimer !== null) clearTimeout(saveFlashTimer);
}, { once: true });

/* ---------- boot ---------- */
(async () => { await loadStored(); await load(); })();
