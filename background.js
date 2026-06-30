// Open the Tabpane manager in a dedicated tab when the toolbar icon is clicked.
// Reuse an existing Tabpane tab if one is already open.

const MANAGER_URL = chrome.runtime.getURL("manager.html");

chrome.action.onClicked.addListener(async () => {
  const existing = await chrome.tabs.query({ url: MANAGER_URL });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
});
