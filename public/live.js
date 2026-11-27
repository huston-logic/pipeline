// In place (decision 0062): a data-live form posts with fetch and swaps in the [data-region]s of the page it names;
// anything else falls back to the plain post. Also the clock, filters and row forms.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const busy = new WeakSet();
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

  const init = () => {
    for (const h of $$("[data-autosubmit-hide]")) h.hidden = true;
    watch();
  };

  const say = (form, text) => {
    const n = $(".corner-notice");
    if (!n) return form.submit();
    const p = document.createElement("p");
    p.className = "corner-text";
    p.textContent = text;
    n.replaceChildren(p);
    room();
  };

  const key = (u) => {
    const q = new URLSearchParams(u.search);
    q.delete("change");
    return `${u.pathname}?${q}`;
  };

  const adopt = (cur, n) => cur.replaceWith(document.importNode(n, true));

  // The corner's live region keeps its element, so the new text is announced.
  const swapCorner = (cur, n) => {
    const oc = $(".corner-chip", cur);
    const nc = $(".corner-chip", n);
    if (oc && nc) {
      if ($("time", oc).dataset.since !== $("time", nc).dataset.since) adopt(oc, nc);
    } else if (oc) oc.remove();
    else if (nc) cur.prepend(document.importNode(nc, true));
    const on = $(".corner-notice", cur);
    on.replaceChildren(...Array.from($(".corner-notice", n).childNodes, (c) => document.importNode(c, true)));
  };

  const swap = (doc, form, who) => {
    // The disclosure a form (not a filter) sat in closes; the others stay as they were.
    const auto = form.matches("[data-autosubmit]");
    const open = $$("details[id][open]").filter((d) => auto || !d.contains(form)).map((d) => d.id);
    const { scrollX, scrollY } = window;
    const was = (who && who.id) || form.id;
    const next = $$("[data-region]", doc);
    for (const cur of $$("[data-region]")) {
      const n = next.find((x) => x.dataset.region === cur.dataset.region);
      if (!n || (cur.hasAttribute("data-keep") && auto)) continue;
      if (cur.dataset.region === "corner") swapCorner(cur, n);
      else adopt(cur, n);
    }
    for (const id of open) {
      const d = document.getElementById(id);
      if (d && d.tagName === "DETAILS") d.open = true;
    }
    scrollTo(scrollX, scrollY);
    // Never the timer chip: Enter there stops the timer.
    const n = $(".corner-notice");
    (document.getElementById(form.dataset.after || "") || (was && document.getElementById(was)) || (n && n.textContent.trim() && n) || $("main")).focus();
    init();
  };

  const plain = (form, who) => {
    if (who && who.name) {
      const h = document.createElement("input");
      h.type = "hidden";
      h.name = who.name;
      h.value = who.value;
      form.append(h);
    }
    form.submit();
  };

  // Past five minutes, discarding a timer asks first, in the corner (no pop-up).
  const ask = (form, who) => {
    const box = document.createElement("div");
    const p = document.createElement("p");
    p.id = "discard-ask";
    p.className = "corner-text";
    p.textContent = `Discard the timer? It has run ${hm(Date.now() - Date.parse(form.dataset.started))}.`;
    const yes = document.createElement("button");
    yes.type = "submit";
    yes.name = "confirm";
    yes.value = "yes";
    yes.className = "button corner-button";
    yes.textContent = "Discard timer";
    yes.setAttribute("aria-describedby", p.id);
    const no = document.createElement("button");
    no.type = "button";
    no.className = "button corner-button";
    no.textContent = "Keep it";
    const keep = () => {
      box.remove();
      (who && who.isConnected ? who : $("button", form) || $("main")).focus();
    };
    no.addEventListener("click", keep);
    box.addEventListener("keydown", (e) => e.key === "Escape" && keep());
    box.append(p, yes, no);
    form.append(box);
    yes.focus();
  };

  const read = async (url) => {
    const page = await fetch(url, { credentials: "same-origin" });
    return page.ok ? page.text() : null;
  };

  const send = async (form, who) => {
    busy.add(form);
    form.setAttribute("aria-busy", "true");
    try {
      let text;
      try {
        const sent = await fetch(form.action, {
          method: "POST",
          headers: { "X-Live": "1" },
          body: new URLSearchParams(new FormData(form, who)),
          credentials: "same-origin",
        });
        // Not 204: nothing was written (a refusal, a confirm page); the plain post shows it.
        if (sent.status !== 204) return plain(form, who);
        // 204: written, so a missing or foreign address reloads this page, never posts again.
        const to = new URL(sent.headers.get("X-Location") || location.href, location.href);
        if (to.origin !== location.origin) return location.reload();
        if (key(to) !== key(location)) return location.assign(to);
        text = await read(to);
        if (text === null) return location.assign(to);
      } catch {
        say(form, "Couldn't save. Check your connection and try again.");
        return;
      }
      const doc = new DOMParser().parseFromString(text, "text/html");
      const row = form.classList.contains("task-done") && form.closest("[data-task-row], li.card");
      if (row && !calm()) {
        row.classList.add("is-leaving");
        await new Promise((r) => setTimeout(r, 160));
      }
      swap(doc, form, who);
    } finally {
      busy.delete(form);
      form.removeAttribute("aria-busy");
    }
  };

  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!form.matches("form[data-live]")) return;
    e.preventDefault();
    if (busy.has(form)) return;
    const who = e.submitter;
    const old = form.dataset.started && Date.now() - Date.parse(form.dataset.started) > 300000;
    if (old && !(who && who.name === "confirm")) {
      if (!$("#discard-ask", form)) ask(form, who);
      return;
    }
    send(form, who);
  });

  // A filter select changes the list and the address in place (not a page per arrow key).
  document.addEventListener("change", async (e) => {
    const form = e.target.closest("form[data-autosubmit]");
    if (!form || e.target.tagName !== "SELECT") return;
    const url = new URL(form.action);
    url.search = new URLSearchParams(new FormData(form));
    let text = null;
    try {
      if (url.origin === location.origin) text = await read(url);
    } catch {
      text = null;
    }
    if (text === null) return form.submit();
    history.replaceState(null, "", url);
    swap(new DOMParser().parseFromString(text, "text/html"), form, e.target);
    const n = $("[data-count-text]");
    if (n) say(form, `Showing ${n.dataset.countText}.`);
  });

  // Opening a row unfolds its <noscript> forms (task-row.ts); a swapped-in one holds elements.
  document.addEventListener(
    "toggle",
    ({ target: d }) => {
      for (const n of d.open ? $$(":scope > div > noscript", d) : []) {
        const kids = n.firstElementChild ? n.childNodes : new DOMParser().parseFromString(n.textContent, "text/html").body.childNodes;
        n.replaceWith(...Array.from(kids, (c) => document.importNode(c, true)));
      }
    },
    true,
  );

  init();
})();
