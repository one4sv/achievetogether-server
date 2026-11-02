# Настройка почтовых уведомлений AchieveTogether

## Resend — основной провайдер

Подключён [Resend Email API](https://resend.com/docs/api-reference/emails/send-email) для подтверждения регистрации, кодов 2FA и восстановления паролей. Отправка идёт по HTTPS без Google OAuth.

Для **настоящей отправки** необходимы аккаунт Resend, API-ключ и собственный подтверждённый домен. Пока ключ Resend не указан, действует существующая резервная цепочка Brevo → SendGrid → Gmail. Не считать переход завершённым без получения настоящего письма.

### Создание аккаунта и подтверждение домена

1. Войти или зарегистрироваться в [Resend](https://resend.com/overview).
2. Добавить домен в [Domains](https://resend.com/domains), например `mail.example.com`. Домен должен принадлежать владельцу AT. В DNS внести **точно те записи**, которые покажет Resend (SPF, DKIM, при необходимости MX); дождаться состояния Verified.
3. Создать API-ключ в [API Keys](https://resend.com/api-keys). Достаточно **Sending access**, предпочтительно с ограничением на домен. Скопировать один раз и сохранить как секрет.
4. В Render → Environment серверного сервиса задать:
   - `RESEND_API_KEY` — секретный API-ключ;
   - `RESEND_FROM_EMAIL` — адрес на проверенном домене, например `noreply@mail.example.com`;
   - `MAIL_FROM_NAME` — необязательное имя, по умолчанию `AchieveTogether`.
5. После автодеплоя протестировать письма регистрации, 2FA и восстановления пароля на реальном тестовом аккаунте. Сверить доставку по журналу [Emails](https://resend.com/emails), проверить папку «Спам».
6. Только после подтверждения отправки убрать старые секреты Gmail, Brevo и SendGrid из Render, если не используются.

Рекомендация Resend — отдельный поддомен для транзакционной почты. Общий отправитель `onboarding@resend.dev` предназначен для тестов с собственным email, но не для публичной регистрации AT.

### Реализация и проверка

- `services/sendmail.js` выбирает Resend → Brevo → SendGrid → Gmail. При ошибке выбранного сервиса она передаётся вызывающему коду, без отправки дублей через альтернативного провайдера.
- Resend: `POST https://api.resend.com/emails`, `Authorization: Bearer RESEND_API_KEY`, `from`, `to`, `subject`, `html`.
- Таймаут — 15 секунд. Секретный ключ и тексты писем не логируются.
- `routes/auth/password.js` распознаёт настройку Resend; регистрация и вход используют общий `sendMail`.
- Тесты интеграции: `npm test` или `node --test tests/sendmail-resend.test.js`. Моки не отправляют настоящие письма.

## Ограничения

- Для публичной отправки нужен **верифицированный собственный домен** (проверить DNS в Resend).
- Free-план имеет дневные/месячные квоты: актуальные условия на https://resend.com/pricing.
- Указанный пользователем `https://resend.com/setup.md` не удалось получить через доступные инструменты, поэтому использованы официальные [инструкции для Node.js](https://resend.com/docs/send-with-nodejs), [отправка через API](https://resend.com/docs/api-reference/emails/send-email) и [проверка домена](https://resend.com/docs/dashboard/domains/introduction).
- Resend предоставляет MCP сервер `https://mcp.resend.com/mcp`, но для управления самим аккаунтом через ChatGPT нужно отдельно подтвердить подключение; серверу AT он не требуется.
