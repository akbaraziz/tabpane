# Tabpane

v1.1 — adds drag-to-move tabs between windows, window naming, saved sessions, and Chrome tab-group display.

A tab manager for Chrome and Chromium browsers (Edge, Brave, Arc, Opera, Vivaldi).
Turns the cramped strip of favicons into a clean, searchable board where every tab
is large, legible, and one click away.

## What it does

- **See everything at once.** Tabs are laid out in columns by window, with big
  favicons and readable titles + URLs — no more guessing what a 16px icon is.
- **Search instantly.** Type to filter across every window by title or URL.
  Matches are highlighted; press Enter to jump to the first result.
- **Switch with one click.** Click any tab to focus it (and its window).
- **Find and close duplicates.** A counter shows how many duplicate tabs you have;
  one button closes the extras.
- **Group by site.** Toggle to cluster each window's tabs by domain.
- **Edit Chrome tab groups.** Rename a Chrome tab group from Tabpane and the
  title updates in Chrome too.
- **Spot audio tabs.** A ♪ marks tabs that are making noise.
- **Save synced sessions.** Save your current web tabs and reopen them later on
  devices using the same Chrome profile when Chrome Sync is enabled. Saved
  Chrome tab groups keep their group names and reopen in their own grouped
  windows.

## Keyboard

- `/` — focus search
- `Esc` — clear search
- `Enter` — jump to first result
- `Ctrl/Cmd + Shift + Space` — open Tabpane

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc.).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `tabpane` folder.
4. Pin the Tabpane icon and click it to open the manager.

## Package

Run `scripts/package-extension.sh` to create `dist/tabpane.zip` with only the extension files needed for upload or sharing.

## Privacy

Everything runs in your browser. Tabpane has no servers, no analytics, and makes
no app network requests. Saved sessions use Chrome's built-in sync storage when
Chrome Sync is enabled for your profile; otherwise Chrome keeps them local.
See `PRIVACY.md` for the full privacy policy.

## Files

- `manifest.json` — extension config (Manifest V3)
- `background.js` — opens the manager tab
- `manager.html / .css / .js` — the interface
- `icons/` — toolbar icons
