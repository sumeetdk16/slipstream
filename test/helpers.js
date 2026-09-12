import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ext = path.join(root, 'extension');

export function readSource(relative) {
  return fs.readFileSync(path.join(ext, relative), 'utf8');
}

/** Loads the classic content scripts into a fresh jsdom window. */
export function loadContentScripts(html, { url = 'https://chatgpt.com/c/abc123', scripts = [] } = {}) {
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, runScripts: 'dangerously' });
  const { window } = dom;
  // jsdom has no layout, so innerText does not exist. The adapters already fall
  // back to textContent; the limit watcher reads innerText directly, so shim it.
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() {
      return this.textContent;
    }
  });
  for (const file of ['src/shared/platforms.js', 'src/shared/logos.js', 'src/content/adapters.js', ...scripts]) {
    window.eval(readSource(file));
  }
  return window;
}

/** Loads a service-worker-side module (platforms/prompts/groq) into Node. */
export function loadWorkerModule(relative) {
  const scope = { self: {}, globalThis: {} };
  scope.self.self = scope.self;
  const fn = new Function('self', 'globalThis', readSource(relative));
  fn(scope.self, scope.self);
  return scope.self;
}

/**
 * Loads the service worker into Node behind a fake `chrome`, and returns a
 * `send(type, payload, sender)` that goes through the real onMessage router —
 * the path the popup, the options page and every content script actually take.
 */
export function loadServiceWorker({ storage = {}, tabs = [] } = {}) {
  const scope = { self: null };
  const listeners = { message: [], installed: [], command: [], updated: [] };
  const sent = [];

  const chrome = {
    runtime: {
      id: 'slipstream-test-id',
      getManifest: () => ({ version: '1.0.0' }),
      getURL: (p) => 'chrome-extension://slipstream-test-id/' + p,
      openOptionsPage: async () => {},
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) }
    },
    storage: {
      local: {
        async get(key) {
          if (key == null) return { ...storage };
          const keys = Array.isArray(key) ? key : [key];
          const out = {};
          for (const k of keys) if (k in storage) out[k] = storage[k];
          return out;
        },
        async set(obj) {
          Object.assign(storage, obj);
        }
      }
    },
    tabs: {
      async query() {
        return tabs;
      },
      async update() {},
      async create(opts) {
        return { id: 99, ...opts };
      },
      async sendMessage(tabId, msg) {
        sent.push({ tabId, msg });
      },
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) }
    },
    windows: { async update() {} },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {}
    },
    commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } }
  };

  const sw = { chrome, crypto: { randomUUID: () => 'id-' + Math.random().toString(36).slice(2) } };
  sw.self = sw;
  sw.globalThis = sw;
  sw.importScripts = (...files) => {
    for (const f of files) {
      new Function('self', 'globalThis', 'chrome', readSource(f.replace(/^\//, '')))(sw, sw, chrome);
    }
  };
  scope.self = sw;

  // The worker body references the imported globals bare (SlipstreamGroq, …),
  // so run importScripts first and then inject whatever it defined by name.
  const source = readSource('src/background/service-worker.js');
  const importLine = source.match(/^importScripts\(([^)]*)\);/m);
  if (importLine) {
    sw.importScripts(...importLine[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  }
  const names = Object.keys(sw).filter((k) => /^(Slipstream|SLIPSTREAM|slipstream)/.test(k));
  new Function(
    'self',
    'globalThis',
    'chrome',
    'crypto',
    'importScripts',
    ...names,
    source.replace(/^importScripts\([^)]*\);/m, '')
  )(sw, sw, chrome, sw.crypto, () => {}, ...names.map((n) => sw[n]));

  function send(type, payload = {}, sender = {}) {
    const fullSender = { id: chrome.runtime.id, ...sender };
    return new Promise((resolve) => {
      const handled = listeners.message[0]({ type, payload }, fullSender, resolve);
      if (!handled) return;
    });
  }

  return { send, storage, sent, scope: sw };
}
