self.addEventListener("message", (event) => {
  if (event.data?.type !== "opencode.notification.client") return
  event.ports[0]?.postMessage(event.source.id)
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data = event.notification.data
  event.waitUntil(
    self.clients.get(data.client).then(async (client) => {
      if (client) {
        await client.focus()
        client.postMessage({ type: "opencode.notification", id: data.id, click: true })
        return
      }
      await self.clients.openWindow(data.url)
    }),
  )
})

self.addEventListener("notificationclose", (event) => {
  const data = event.notification.data
  event.waitUntil(
    self.clients.get(data.client).then((client) => {
      client?.postMessage({ type: "opencode.notification", id: data.id, click: false })
    }),
  )
})
