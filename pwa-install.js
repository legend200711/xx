/**
 * Shadow Fire Live — PWA Install Manager  (pwa-install.js)
 *
 * Handles:
 *  - Capturing the `beforeinstallprompt` event
 *  - Showing / hiding install banners and buttons
 *  - iOS/iPadOS "Add to Home Screen" instructions
 *  - Service-worker update notifications
 *  - Detecting when the app is already installed (standalone mode)
 *
 * Usage: include this script on any SFL page.
 * It exposes `window._SFLInstall` so any page can call the prompt.
 */

'use strict';

(() => {
  /* ── Already running as installed PWA? ── */
  const IS_STANDALONE =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const IS_IOS =
    /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !window.MSStream;

  const IS_ANDROID =
    /android/i.test(navigator.userAgent);

  /* ── Deferred install prompt (Chrome/Edge/Android) ── */
  let _deferredPrompt = null;
  let _promptListeners = [];

  /* ── Register service worker ── */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/xx/sw.js', { scope: '/xx/' })
      .then(reg => {
        /* Check for waiting SW on first load */
        if (reg.waiting) _notifyUpdate();

        /* Future updates */
        reg.addEventListener('updatefound', () => {
          const incoming = reg.installing;
          if (!incoming) return;
          incoming.addEventListener('statechange', () => {
            if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
              _notifyUpdate();
            }
          });
        });
      })
      .catch(() => {});

    /* SW updated and claimed new clients */
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'SW_UPDATED') {
        /* Only show toast; do NOT reload automatically to avoid disrupting the user */
        _showUpdateToast();
      }
    });

    /* When a new SW takes over, reload to pick up fresh resources */
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });
  }

  function _notifyUpdate() {
    /* Automatically apply the update by asking the waiting SW to skip waiting */
    navigator.serviceWorker.ready.then(reg => {
      if (reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
    });
  }

  function _showUpdateToast() {
    const toast = document.getElementById('sfl-toast') || document.getElementById('liveToast');
    if (!toast) return;
    toast.textContent = '🔥 Shadow Fire Live updated. Refreshing…';
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 3000);
  }

  /* ── Capture install prompt ── */
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredPrompt = e;
    _promptListeners.forEach(fn => fn());
    _promptListeners = [];
    /* Reveal any install buttons that are present */
    document.querySelectorAll('[data-pwa-install]').forEach(el => {
      el.style.removeProperty('display');
      el.classList.remove('sfl-hidden');
    });
  });

  /* After successful install, hide install buttons */
  window.addEventListener('appinstalled', () => {
    _deferredPrompt = null;
    document.querySelectorAll('[data-pwa-install]').forEach(el => {
      el.style.display = 'none';
    });
    const toast = document.getElementById('sfl-toast') || document.getElementById('liveToast');
    if (toast) {
      toast.textContent = '🎉 Shadow Fire Live installed!';
      toast.classList.add('visible');
      setTimeout(() => toast.classList.remove('visible'), 3500);
    }
  });

  /**
   * Show the browser-native install prompt (Android/Chrome/Edge).
   * Returns a promise that resolves to 'accepted' | 'dismissed' | 'unavailable'.
   */
  async function triggerInstall() {
    if (_deferredPrompt) {
      _deferredPrompt.prompt();
      const { outcome } = await _deferredPrompt.userChoice;
      _deferredPrompt = null;
      return outcome;
    }
    /* No native prompt — show instructions */
    showInstallInstructions();
    return 'unavailable';
  }

  /**
   * Show platform-appropriate install instructions in a modal.
   */
  function showInstallInstructions() {
    /* Remove any existing modal */
    document.getElementById('_sflInstallModal')?.remove();

    const isIOS = IS_IOS;
    const modal = document.createElement('div');
    modal.id = '_sflInstallModal';
    modal.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:9999',
      'background:rgba(0,0,0,0.78)',
      'display:flex', 'align-items:flex-end', 'justify-content:center',
      'padding:16px',
      'animation:sflFadeIn 0.2s ease',
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
      'background:#0d1f3a',
      'border:1px solid rgba(0,174,239,0.3)',
      'border-radius:20px 20px 16px 16px',
      'width:100%', 'max-width:460px',
      'padding:28px 24px 32px',
      'box-shadow:0 -8px 48px rgba(0,0,0,0.7)',
      'text-align:center',
      'color:#d8eeff',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ].join(';');

    if (isIOS) {
      card.innerHTML = `
        <div style="font-size:38px;margin-bottom:12px;">🔥</div>
        <div style="font-size:18px;font-weight:800;margin-bottom:8px;letter-spacing:0.5px;">Install Shadow Fire Live</div>
        <div style="font-size:14px;color:#7aaabf;line-height:1.65;margin-bottom:20px;">
          To install on your iPhone or iPad, tap the
          <strong style="color:#00aeef;">Share</strong> button
          <span style="font-size:16px;">⬆️</span> in Safari,
          then choose <strong style="color:#00aeef;">Add to Home Screen</strong>.
        </div>
        <div style="display:flex;gap:10px;flex-direction:column;align-items:center;">
          <div style="background:rgba(0,174,239,0.08);border:1px solid rgba(0,174,239,0.2);border-radius:12px;padding:14px 20px;font-size:13px;color:#a0c8e8;line-height:1.6;text-align:left;width:100%;max-width:300px;">
            <div style="margin-bottom:6px;">1. Tap <strong style="color:#00aeef;">⬆️ Share</strong> in Safari's toolbar</div>
            <div style="margin-bottom:6px;">2. Scroll down and tap <strong style="color:#00aeef;">Add to Home Screen</strong></div>
            <div>3. Tap <strong style="color:#00aeef;">Add</strong> to confirm</div>
          </div>
          <button id="_sflInstallClose" style="
            margin-top:8px;padding:12px 32px;
            background:rgba(0,174,239,0.15);
            border:1px solid rgba(0,174,239,0.4);
            border-radius:24px;color:#00aeef;
            font-size:14px;font-weight:700;cursor:pointer;
          ">Got it</button>
        </div>
      `;
    } else {
      card.innerHTML = `
        <div style="font-size:38px;margin-bottom:12px;">🔥</div>
        <div style="font-size:18px;font-weight:800;margin-bottom:8px;letter-spacing:0.5px;">Install Shadow Fire Live</div>
        <div style="font-size:14px;color:#7aaabf;line-height:1.65;margin-bottom:20px;">
          To install from your browser, look for
          <strong style="color:#00aeef;">Install App</strong> or
          <strong style="color:#00aeef;">Add to Home Screen</strong>
          in your browser's menu (⋮ or ⋯).
        </div>
        <button id="_sflInstallClose" style="
          padding:12px 32px;
          background:rgba(0,174,239,0.15);
          border:1px solid rgba(0,174,239,0.4);
          border-radius:24px;color:#00aeef;
          font-size:14px;font-weight:700;cursor:pointer;
        ">Got it</button>
      `;
    }

    modal.appendChild(card);
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.getElementById('_sflInstallClose')?.addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
  }

  /**
   * Inject the install banner into the page.
   * Called by pages that want to show the install prompt banner.
   */
  function injectBanner() {
    if (IS_STANDALONE) return; /* already installed */

    const banner = document.createElement('div');
    banner.id = '_sflInstallBanner';
    banner.setAttribute('role', 'banner');
    banner.setAttribute('aria-label', 'Install Shadow Fire Live app');
    banner.style.cssText = [
      'position:fixed', 'bottom:calc(58px + 12px)', 'left:50%',
      'transform:translateX(-50%)',
      'z-index:800',
      'background:linear-gradient(135deg,#061830 0%,#0d2a50 100%)',
      'border:1px solid rgba(0,174,239,0.45)',
      'border-radius:16px',
      'padding:12px 18px 12px 16px',
      'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 4px 32px rgba(0,0,0,0.6),0 0 0 1px rgba(0,174,239,0.1)',
      'max-width:calc(100vw - 32px)',
      'animation:sflSlideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)',
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
    ].join(';');

    banner.innerHTML = `
      <span style="font-size:26px;flex-shrink:0;">🔥</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:700;color:#d8eeff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Shadow Fire Live is ready to install</div>
        <div style="font-size:11px;color:#5a8aaa;margin-top:2px;">Quick access to videos and live streams</div>
      </div>
      <button id="_sflBannerInstall" style="
        flex-shrink:0;padding:8px 16px;
        background:linear-gradient(135deg,#0055cc,#0088ff);
        border:none;border-radius:10px;
        color:#fff;font-size:12px;font-weight:800;
        letter-spacing:0.4px;cursor:pointer;
        white-space:nowrap;
      ">INSTALL</button>
      <button id="_sflBannerClose" style="
        flex-shrink:0;width:26px;height:26px;
        background:rgba(255,255,255,0.08);
        border:1px solid rgba(255,255,255,0.12);
        border-radius:50%;color:#7aaabf;
        font-size:13px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;
      " aria-label="Dismiss">✕</button>
    `;

    document.body.appendChild(banner);

    document.getElementById('_sflBannerInstall')?.addEventListener('click', async () => {
      banner.remove();
      await triggerInstall();
    });
    document.getElementById('_sflBannerClose')?.addEventListener('click', () => {
      banner.remove();
      /* Don't show again this session */
      try { sessionStorage.setItem('sfl_install_dismissed', '1'); } catch (_) {}
    });
  }

  /* Only auto-show banner if not dismissed this session */
  function maybeShowBanner() {
    if (IS_STANDALONE) return;
    try {
      if (sessionStorage.getItem('sfl_install_dismissed')) return;
    } catch (_) {}

    if (_deferredPrompt) {
      injectBanner();
    } else {
      /* Wait for the prompt to be available (may fire after DOMContentLoaded) */
      _promptListeners.push(() => {
        if (!document.getElementById('_sflInstallBanner')) injectBanner();
      });
    }
  }

  /* ── Public API ── */
  window._SFLInstall = {
    triggerInstall,
    showInstallInstructions,
    maybeShowBanner,
    isStandalone: () => IS_STANDALONE,
    isInstallable: () => !!_deferredPrompt,
    isIOS: () => IS_IOS,
    isAndroid: () => IS_ANDROID,
  };

  /* ── Boot ── */
  registerSW();

  /* Show banner after page has settled */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(maybeShowBanner, 2500));
  } else {
    setTimeout(maybeShowBanner, 2500);
  }

})();
