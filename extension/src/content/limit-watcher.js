/**
 * Slipstream — usage-limit watcher.
 *
 * Scanning the whole document on every mutation is far too expensive on a long
 * thread, so we only read the regions where these products actually render a
 * limit notice: live regions, alert/status roles, nodes that name a limit, and
 * the block wrapping the composer.
 */
/* global SlipstreamAdapters */
(function (root) {
  'use strict';

  const CANDIDATE_SELECTORS = [
    '[role="alert"]',
    '[role="status"]',
    '[aria-live="polite"]',
    '[aria-live="assertive"]',
    '[class*="limit" i]',
    '[data-testid*="limit" i]',
    '[class*="rate-limit" i]',
    '[class*="upsell" i]'
  ].join(', ');

  const SCAN_INTERVAL_MS = 2500;
  /**
   * A scan reads innerText off live nodes, which forces layout. On a page that
   * is not changing near any candidate region, repeating that every 2.5s for
   * as long as the tab is open is pure heat, so consecutive identical scans
   * back the interval off to this multiple of it.
   */
  const MAX_IDLE_BACKOFF = 8;
  const MAX_REGION_CHARS = 600;

  function composerRegion() {
    const composer = SlipstreamAdapters.getComposer();
    if (!composer) return null;
    // Two levels up is reliably the form/toolbar wrapper without dragging in
    // the entire message list.
    return composer.closest('form') || composer.parentElement?.parentElement || null;
  }

  function regionsToScan() {
    const nodes = new Set(document.querySelectorAll(CANDIDATE_SELECTORS));
    const region = composerRegion();
    if (region) nodes.add(region);
    return Array.from(nodes).slice(0, 25);
  }

  function scanText() {
    return regionsToScan()
      .map((n) => (n.innerText || '').slice(0, MAX_REGION_CHARS))
      .join('\n')
      .toLowerCase();
  }

  function createWatcher({ platform, onDetect, onClear }) {
    const patterns = (platform.limitPatterns || []).map((p) => p.toLowerCase());
    let active = false;
    let lastScan = 0;
    let timer = null;
    let observer = null;
    let lastHaystack = null;
    let idleRounds = 0;

    function evaluate() {
      lastScan = Date.now();
      const haystack = scanText();
      idleRounds = haystack === lastHaystack ? Math.min(MAX_IDLE_BACKOFF, idleRounds + 1) : 0;
      lastHaystack = haystack;
      const hit = patterns.find((p) => haystack.includes(p));

      if (hit && !active) {
        active = true;
        onDetect({ phrase: hit });
      } else if (!hit && active) {
        active = false;
        onClear?.();
      }
    }

    function schedule() {
      if (timer) return;
      const interval = SCAN_INTERVAL_MS * (1 + idleRounds);
      const wait = Math.max(0, interval - (Date.now() - lastScan));
      timer = setTimeout(() => {
        timer = null;
        // A background tab cannot be showing the user a limit notice; scanning
        // one only costs layout. Re-arm and look when it comes back.
        if (document.hidden) return schedule();
        evaluate();
      }, wait);
    }

    function start() {
      if (observer) return;
      observer = new MutationObserver(() => {
        if (document.hidden) return;
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
          // Coming back to the tab is the one moment worth a prompt look.
          idleRounds = 0;
          schedule();
        }
      });
      schedule();
    }

    function stop() {
      observer?.disconnect();
      observer = null;
      clearTimeout(timer);
      timer = null;
    }

    return { start, stop, evaluate, isActive: () => active };
  }

  root.SlipstreamLimitWatcher = { createWatcher };
})(window);
