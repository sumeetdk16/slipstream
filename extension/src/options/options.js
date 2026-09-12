/**
 * Slipstream — settings page.
 */
/* global SLIPSTREAM_PLATFORM_LIST, slipstreamLogo */
(function () {
  'use strict';

  const MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M2 17h20" stroke="#3a3a3a" stroke-width="2.4" stroke-linecap="butt"/>
    <path d="M2 17h4.6l7-10H22" stroke="#ffffff" stroke-width="3.4" stroke-linecap="butt" stroke-linejoin="miter"/></svg>`;

  const $ = (id) => document.getElementById(id);

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res?.ok) return reject(new Error(res?.error || 'Request failed'));
        resolve(res.data);
      });
    });
  }

  function status(el, text, kind) {
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function renderPlatforms() {
    const wrap = $('platforms');
    for (const p of SLIPSTREAM_PLATFORM_LIST) {
      const item = document.createElement('div');
      item.className = 'pitem';
      item.style.setProperty('--tint', p.color);
      item.innerHTML = `<span class="logo">${slipstreamLogo(p.id, { size: 18 })}</span>
        <span><span class="pn"></span> <span class="pv"></span></span>
        <span class="host"></span>`;
      item.querySelector('.pn').textContent = p.name;
      item.querySelector('.pv').textContent = p.vendor;
      item.querySelector('.host').textContent = p.hosts[0];
      wrap.appendChild(item);
    }
  }

  async function renderShortcuts() {
    const commands = await chrome.commands.getAll();
    const map = { 'toggle-widget': 'k-toggle', 'capture-context': 'k-capture' };
    for (const cmd of commands) {
      const el = $(map[cmd.name]);
      if (el) el.textContent = cmd.shortcut || 'unassigned';
    }
  }

  function bindToggle(id, settings) {
    const input = $(id);
    input.checked = settings[id] !== false;
    input.addEventListener('change', () => {
      send('SET_SETTINGS', { patch: { [id]: input.checked } }).catch(() => {
        input.checked = !input.checked;
      });
    });
  }

  async function refreshCount() {
    const contexts = await send('LIST_CONTEXTS');
    $('ctx-count').querySelector('span:last-child').textContent =
      `${contexts.length} saved thread${contexts.length === 1 ? '' : 's'}`;
    $('ctx-count').classList.toggle('ok', contexts.length > 0);
    return contexts;
  }

  async function init() {
    $('mark').innerHTML = MARK;
    $('version').textContent = 'v' + chrome.runtime.getManifest().version;
    if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;

    renderPlatforms();
    renderShortcuts().catch(() => {});

    const keyStatus = $('key-status');

    $('reveal').addEventListener('click', () => {
      const input = $('apiKey');
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      $('reveal').textContent = hidden ? 'Hide' : 'Show';
    });

    // Both buttons are latched while their request is in flight: a Groq call
    // can take the full 25s timeout, and an un-latched button just invites the
    // user to stack five more of them on top of the one they are waiting for.
    function latch(button, label) {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = label;
      return () => {
        button.disabled = false;
        button.textContent = original;
      };
    }

    $('save').addEventListener('click', async () => {
      const release = latch($('save'), 'Saving…');
      const patch = { groqApiKey: $('apiKey').value.trim(), model: $('model').value };
      try {
        await send('SET_SETTINGS', { patch });
        status(keyStatus, patch.groqApiKey ? 'Key saved.' : 'Saved. Running without a key.', 'ok');
      } catch (err) {
        status(keyStatus, err.message, 'err');
      } finally {
        release();
      }
    });

    $('model').addEventListener('change', () => {
      send('SET_SETTINGS', { patch: { model: $('model').value } }).catch(() => {});
    });

    $('verify').addEventListener('click', async () => {
      const apiKey = $('apiKey').value.trim();
      if (!apiKey) return status(keyStatus, 'Enter a key first.', 'err');
      if (!/^gsk_/.test(apiKey)) {
        // The commonest mistake this field sees: an xAI *Grok* key pasted into
        // the *Groq* field. Say so before spending 25s on a certain 401.
        status(keyStatus, 'That does not look like a Groq key — they start with gsk_ and come from console.groq.com. An xAI (Grok) key will not work here.', 'err');
        return;
      }
      const release = latch($('verify'), 'Testing…');
      status(keyStatus, 'Testing…');
      try {
        await send('VERIFY_KEY', { apiKey });
        await send('SET_SETTINGS', { patch: { groqApiKey: apiKey, model: $('model').value } });
        status(keyStatus, 'Connected. Key saved.', 'ok');
      } catch (err) {
        status(keyStatus, err.message, 'err');
      } finally {
        release();
      }
    });

    const dataStatus = $('data-status');

    $('export').addEventListener('click', async () => {
      const list = await send('LIST_CONTEXTS');
      const full = await Promise.all(list.map((c) => send('GET_CONTEXT', { id: c.id })));
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), contexts: full }, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `slipstream-threads-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      status(dataStatus, `Exported ${full.length} thread${full.length === 1 ? '' : 's'}.`, 'ok');
    });

    $('clear').addEventListener('click', async () => {
      await send('CLEAR_CONTEXTS');
      await refreshCount();
      status(dataStatus, 'All saved threads deleted.', 'ok');
    });

    // Loaded last and defensively: a settings read that fails must leave the
    // page usable, not strand it with none of the controls above wired up.
    try {
      const settings = await send('GET_SETTINGS');
      $('apiKey').value = settings.groqApiKey || '';
      $('model').value = settings.model;
      ['widgetEnabled', 'autoCapture', 'limitAlerts', 'autoFillTarget'].forEach((id) =>
        bindToggle(id, settings)
      );
    } catch (err) {
      status(keyStatus, err.message, 'err');
    }

    await refreshCount();
  }

  init().catch((err) => status($('key-status'), err.message, 'err'));
})();
