# Web Push

Web Push is implemented in the backend and AT client, with **no secrets in Git**. It is intentionally disabled until VAPID is configured on Render. Public URL: https://achievetogether.vercel.app; API is proxied as /api/*.

1. Deploy database/push_subscriptions_20261107.sql once to Supabase fatrborccyknrmeuuvio. It creates a backend-only RLS-enabled table. Confirm server-side SUPABASE_KEY can access it; never use anon key in the server.
2. Generate a P-256 VAPID keypair securely, e.g. with Node crypto.createECDH("prime256v1"), generateKeys(), then public key (uncompressed) and private key encoded base64url. Store VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT=mailto:ops@example.com as **Render service environment variables** (choose an actual monitored address). Never commit or log these values. Public key is delivered through GET /push/config; private key stays on the server.
3. Deploy the Render backend, then the Vercel frontend. Check GET /api/push/config returns enabled:true and publicKey, but never returns the private key. Have a signed-in user open Settings > Notifications and subscribe with a click.
4. For iOS/iPadOS 16.4+, install AT to Home Screen first (Safari Share > Add to Home Screen), launch the icon, then grant permission inside standalone app. Regular Safari tabs cannot subscribe.
5. Test an actual message delivery with the PWA closed, direct and group chats, muted chat, disabled "General" and "New messages", multiple devices, revoked login sessions, expired subscriptions and 404/410 cleanup. Safari requires an immediately displayed notification for every push received.

Endpoints: GET /push/config, GET /push/status?endpoint=..., POST /push/subscribe with {subscription}, POST /push/unsubscribe with {endpoint}. The last two require active cookie JWT session and an allowed Origin. Push notifications are tied to the signing-in session and never bypass server-side settings. The service worker shares the existing root scope with wallpaper caching, but does not cache /api or chat content. Wallpaper-cache off does not unregister the push SW.

No reminders are sent yet: schedule/reminder UI is still a separate workstream, and no marketing notifications are sent. Backend tests: npm test; client: npm run check:release && npm run build. Do not mark physical iOS E2E complete without actual device testing.


## Язык уведомлений о привычках и планах (21.11.2026)

Раньше `services/habitReminderWorker.js` и `services/planReminderWorker.js` формировали двуязычные тела уведомлений. Теперь язык RU/EN хранится отдельно у каждой `at_push_subscriptions.language` (миграция `database/push_subscription_language_20261121.sql`) и передаётся клиентом в `POST /push/subscribe`. Это локальная настройка браузера: в разных браузерах одного пользователя можно использовать разные языки. У старых подписок по умолчанию `ru`; клиент синхронизирует язык на следующем открытии AT или после переключения языка при выданном разрешении. Без Push-разрешения запрос авторизации к браузеру не инициируется автоматически. В воркерах текст локализуется **для каждой подписки**, не меняя очередь заданий, URL, tag, защиту сессий и правила доставки. Уведомление о плане тоже переведено на один язык. Для регрессии: `node --test tests/reminder-locales.test.js`, `npm test` и реальные RU/EN устройства.
