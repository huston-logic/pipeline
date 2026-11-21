// The board's only service worker (decision 0030): a phone notification when the daily brief is ready, and nothing
// else. It stores nothing and handles no page requests, so every page still comes from the Worker behind the sign-in.
// Every push shows the same fixed notification (a push that shows none can cost the subscription on some phones);
// the payload holds no customer data and is not read.

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Your daily brief is ready", {
      body: "Open the Brief tab.",
      icon: "/icons/icon-192.png",
      tag: "brief",
    }),
  );
});

// Tapping it brings an open board window to the Brief page, or opens one there.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const focused = await client.focus();
          await focused.navigate("/brief");
          return;
        } catch {
          // A window this worker doesn't control can't be navigated: open a new one below.
        }
      }
      await self.clients.openWindow("/brief");
    })(),
  );
});
