/* Оффлайн для тренажёра Академии.

   Зачем: ученик открывает шпаргалку за столом в клубе, в метро, в дороге —
   там, где связи может не быть. Приложение статическое и весит ~90 КБ, поэтому
   кэшируется целиком.

   Стратегия:
   - страница (index.html) — сначала сеть, кэш как запасной вариант. Иначе после
     деплоя ученик остался бы на старой сборке навсегда;
   - остальное своё (app.css, app.js, data/*.js) — сначала кэш: ссылки на них
     помечены ?v=<дата>, новая сборка = новый адрес = промах кэша и свежая версия;
   - чужие домены (Telegram SDK, шрифты) не трогаем вообще.
*/
const V = 'syn-academia-202608281156';   // deploy.sh подставляет сюда дату сборки

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const isPage = req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');

  if (isPage) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(V).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(V).then(c => c.put(req, copy));
      return res;
    }))
  );
});
