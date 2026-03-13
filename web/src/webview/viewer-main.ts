/**
 * Web Viewer Main Controller
 *
 * Adapted from chrome/src/webview/viewer-main.ts for a static web deployment.
 * Removed: Chrome runtime, file tracking, DOCX export, background messaging.
 * Added:   Markdown input textarea, drag-and-drop .md files, ?url= parameter.
 */

// DocxExporter is required by ToolbarManagerOptions; export is available but secondary in web version
import DocxExporter from '../../../src/exporters/docx-exporter';
import Localization from '../../../src/utils/localization';
import themeManager from '../../../src/utils/theme-manager';
import { loadAndApplyTheme } from '../../../src/utils/theme-to-css';

import type { PluginRenderer, RendererThemeConfig, PlatformAPI } from '../../../src/types/index';
import type { AsyncTaskManager } from '../../../src/core/markdown-processor';
import type { ScrollSyncController } from '../../../src/core/line-based-scroll';
import { escapeHtml } from '../../../src/core/markdown-processor';
import type { FileState } from '../../../src/types/core';

import { updateProgress, showProcessingIndicator, hideProcessingIndicator } from './ui/progress-indicator';
import { createTocManager } from './ui/toc-manager';
import { createToolbarManager, generateToolbarHTML, layoutIcons } from './ui/toolbar';

import {
  createViewerScrollSync,
  setCurrentFileKey,
  renderMarkdownFlow,
  handleThemeSwitchFlow,
} from '../../../src/core/viewer/viewer-host';

// ============================================================================
// Types
// ============================================================================

interface LayoutConfig {
  maxWidth: string;
  icon: string;
  title: string;
}

interface LayoutTitles { normal: string; fullscreen: string; narrow: string }
interface LayoutConfigs { normal: LayoutConfig; fullscreen: LayoutConfig; narrow: LayoutConfig }

interface ThemeConfigurable {
  setThemeConfig(config: RendererThemeConfig): void;
}

export interface ViewerMainOptions {
  platform: PlatformAPI;
  pluginRenderer: PluginRenderer;
  themeConfigRenderer?: ThemeConfigurable;
}

// ============================================================================
// Helpers
// ============================================================================

/** Stable key for storing per-"file" state in the web version. */
function getFileKey(): string {
  return window.location.href.split('#')[0];
}

// ============================================================================
// Main
// ============================================================================

export async function initializeViewerMain(options: ViewerMainOptions): Promise<void> {
  const { platform, pluginRenderer } = options;

  const translate = (key: string, substitutions?: string | string[]): string =>
    Localization.translate(key, substitutions);

  // Provide a DocxExporter so ToolbarManager has something to reference
  const docxExporter = new DocxExporter(pluginRenderer);

  const currentUrl = getFileKey();
  setCurrentFileKey(currentUrl);

  const saveFileState = (state: FileState): void => { platform.fileState.set(currentUrl, state); };
  const getFileState = (): Promise<FileState> => platform.fileState.get(currentUrl);

  let scrollSyncController: ScrollSyncController | null = null;
  let currentTaskManager: AsyncTaskManager | null = null;
  let currentThemeId: string | null = null;
  let currentMarkdown = '';

  function initScrollSyncController(): void {
    try {
      scrollSyncController = createViewerScrollSync({
        containerId: 'markdown-content',
        platform,
      });
      scrollSyncController.start();
    } catch (error) {
      console.warn('[Web] Failed to init scroll sync:', error);
    }
  }

  // -- Initial State --------------------------------------------------------

  const initialState = await getFileState();

  const layoutTitles: LayoutTitles = {
    normal: translate('toolbar_layout_title_normal'),
    fullscreen: translate('toolbar_layout_title_fullscreen'),
    narrow: translate('toolbar_layout_title_narrow'),
  };

  const layoutConfigs: LayoutConfigs = {
    normal:     { maxWidth: '1360px', icon: layoutIcons.normal,     title: layoutTitles.normal },
    fullscreen: { maxWidth: '100%',   icon: layoutIcons.fullscreen, title: layoutTitles.fullscreen },
    narrow:     { maxWidth: '680px',  icon: layoutIcons.narrow,     title: layoutTitles.narrow },
  };

  type LayoutMode = keyof LayoutConfigs;
  const initialLayout: LayoutMode =
    initialState.layoutMode && layoutConfigs[initialState.layoutMode as LayoutMode]
      ? (initialState.layoutMode as LayoutMode)
      : 'normal';
  const initialMaxWidth = layoutConfigs[initialLayout].maxWidth;
  const initialZoom = initialState.zoom || 100;

  let initialTocVisible: boolean;
  if (initialState.tocVisible !== undefined) {
    initialTocVisible = initialState.tocVisible;
  } else {
    initialTocVisible = window.innerWidth > 1024;
  }
  const initialTocClass = initialTocVisible ? '' : ' hidden';

  const toolbarPrintDisabledTitle = translate('toolbar_print_disabled_title');

  // -- TOC ------------------------------------------------------------------

  const tocManager = createTocManager(saveFileState, getFileState);
  const { generateTOC, setupTocToggle, updateActiveTocItem, setupResponsiveToc } = tocManager;

  // -- Toolbar --------------------------------------------------------------

  const toolbarManager = createToolbarManager({
    translate,
    escapeHtml,
    saveFileState,
    getFileState,
    rawMarkdown: '',
    docxExporter,
    cancelScrollRestore: () => {},
    updateActiveTocItem,
    toolbarPrintDisabledTitle,
    onBeforeZoom: () => {},
  });

  toolbarManager.setInitialZoom(initialZoom);

  // -- DOM Layout -----------------------------------------------------------

  document.body.innerHTML = generateToolbarHTML({
    translate,
    escapeHtml,
    initialTocClass,
    initialMaxWidth,
    initialZoom,
  });

  if (!initialTocVisible) {
    document.body.classList.add('toc-hidden');
  }

  // Inject the web-specific input area AFTER the toolbar HTML
  const wrapper = document.getElementById('markdown-wrapper');
  if (wrapper) {
    const inputArea = document.createElement('div');
    inputArea.id = 'web-input-area';
    inputArea.innerHTML = `
      <div id="web-welcome">
        <h2>${escapeHtml(translate('appName') || 'Markdown Viewer')}</h2>
        <p>${escapeHtml(translate('web_welcome_subtitle') || 'Paste, type, or drop a .md file to preview')}</p>
        <textarea id="md-input" placeholder="${escapeHtml(translate('web_input_placeholder') || 'Enter Markdown here…')}" spellcheck="false"></textarea>
        <div id="web-actions">
          <button id="render-btn" class="web-btn">${escapeHtml(translate('web_render_button') || 'Render')}</button>
        </div>
      </div>
    `;
    wrapper.insertBefore(inputArea, wrapper.firstChild);
  }

  // Add a drag-and-drop overlay
  const overlay = document.createElement('div');
  overlay.id = 'drop-overlay';
  overlay.className = 'hidden';
  overlay.innerHTML = `<div class="drop-overlay-inner">${escapeHtml(translate('web_drop_hint') || 'Drop .md file here')}</div>`;
  document.body.appendChild(overlay);

  // Add an "Edit" toolbar button (reuse toolbar-right area)
  const toolbarRight = document.querySelector('.toolbar-right');
  if (toolbarRight) {
    const editBtn = document.createElement('button');
    editBtn.id = 'edit-btn';
    editBtn.className = 'toolbar-btn';
    editBtn.title = translate('web_edit_button') || 'Edit';
    editBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 4L16 9L7 18H2V13Z"/>
      <line x1="9" y1="6" x2="14" y2="11"/>
    </svg>`;
    toolbarRight.insertBefore(editBtn, toolbarRight.firstChild);
  }

  // Make body visible
  document.body.style.opacity = '1';
  document.body.style.overflow = '';
  document.body.style.transition = 'opacity 0.15s ease-in';

  // -- Scroll sync ----------------------------------------------------------

  initScrollSyncController();

  // -- Theme ----------------------------------------------------------------

  try {
    currentThemeId = await themeManager.loadSelectedTheme();
    await loadAndApplyTheme(currentThemeId);
  } catch (error) {
    console.error('Failed to load theme at init:', error);
  }

  // -- Render function ------------------------------------------------------

  async function renderMarkdown(markdown: string, savedScrollLine = 0, forceRender?: boolean): Promise<void> {
    const container = document.getElementById('markdown-content') as HTMLElement | null;
    if (!container) return;

    currentMarkdown = markdown;

    await renderMarkdownFlow({
      markdown,
      container,
      fileChanged: true,
      forceRender: forceRender ?? false,
      zoomLevel: toolbarManager.getZoomLevel() / 100,
      scrollController: scrollSyncController,
      renderer: pluginRenderer,
      translate,
      platform,
      currentTaskManagerRef: { current: currentTaskManager },
      targetLine: savedScrollLine,
      onHeadings: () => { void generateTOC(); },
      onProgress: (completed, total) => { updateProgress(completed, total); },
      beforeProcessAll: showProcessingIndicator,
      afterProcessAll: hideProcessingIndicator,
      afterRender: updateActiveTocItem,
    });
  }

  async function handleSetTheme(themeId: string): Promise<void> {
    if (themeId === currentThemeId) return;
    currentThemeId = themeId;
    try {
      await handleThemeSwitchFlow({
        themeId,
        scrollController: scrollSyncController,
        applyTheme: loadAndApplyTheme,
        saveTheme: (id) => themeManager.saveSelectedTheme(id),
        rerender: async (scrollLine) => {
          await renderMarkdown(currentMarkdown, scrollLine, true);
        },
      });
    } catch (error) {
      console.error('[Web] Theme change failed:', error);
    }
  }

  // -- Render from input ----------------------------------------------------

  function showInput(): void {
    const area = document.getElementById('web-input-area');
    if (area) area.classList.remove('hidden');
    const mdInput = document.getElementById('md-input') as HTMLTextAreaElement | null;
    if (mdInput) {
      mdInput.value = currentMarkdown;
      mdInput.focus();
    }
  }

  function hideInput(): void {
    const area = document.getElementById('web-input-area');
    if (area) area.classList.add('hidden');
  }

  async function renderFromInput(): Promise<void> {
    const mdInput = document.getElementById('md-input') as HTMLTextAreaElement | null;
    const md = mdInput?.value ?? '';
    if (!md.trim()) return;
    hideInput();
    await renderMarkdown(md, 0, true);
  }

  // -- Startup --------------------------------------------------------------

  setTimeout(async () => {
    toolbarManager.initializeToolbar();
    setupTocToggle();
    toolbarManager.setupKeyboardShortcuts();
    await setupResponsiveToc();

    // Check for ?url= parameter
    const params = new URLSearchParams(window.location.search);
    const urlParam = params.get('url');
    if (urlParam) {
      try {
        hideInput();
        const response = await globalThis.fetch(urlParam);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const markdown = await response.text();
        // Set filename in toolbar
        const filenameEl = document.getElementById('file-name');
        if (filenameEl) {
          try {
            const urlObj = new URL(urlParam);
            filenameEl.textContent = decodeURIComponent(urlObj.pathname.split('/').pop() || urlParam);
          } catch {
            filenameEl.textContent = urlParam;
          }
        }
        await renderMarkdown(markdown, 0);
      } catch (error) {
        console.error('[Web] Failed to load URL:', error);
      }
      return;
    }

    // Otherwise show the welcome / input area
  }, 100);

  // -- Event listeners ------------------------------------------------------

  // Render button
  document.getElementById('render-btn')?.addEventListener('click', () => {
    void renderFromInput();
  });

  // Edit button toggles input area
  document.getElementById('edit-btn')?.addEventListener('click', () => {
    const area = document.getElementById('web-input-area');
    if (area?.classList.contains('hidden')) {
      showInput();
    } else {
      void renderFromInput();
    }
  });

  // Ctrl+Enter in textarea triggers render
  document.getElementById('md-input')?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void renderFromInput();
    }
  });

  // Scroll tracking
  let scrollTimeout: ReturnType<typeof setTimeout>;
  window.addEventListener('scroll', () => {
    updateActiveTocItem();
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      const currentLine = scrollSyncController?.getCurrentLine() ?? 0;
      saveFileState({ scrollLine: currentLine });
    }, 300);
  });

  // Drag-and-drop
  let dragCounter = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.remove('hidden');
  });
  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      overlay.classList.add('hidden');
    }
  });
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.add('hidden');

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const SUPPORTED_DROP_EXTENSIONS = /\.(md|markdown|txt|mmd|mermaid)$/i;
    if (!SUPPORTED_DROP_EXTENSIONS.test(file.name)) return;

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;
      const mdInput = document.getElementById('md-input') as HTMLTextAreaElement | null;
      if (mdInput) mdInput.value = content;

      // Set filename in toolbar
      const filenameEl = document.getElementById('file-name');
      if (filenameEl) filenameEl.textContent = file.name;

      hideInput();
      void renderMarkdown(content, 0, true);
    };
    reader.readAsText(file);
  });
}

// ============================================================================
// Public entry
// ============================================================================

export function startViewer(options: ViewerMainOptions): void {
  Localization.init()
    .catch((error) => {
      console.error('Localization init failed:', error);
    })
    .finally(() => {
      void initializeViewerMain(options);
    });
}
