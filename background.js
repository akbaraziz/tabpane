// Open the Tabpane manager in a dedicated tab when the toolbar icon is clicked.
// Reuse an existing Tabpane tab if one is already open.

const MANAGER_URL = chrome.runtime.getURL("manager.html");

chrome.action.onClicked.addListener(async () => {
  const existing = await chrome.tabs.query({});
  const managerTab = existing.find(tab => tab.url === MANAGER_URL);
  if (managerTab) {
    await chrome.tabs.update(managerTab.id, { active: true });
    await chrome.windows.update(managerTab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
});
