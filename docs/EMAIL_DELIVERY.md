# Настройка почтовых уведомлений AchieveTogether

## Бесплатный вариант без покупки домена — Gmail API

**На текущем этапе владелец AT не планирует покупать собственный домен.** Поэтому Resend остаётся *опциональным будущим провайдером*, а для работающей отправки можно использовать уже существующую интеграцию Gmail API по HTTPS.

Причина 7-дневного истечения `GOOGLE_REFRESH_TOKEN`: при `Google Auth Platform → Audience → Publishing status: Testing` внешний OAuth-проект выдаёт refresh token на 7 дней для Gmail scopes. Выход без оплаты домена: **перевести этот же OAuth-проект в `In production`, затем получить новый refresh token** с `access_type=offline` и `prompt=consent` и заменить только `GOOGLE_REFRESH_TOKEN` в Render. Старый токен, выпущенный в Testing, не следует считать автоматически продлённым. Статус «In production» убирает именно 7-дневный тестовый срок, но токены всё равно могут отзываться.

1. Открыть https://console.cloud.google.com/auth/audience, выбрать **текущий** OAuth-проект, не создавать другой Client ID без необходимости.
2. Переключить Publishing status: `Testing → In production`.
3. Если Google покажет предупреждение о непроверенном приложении, учесть ограничения для OAuth-приложений с доступом к Gmail. Для личного использования одним отправляющим Google-аккаунтом Google документирует исключение из обязательной проверки; публичный доступ сторонних Google-пользователей — другой сценарий.
4. Повторно дать разрешение **своему почтовому аккаунту**, безопасно получить новый refresh token и заменить его в **Render → Environment**. Не хранить токен в GitHub или чате. API-key и отправитель Resend для этого способа не нужны.
5. Проверить настоящие письма подтверждения регистрации, 2FA и восстановления пароля. Если они не дошли, проверить отправку Gmail API и лог сервера; не считать настройку проверенной по статусу деплоя.

**Не переходить на Gmail SMTP через Nodemailer на бесплатном Render.** Render блокирует исходящие соединения на SMTP-порты `25`, `465`, `587`; HTTPS Gmail API на 443 работает независимо от SMTP-портов. Gmail для публичных продуктовых писем ограничен квотами и антиспам-фильтрами (для личных аккаунтов до ~500 писем/день по правилам Google) и не гарантирует пригодность при росте аудитории.

Источники: [Google OAuth token lifetime](https://developers.google.com/identity/protocols/oauth2#expiration), [Google OAuth без верификации для личного использования](https://support.google.com/cloud/answer/13464323), [Render Free network limitations](https://render.com/docs/free), [Gmail sending limits](https://support.google.com/mail/answer/22839).

## Resend — опциональный провайдер при появлении домена

В коде подготовлен [Resend Email API](https://resend.com/docs/api-reference/emails/send-email) для подтверждения регистрации, кодов 2FA и восстановления паролей. Отправка идёт по HTTPS без Google OAuth.

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
