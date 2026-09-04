// Service worker mínimo: habilita la instalación como app (PWA).
// No cachea nada para que el panel siempre muestre datos en vivo.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* passthrough: la red maneja todo */ });
