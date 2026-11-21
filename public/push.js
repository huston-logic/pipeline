// "Turn on notifications" on the Notifications page (decision 0030). On the tap: ask for permission, register
// /sw.js, subscribe with this copy's public key, put the subscription in the form's hidden fields and send the form
// as a normal page load, so the server's checks and the change banner apply as for any board form. On load, when this
// browser is already one of the listed devices, it shows "This phone" and Turn off on this phone instead. Without this
// script, or without push in this browser, the page's "can't turn notifications on" line stays, both forms stay
// hidden and each device's own Turn off button still works.
(() => {
  const form = document.querySelector("[data-push-key]");
  if (!form || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  const status = document.getElementById(form.dataset.pushStatus);
  const button = form.querySelector("button");
  if (!status || !button) return;
  for (const each of document.querySelectorAll("[data-push-unsupported]")) each.hidden = true;
  form.hidden = false;

  // When this browser's subscription is one the page lists (rows carry the SHA-256 of their endpoint), mark that row
  // "This phone" and offer Turn off on this phone instead of Turn on. The endpoint goes in that form's hidden field.
  const offForm = document.querySelector("[data-push-off]");
  const hexOf = async (text) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  (async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const current = registration ? await registration.pushManager.getSubscription() : null;
    if (!current || !offForm) return;
    const row = document.querySelector(`[data-push-device="${await hexOf(current.endpoint)}"]`);
    if (!row) return;
    for (const each of row.querySelectorAll("[data-push-here]")) each.hidden = false;
    offForm.elements.endpoint.value = current.endpoint;
    offForm.hidden = false;
    form.hidden = true;
  })().catch(() => {});

  /** The base64url public key as bytes, the form every browser's subscribe() accepts. */
  const keyBytes = (text) => {
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
  };

  const say = (text) => (status.textContent = text);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    say("");
    try {
      // Asked first, straight from the tap: phones only show the question in answer to one.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        say("Notifications are blocked for this board. Allow them in this browser's settings, then try again.");
        return;
      }
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const options = { userVisibleOnly: true, applicationServerKey: keyBytes(form.dataset.pushKey) };
      let subscription;
      try {
        subscription = await registration.pushManager.subscribe(options);
      } catch (error) {
        // A subscription made for this copy's earlier key blocks a new one: drop it and subscribe again, once.
        const old = await registration.pushManager.getSubscription();
        if (!old) throw error;
        await old.unsubscribe();
        subscription = await registration.pushManager.subscribe(options);
      }
      const { endpoint, keys } = subscription.toJSON();
      form.elements.endpoint.value = endpoint || "";
      form.elements.p256dh.value = (keys && keys.p256dh) || "";
      form.elements.auth.value = (keys && keys.auth) || "";
      // submit() sends the form without this handler running again.
      form.submit();
    } catch {
      say("Couldn't turn notifications on in this browser. Reload the page and try again.");
    } finally {
      button.disabled = false;
    }
  });
})();
