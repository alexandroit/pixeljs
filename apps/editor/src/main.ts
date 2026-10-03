import { byId, isTyping, Status } from './dom.js';
import { ExportPanel } from './export-panel.js';
import { ImportDialog } from './import-dialog.js';
import { formatBytes } from './limits.js';
import { MapPanel } from './map-panel.js';
import { PalettePanel } from './palette-panel.js';
import { Preview } from './preview.js';
import { createDefaultProject } from './project.js';
import { ProjectFiles } from './project-files.js';
import { AudioPreview } from './audio-preview.js';
import { MusicPanel } from './music-panel.js';
import { SoundPanel } from './sound-panel.js';
import { SpritePanel } from './sprite-panel.js';
import { Studio } from './studio.js';

type Tab = 'sprite' | 'map' | 'sound' | 'music' | 'export';

const studio = new Studio(createDefaultProject());
const status = new Status(byId('status', HTMLSpanElement));
const cursorStatus = byId('cursor-status', HTMLSpanElement);
const preview = new Preview(
  studio,
  {
    sprite: byId('sprite-preview-host', HTMLDivElement),
    map: byId('map-preview-host', HTMLDivElement),
  },
  (message) => status.error(message),
);
const importDialog = new ImportDialog(studio, status);
const spritePanel = new SpritePanel(
  studio,
  status,
  cursorStatus,
  (file) => void importDialog.open(file),
);
new PalettePanel(studio, status);
const mapPanel = new MapPanel(studio, status, cursorStatus, preview);
const exportPanel = new ExportPanel(studio, status);
const audio = new AudioPreview((message) => status.error(message));
const soundPanel = new SoundPanel(studio, status, audio);
const musicPanel = new MusicPanel(studio, status, audio);
// Previews belong to the open project: New and Open silence them.
studio.on((event) => {
  if (event === 'project') audio.stop();
});
const files = new ProjectFiles(studio, status);
let activeTab: Tab = 'sprite';

// Preview background selectors (one per preview slot) share one setting.
const backgrounds = [
  byId('sprite-preview-bg', HTMLSelectElement),
  byId('map-preview-bg', HTMLSelectElement),
];
function syncBackgrounds(): void {
  for (const select of backgrounds) {
    const value = select.value;
    select.replaceChildren(
      ...studio.project.palette.map((_, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `Color ${index}`;
        return option;
      }),
    );
    select.value = value !== '' && Number(value) < studio.project.palette.length ? value : '0';
  }
  preview.setBackground(Number(backgrounds[0]!.value));
}
for (const select of backgrounds)
  select.addEventListener('change', () => {
    for (const other of backgrounds) other.value = select.value;
    preview.setBackground(Number(select.value));
  });
syncBackgrounds();
studio.on((event) => {
  if (event === 'palette' || event === 'project') syncBackgrounds();
});

// History controls and the footer summary.
const undoButton = byId('btn-undo', HTMLButtonElement);
const redoButton = byId('btn-redo', HTMLButtonElement);
const historyStatus = byId('history-status', HTMLSpanElement);
function syncHistory(): void {
  const history = studio.history;
  undoButton.disabled = history.undoCount === 0;
  redoButton.disabled = history.redoCount === 0;
  historyStatus.dataset['undo'] = String(history.undoCount);
  historyStatus.dataset['redo'] = String(history.redoCount);
  historyStatus.dataset['bytes'] = String(history.bytes);
  historyStatus.textContent = `Undo ${history.undoCount} · redo ${history.redoCount} · ${formatBytes(history.bytes)}${studio.dirty ? ' · unsaved' : ''}`;
}
studio.on((event) => {
  if (event === 'history') syncHistory();
});
syncHistory();
function undo(): void {
  const entry = studio.undo();
  status.info(entry ? `Undid: ${entry.label}.` : 'Nothing to undo.');
}
function redo(): void {
  const entry = studio.redo();
  status.info(entry ? `Redid: ${entry.label}.` : 'Nothing to redo.');
}
undoButton.addEventListener('click', undo);
redoButton.addEventListener('click', redo);

// Tabs follow the ARIA tabs pattern: arrow keys move between them.
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
function activate(tab: HTMLButtonElement, focus: boolean): void {
  studio.flushInteractions();
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    byId(other.getAttribute('aria-controls') ?? '', HTMLElement).hidden = !selected;
  }
  if (focus) tab.focus();
  activeTab = tab.dataset['tab'] as Tab;
  preview.setMode(activeTab === 'sprite' || activeTab === 'map' ? activeTab : 'off');
  cursorStatus.textContent = '';
  exportPanel.setVisible(activeTab === 'export');
  if (activeTab === 'sprite') spritePanel.onShow();
  if (activeTab === 'map') mapPanel.onShow();
  if (activeTab === 'sound') soundPanel.onShow();
  if (activeTab === 'music') musicPanel.onShow();
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => activate(tab, false));
  tab.addEventListener('keydown', (event) => {
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    activate(tabs[next]!, true);
  });
});
activate(tabs[0]!, false);

// Global shortcuts never fire while a field has focus or a dialog is open.
window.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || isTyping(event.target)) return;
  if (event.target instanceof Element && event.target.closest('dialog')) return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  let handled = true;
  if (mod && !event.altKey && key === 'z') {
    if (event.shiftKey) redo();
    else undo();
  } else if (mod && !event.altKey && key === 'y') redo();
  else if (mod && !event.altKey && key === 's') files.save();
  else if (mod && !event.altKey && key === 'o') files.open();
  else if (activeTab === 'sprite') handled = spritePanel.shortcut(event);
  else if (activeTab === 'map') handled = mapPanel.shortcut(event);
  else if (activeTab === 'sound') handled = soundPanel.shortcut(event);
  else if (activeTab === 'music') handled = musicPanel.shortcut(event);
  else handled = false;
  if (handled) event.preventDefault();
});

status.info('PixelJS Studio 0.0.4: a new project with the default 16-color palette.');
