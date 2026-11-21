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
      // Only windows this worker controls: those are board pages, and only they can be navigated.
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) {
        try {
          const moved = await client.navigate("/brief");
          if (moved) {
            await moved.focus();
            return;
          }
        } catch {
          // This window couldn't be moved: try the next one, or open a new one below.
        }
      }
      await self.clients.openWindow("/brief");
    })(),
  );
});
