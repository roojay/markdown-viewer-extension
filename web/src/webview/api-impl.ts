/**
 * Web Platform API Implementation
 *
 * Implements the platform interface for a static web (GitHub Pages) environment.
 * Key differences from Chrome:
 * 1. No ServiceChannel – all services are local / in-memory.
 * 2. Cache is an in-memory Map (no IndexedDB via background).
 * 3. Renderer uses IframeRenderHost (like Mobile, not OffscreenRenderHost).
 * 4. Storage is localStorage-based.
 * 5. Resources are loaded from relative paths (not chrome.runtime.getURL).
 */

import {
  BaseI18nService,
  DEFAULT_SETTING_LOCALE,
  FALLBACK_LOCALE,
  RendererService,
  SettingsService,
  createSettingsService,
} from '../../../src/services';

import type { LocaleMessages } from '../../../src/services';
import type {
  CacheService as CacheServiceInterface,
  StorageService as StorageServiceInterface,
  FileService as FileServiceInterface,
  FileStateService as FileStateServiceInterface,
  ResourceService as ResourceServiceInterface,
  MessageService as MessageServiceInterface,
  PlatformAPI,
} from '../../../src/types/platform';
import type { RendererThemeConfig } from '../../../src/types/render';
import type { CacheStats, SimpleCacheStats } from '../../../src/types/cache';
import type { FileState } from '../../../src/types/core';
import type { DownloadOptions } from '../../../src/types/platform';

import { IframeRenderHost } from '../../../src/renderers/host/iframe-render-host';

// ============================================================================
// Web Cache Service – in-memory Map
// ============================================================================

class WebCacheService implements CacheServiceInterface {
  private cache = new Map<string, unknown>();

  // Satisfy the concrete CacheService shape expected by RendererService
  public readonly channel: unknown = null;

  async init(): Promise<void> { /* no-op */ }

  async calculateHash(text: string): Promise<string> {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return hash.toString(36);
  }

  async generateKey(content: string, type: string, themeConfig?: RendererThemeConfig | null): Promise<string> {
    const configStr = themeConfig ? JSON.stringify(themeConfig) : '';
    return this.calculateHash(`${type}:${content}:${configStr}`);
  }

  estimateSize(data: unknown): number {
    return new Blob([typeof data === 'string' ? data : JSON.stringify(data)]).size;
  }

  async get(key: string): Promise<unknown> {
    return this.cache.get(key) ?? null;
  }

  async set(key: string, value: unknown): Promise<boolean> {
    this.cache.set(key, value);
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<boolean> {
    this.cache.clear();
    return true;
  }

  async getStats(): Promise<CacheStats | SimpleCacheStats | null> {
    return null;
  }
}

// ============================================================================
// Web Storage Service – localStorage
// ============================================================================

class WebStorageService implements StorageServiceInterface {
  private prefix = 'mdviewer_';

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const stored = localStorage.getItem(this.prefix + key);
      if (stored !== null) {
        try { result[key] = JSON.parse(stored); } catch { result[key] = stored; }
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
    }
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      localStorage.removeItem(this.prefix + key);
    }
  }
}

// ============================================================================
// Web File Service – download via <a> element
// ============================================================================

class WebFileService implements FileServiceInterface {
  async download(blob: Blob | string, filename: string, _options?: DownloadOptions): Promise<void> {
    const blobObj = typeof blob === 'string'
      ? new Blob([blob], { type: 'text/plain' })
      : blob;
    const url = URL.createObjectURL(blobObj);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
}

// ============================================================================
// Web File State Service – localStorage
// ============================================================================

class WebFileStateService implements FileStateServiceInterface {
  private prefix = 'mdviewer_filestate_';

  async get(url: string): Promise<FileState> {
    const stored = localStorage.getItem(this.prefix + url);
    if (stored) {
      try { return JSON.parse(stored); } catch { /* ignore */ }
    }
    return {};
  }

  set(url: string, state: FileState): void {
    try {
      const existing = localStorage.getItem(this.prefix + url);
      const merged = existing ? { ...JSON.parse(existing), ...state } : state;
      localStorage.setItem(this.prefix + url, JSON.stringify(merged));
    } catch {
      // Storage quota exceeded – silently ignore
    }
  }

  async clear(url: string): Promise<void> {
    localStorage.removeItem(this.prefix + url);
  }
}

// ============================================================================
// Web Resource Service – relative fetch
// ============================================================================

class WebResourceService implements ResourceServiceInterface {
  getURL(path: string): string {
    return `./${path}`;
  }

  async fetch(path: string): Promise<string> {
    const url = this.getURL(path);
    const response = await globalThis.fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.text();
  }
}

// ============================================================================
// Web Message Service – no-op (no background script)
// ============================================================================

class WebMessageService implements MessageServiceInterface {
  async send(_message: Record<string, unknown>): Promise<unknown> {
    return null;
  }
  addListener(_handler: (message: unknown) => void): void {
    // no-op
  }
}

// ============================================================================
// Web I18n Service
// ============================================================================

class WebI18nService extends BaseI18nService {
  private settingsService: SettingsService;
  private resourceService: WebResourceService;

  constructor(settingsService: SettingsService, resourceService: WebResourceService) {
    super();
    this.settingsService = settingsService;
    this.resourceService = resourceService;
  }

  async init(): Promise<void> {
    try {
      await this.ensureFallbackMessages();
      try {
        const preferredLocale = await this.settingsService.get('preferredLocale');
        const locale = preferredLocale || DEFAULT_SETTING_LOCALE;
        if (locale !== DEFAULT_SETTING_LOCALE) {
          await this.loadLocale(locale);
        }
        this.locale = locale;
      } catch {
        this.locale = DEFAULT_SETTING_LOCALE;
      }
    } catch (error) {
      console.warn('[Web I18n] init failed:', error);
    } finally {
      this.ready = Boolean(this.messages || this.fallbackMessages);
    }
  }

  async loadLocale(locale: string): Promise<void> {
    try {
      this.messages = await this.fetchLocaleData(locale);
      this.ready = Boolean(this.messages || this.fallbackMessages);
    } catch (error) {
      console.warn('[Web I18n] Failed to load locale', locale, error);
      this.messages = null;
      this.ready = Boolean(this.fallbackMessages);
    }
  }

  async fetchLocaleData(locale: string): Promise<LocaleMessages | null> {
    try {
      const text = await this.resourceService.fetch(`_locales/${locale}/messages.json`);
      return JSON.parse(text) as LocaleMessages;
    } catch (error) {
      console.warn('[Web I18n] fetchLocaleData failed for', locale, error);
      return null;
    }
  }

  getUILanguage(): string {
    return navigator.language || 'en';
  }
}

// ============================================================================
// Web Platform API
// ============================================================================

export class WebPlatformAPI implements PlatformAPI {
  public readonly platform = 'web' as const;

  public readonly storage: WebStorageService;
  public readonly file: WebFileService;
  public readonly fileState: WebFileStateService;
  public readonly resource: WebResourceService;
  public readonly message: WebMessageService;
  public readonly cache: WebCacheService;
  public readonly renderer: RendererService;
  public readonly i18n: WebI18nService;
  public readonly settings: SettingsService;

  constructor() {
    this.storage = new WebStorageService();
    this.file = new WebFileService();
    this.fileState = new WebFileStateService();
    this.resource = new WebResourceService();
    this.message = new WebMessageService();
    this.cache = new WebCacheService();

    this.settings = createSettingsService(this.storage);

    // Renderer uses IframeRenderHost pointing at the co-located render-worker page
    this.renderer = new RendererService({
      createHost: () => new IframeRenderHost({
        iframeUrl: './render-worker.html',
        source: 'web-renderer',
        timeoutMs: 60_000,
        readyTimeoutMs: 15_000,
        serviceRequestHandler: async (type, payload) => {
          // Proxy FETCH_RESOURCE requests from the render iframe
          if (type === 'FETCH_RESOURCE') {
            const { path } = payload as { path: string };
            return this.resource.fetch(path);
          }
          return null;
        },
      }),
      cache: this.cache as unknown as import('../../../src/services/cache-service').CacheService,
    });

    this.i18n = new WebI18nService(this.settings, this.resource);
  }

  async init(): Promise<void> {
    await this.cache.init();
    await this.i18n.init();
  }
}

// ============================================================================
// Export
// ============================================================================

export const webPlatform = new WebPlatformAPI();

export { DEFAULT_SETTING_LOCALE };
