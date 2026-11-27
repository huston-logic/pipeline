// The timer clock, the Time logged note's expiry and the corner's scroll room (decision 0062; split from live.js to
// keep each file under 3 KB gzipped). live.js sends "board:changed" after it changes the page.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  let ticker = null;

  const hm = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  };

  // The corner's height, so a control scrolled into view stops below it (WCAG 2.4.11).
  const room = () => {
    const c = $(".corner");
    if (c) document.documentElement.style.setProperty("--corner-h", `${Math.ceil(c.getBoundingClientRect().height + 8)}px`);
  };

  const tick = () => {
    const now = Date.now();
    const clocks = $$("time[data-since]");
    for (const t of clocks) t.textContent = hm(now - Date.parse(t.dataset.since));
    for (const n of $$("[data-expires]")) {
      if (Date.parse(n.dataset.expires) > now) continue;
      if (n.contains(document.activeElement)) $("main").focus();
      n.parentNode.replaceChildren();
    }
    room();
    return clocks.length > 0 || !!$("[data-expires]");
  };

  const watch = () => {
    if (tick() && !ticker) {
      ticker = setInterval(() => {
        if (!tick()) ticker = clearInterval(ticker);
      }, 15000);
    }
  };

  document.addEventListener("board:changed", watch);
  watch();
})();
