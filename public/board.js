// Drag a deal card to another stage on the pipeline board (decisions 0014, 0017). Progressive enhancement only:
// dropping a card sets that card's own "Move to" select and submits its form as a normal page load, so the server's
// checks, the confirm step for Won, Lost and Not now, and the change banner apply exactly as they do without
// JavaScript. Mouse and trackpad only ((pointer: fine)); on touch screens and by keyboard the Move to form is the way.
(() => {
  const board = document.querySelector("[data-board]");
  if (!board || !window.matchMedia("(pointer: fine)").matches) return;

  const targets = () => document.querySelectorAll("[data-drop-stage]");
  let card = null;

  for (const each of board.querySelectorAll("[data-deal]")) each.draggable = true;
  // An in-place refresh (live.js) swaps the board's elements for new ones: a card is draggable again as the pointer reaches it.
  document.addEventListener("pointerover", (event) => {
    const over = event.target instanceof Element ? event.target.closest("[data-deal]") : null;
    if (over && !over.draggable) over.draggable = true;
  });

  const show = (target) => {
    for (const each of targets()) each.classList.toggle("is-drop-target", each === target);
  };

  const clear = () => {
    show(null);
    document.body.classList.remove("is-dragging");
    if (card) card.classList.remove("is-dragged");
    card = null;
  };

  /** The stage under the pointer, unless it is the card's own stage. */
  const targetOf = (event) => {
    const found = event.target instanceof Element ? event.target.closest("[data-drop-stage]") : null;
    return card && found && found.dataset.dropStage !== card.dataset.stage ? found : null;
  };

  document.addEventListener("dragstart", (event) => {
    const from = event.target instanceof Element ? event.target.closest("[data-deal]") : null;
    if (!from || !from.closest("[data-board]") || !event.dataTransfer) return;
    card = from;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", from.dataset.deal);
    // The title link covers the card, so the drag often starts on it: show the whole card, not the link.
    const box = from.getBoundingClientRect();
    event.dataTransfer.setDragImage(from, event.clientX - box.left, event.clientY - box.top);
    document.body.classList.add("is-dragging");
    from.classList.add("is-dragged");
  });

  document.addEventListener("dragover", (event) => {
    const target = targetOf(event);
    show(target);
    if (!target) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  });

  document.addEventListener("drop", (event) => {
    const target = targetOf(event);
    if (!target) return;
    event.preventDefault();
    const select = card.querySelector("select[name=stage]");
    const form = select ? select.form : null;
    const stage = target.dataset.dropStage;
    clear();
    if (!select || !form) return;
    select.value = stage;
    if (select.value === stage) form.requestSubmit();
  });

  document.addEventListener("dragend", clear);
})();

// Phone actions and Ask Claude on the deal and contact pages (decision 0021). Progressive enhancement only: without
// this script the Log buttons are always there and each prompt can be copied by hand from its "Show the prompt" box.
(() => {
  // After Call, Text or Email opens the phone's own app, focus the matching Log button, so one more tap logs it.
  for (const link of document.querySelectorAll("[data-log]")) {
    link.addEventListener("click", () => {
      const button = document.getElementById(link.dataset.log);
      if (!button) return;
      for (const each of document.querySelectorAll(".is-next")) each.classList.remove("is-next");
      button.classList.add("is-next");
      button.focus();
    });
  }

  // Copy prompt (and the email log address, decision 0031): the button is hidden until the clipboard can be used; the
  // result is said in a polite live region. data-copy-fail says what to do instead on a page with other words.
  if (!navigator.clipboard) return;
  for (const button of document.querySelectorAll("[data-copy]")) {
    const source = document.getElementById(button.dataset.copy);
    const status = document.getElementById(button.dataset.copyStatus);
    if (!source || !status) continue;
    const failed = button.dataset.copyFail || "Couldn't copy. Open Show the prompt and copy it from there.";
    button.hidden = false;
    button.addEventListener("click", () => {
      // Emptied first, so a second click says "Copied." again to a screen reader.
      status.textContent = "";
      navigator.clipboard.writeText(source.value).then(
        () => (status.textContent = "Copied."),
        () => (status.textContent = failed),
      );
    });
  }
})();
