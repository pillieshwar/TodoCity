import { useEffect } from "react";
import { tipPlace } from "../lib/motion";

/** How long the first tooltip waits; after one shows, the next come at once for a moment. */
const FIRST_DELAY = 550;
const WARM_FOR = 900;

/**
 * Tooltips that behave like the Mac's: the first one waits a moment, then
 * moving along a toolbar shows the next ones at once. They read the
 * `title` attributes already on buttons (taken off while hovered, so the
 * browser's own tooltip doesn't show too, and put back after).
 */
export function TitleTips() {
  useEffect(() => {
    let owner: HTMLElement | null = null;
    let tip: HTMLDivElement | null = null;
    let timer = 0;
    let warmUntil = 0;

    const restore = () => {
      if (owner && owner.dataset.tip !== undefined) {
        // Put the title back unless the app changed it meanwhile.
        if (!owner.hasAttribute("title")) owner.setAttribute("title", owner.dataset.tip);
        delete owner.dataset.tip;
        if (owner.dataset.tipLabel !== undefined) {
          owner.removeAttribute("aria-label");
          delete owner.dataset.tipLabel;
        }
      }
    };
    const hide = (warm: boolean) => {
      window.clearTimeout(timer);
      if (tip) {
        tip.remove();
        tip = null;
        if (warm) warmUntil = Date.now() + WARM_FOR;
      }
      restore();
      owner = null;
    };
    const show = (el: HTMLElement, text: string) => {
      if (!el.isConnected) return;
      tip = document.createElement("div");
      tip.className = "tt";
      tip.setAttribute("role", "tooltip");
      tip.textContent = text;
      document.body.appendChild(tip);
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const at = tipPlace(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: t.width, height: t.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      tip.style.left = `${at.left}px`;
      tip.style.top = `${at.top}px`;
      if (at.above) tip.classList.add("above");
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title]");
      if (!el || el === owner) return;
      // Fields keep the browser's own behaviour.
      if (el.matches("input, textarea, select, iframe, [contenteditable='true']")) return;
      const text = el.getAttribute("title")?.trim();
      if (!text) return;
      const warm = Date.now() < warmUntil || !!tip;
      hide(false);
      owner = el;
      el.dataset.tip = el.getAttribute("title") ?? "";
      // A button named only by its title keeps its name while the tooltip has it.
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", text);
        el.dataset.tipLabel = "";
      }
      el.removeAttribute("title");
      timer = window.setTimeout(() => show(el, text), warm ? 0 : FIRST_DELAY);
    };
    const out = (e: MouseEvent) => {
      if (!owner) return;
      const to = e.relatedTarget as Node | null;
      if (to && owner.contains(to)) return;
      hide(true);
    };
    const away = () => hide(false);
    document.addEventListener("mouseover", over, true);
    document.addEventListener("mouseout", out, true);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", away, true);
    document.addEventListener("wheel", away, { capture: true, passive: true });
    window.addEventListener("blur", away);
    return () => {
      hide(false);
      document.removeEventListener("mouseover", over, true);
      document.removeEventListener("mouseout", out, true);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", away, true);
      document.removeEventListener("wheel", away, true);
      window.removeEventListener("blur", away);
    };
  }, []);
  return null;
}
