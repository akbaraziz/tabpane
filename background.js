// Open the Tabpane manager in a dedicated tab when the toolbar icon is clicked.
// Reuse an existing Tabpane tab if one is already open.

const MANAGER_URL = chrome.runtime.getURL("manager.html");
const ACTIVE_GROUP_CONTEXT_KEY = "activeGroupContext";

chrome.action.onClicked.addListener(async () => {
  await captureActiveGroupContext();
  const existing = await chrome.tabs.query({});
  const managerTab = existing.find(tab => tab.url === MANAGER_URL);
  if (managerTab) {
    await chrome.tabs.update(managerTab.id, { active: true });
    await chrome.windows.update(managerTab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await captureTabGroupContext(tab);
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
  if (!tab || !tab.active || !("groupId" in changeInfo)) return;
  await captureTabGroupContext(tab);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await captureActiveGroupContext(windowId);
});

if (chrome.tabGroups) {
  chrome.tabGroups.onUpdated.addListener(async (group) => {
    try {
      const got = await chrome.storage.local.get(ACTIVE_GROUP_CONTEXT_KEY);
      const context = got[ACTIVE_GROUP_CONTEXT_KEY];
      if (!context || context.groupId !== group.id) return;
      await chrome.storage.local.set({
        [ACTIVE_GROUP_CONTEXT_KEY]: {
          ...context,
          groupTitle: group.title || "",
          groupColor: group.color || "",
          capturedAt: Date.now()
        }
      });
    } catch {}
  });
}

async function captureActiveGroupContext(windowId) {
  try {
    const query = { active: true };
    if (windowId != null) query.windowId = windowId;
    else query.currentWindow = true;
    const [activeTab] = await chrome.tabs.query(query);
    await captureTabGroupContext(activeTab);
  } catch {}
}

async function captureTabGroupContext(activeTab) {
  try {
    if (!activeTab || isManagerTab(activeTab)) return;
    const context = {
      windowId: activeTab.windowId,
      tabId: activeTab.id,
      groupId: activeTab.groupId,
      groupTitle: "",
      groupColor: "",
      capturedAt: Date.now()
    };

    if (activeTab.groupId != null && activeTab.groupId !== -1 && chrome.tabGroups) {
      try {
        const group = await chrome.tabGroups.get(activeTab.groupId);
        context.groupTitle = group.title || "";
        context.groupColor = group.color || "";
      } catch {}
    }

    await chrome.storage.local.set({ [ACTIVE_GROUP_CONTEXT_KEY]: context });
  } catch {}
}

function isManagerTab(tab) {
  return !!(tab && tab.url && tab.url.startsWith(MANAGER_URL));
}
