/**
 * Panel styles, injected as one <style> tag.
 *
 * Colours come from DSH's own alias tokens (`--dsw-alias-*`) so the panel
 * follows the host's theme instead of declaring its own, with literal
 * fallbacks for the case where a token is missing. Every class is prefixed
 * `ifp-` — a plugin that leaks a bare `.card` rule into someone else's app is a
 * bug that only shows up in their UI.
 */

export const STYLES = `
.ifp-root { padding: 4px 0 32px; font-family: var(--dsw-font-family, inherit); color: var(--dsw-alias-label-primary, inherit); }
.ifp-head { margin-bottom: 20px; }
.ifp-head h2 { font-size: 18px; margin: 0 0 6px; font-weight: 650; }
.ifp-head p { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary, #6b7280); line-height: 1.6; }

.ifp-card {
  border: 1px solid var(--dsw-alias-border-l1, #e3e6ea);
  background: var(--dsw-alias-bg-overlay, #fff);
  border-radius: 10px; padding: 16px 18px; margin-bottom: 12px;
}
.ifp-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ifp-card h3 { font-size: 14px; margin: 0; font-weight: 600; }
.ifp-card p { margin: 0; font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #6b7280); }
.ifp-card p + p { margin-top: 8px; }

.ifp-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--dsw-alias-label-tertiary, #9aa3ad); }
.ifp-dot.on { background: #1a7f4b; }
.ifp-dot.warn { background: #b26a00; }
.ifp-dot.off { background: var(--dsw-alias-label-tertiary, #9aa3ad); }

.ifp-metric { font-size: 26px; font-weight: 600; letter-spacing: -0.5px; }
.ifp-metric small { font-size: 13px; font-weight: 400; color: var(--dsw-alias-label-secondary, #6b7280); margin-left: 8px; }

.ifp-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.ifp-actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }

.ifp-btn {
  border: 1px solid var(--dsw-alias-border-l1, #e3e6ea); border-radius: 8px;
  padding: 8px 16px; font-size: 13px; font-weight: 550; cursor: pointer;
  background: var(--dsw-alias-bg-overlay, #fff); color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit;
}
.ifp-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.04)); }
.ifp-btn:disabled { opacity: .5; cursor: default; }
.ifp-btn.primary { background: #2f6df6; border-color: #2f6df6; color: #fff; }
.ifp-btn.primary:hover:not(:disabled) { filter: brightness(1.08); background: #2f6df6; }
.ifp-btn.danger { color: #b3261e; }

.ifp-consent { border-color: #2f6df6; }
.ifp-consent h3 { margin-bottom: 12px; }
.ifp-list { margin: 0 0 14px; padding: 0; list-style: none; font-size: 13px; line-height: 1.6; }
.ifp-list li { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #eef0f3); }
.ifp-list li:last-child { border-bottom: 0; }
.ifp-tag { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; height: fit-content; line-height: 1.6; }
.ifp-tag.up { background: rgba(47,109,246,.12); color: #2f6df6; }
.ifp-tag.hidden { background: rgba(178,106,0,.14); color: #b26a00; }
.ifp-tag.never { background: rgba(26,127,75,.14); color: #1a7f4b; }

.ifp-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 30px; letter-spacing: 4px; font-weight: 600; text-align: center;
  padding: 18px 12px; margin: 12px 0;
  border: 1px dashed var(--dsw-alias-border-l1, #e3e6ea); border-radius: 10px;
  background: var(--dsw-alias-bg-base, rgba(0,0,0,.02));
  user-select: all;
}
.ifp-muted { font-size: 12px; color: var(--dsw-alias-label-tertiary, #9aa3ad); }
.ifp-error { font-size: 13px; color: #b3261e; margin-top: 10px; }
.ifp-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }

.ifp-posture { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 10px; }
.ifp-posture div { font-size: 12px; }
.ifp-posture b { display: block; font-weight: 550; font-size: 13px; margin-bottom: 2px; }
/* The sidebar button and the overlay it opens. */
.ifp-launcher {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 10px; border: 0; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  font-family: inherit; font-size: 13px; text-align: left;
}
.ifp-launcher:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.ifp-launcher.narrow { justify-content: center; padding: 7px 4px; }
.ifp-launcher-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ifp-scrim {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(15, 17, 21, .38);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 48px 24px; overflow-y: auto;
}
.ifp-sheet {
  position: relative; width: 100%; max-width: 640px;
  background: var(--dsw-alias-bg-base, #fff);
  border: 1px solid var(--dsw-alias-border-l1, #e3e6ea);
  border-radius: 14px; padding: 24px 26px 20px;
  box-shadow: 0 24px 60px rgba(0,0,0,.22);
}
.ifp-close {
  position: absolute; top: 12px; right: 14px;
  border: 0; background: transparent; cursor: pointer;
  font-size: 22px; line-height: 1; padding: 4px 8px; border-radius: 6px;
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.ifp-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06)); }

`

let injected = false

export function insertStyles() {
  if (injected) return () => {}
  const tag = document.createElement('style')
  tag.dataset.iflowPanel = 'true'
  tag.textContent = STYLES
  document.head.appendChild(tag)
  injected = true
  return () => {
    tag.remove()
    injected = false
  }
}
