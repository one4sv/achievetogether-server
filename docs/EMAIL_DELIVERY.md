# Настройка почтовых уведомлений AchieveTogether

## Получение refresh token в Google OAuth Playground — инструкция для AT

**Уже подтверждено владельцем:** Google Cloud OAuth-проект `inbound-entity-294517`, Publishing status **In production** (скриншот от 02.11.2026). Не нажимать `Back to testing`.

1. Открыть [Google Cloud → Clients](https://console.cloud.google.com/auth/clients?project=inbound-entity-294517). Найти **существующий Web application OAuth client**, чей Client ID совпадает со значением `GOOGLE_CLIENT_ID` в Render. Нельзя брать идентификатор другого проекта/клиента.
2. Для этого клиента в **Authorized redirect URIs** добавить **строго** `https://developers.google.com/oauthplayground`, сохранить.
3. Открыть [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/), в правом верхнем углу ⚙ настроить: **OAuth flow = Server-side**, **Access type = Offline**, **Force prompt = Consent Screen**, **Use your own OAuth credentials** = включено. Вставить Client ID и Client Secret из того же Google OAuth-клиента прямо в официальный Playground; не отправлять их в чат и не коммитить.
4. В **Step 1 → Input your own scopes** указать `https://www.googleapis.com/auth/gmail.send`; нажать **Authorize APIs**. Выбрать **тот Gmail**, с которого сервер должен отправлять письма. Подтвердить только разрешение на отправку; если есть предупреждение о непроверенном приложении, проверить, что это действительно собственный проект.
5. В **Step 2** нажать **Exchange authorization code for tokens**. Скопировать поле **Refresh token** (НЕ Access token). Не использовать опцию `Create Link → Include OAuth credentials and OAuth tokens in the link`.
6. В [Render → achievetogether-server](https://dashboard.render.com/web/srv-d3mh8dje5dus73es6560) открыть **Environment** и заменить **только** `GOOGLE_REFRESH_TOKEN`. Проверить, что `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` относятся к тому же клиенту. Значение `GOOGLE_REDIRECT_URI` используется для первичной авторизации, но не меняет принадлежность refresh token к Client ID.
7. **Важный приоритет:** `services/sendmail.js` выбирает Resend → Brevo → SendGrid → Gmail. Для Gmail не должно быть активных `RESEND_API_KEY`, `BREVO_API_KEY`, `SENDGRID_API_KEY`, иначе будет выбран другой сервис. Не удалять действующие секреты наугад — сначала проверить.
8. Сохранить изменения в Render и дождаться `live`. Запросить письмо через отдельный тестовый сценарий регистрации / восстановления пароля / 2FA, убедиться, что письмо получено и сервер не выдаёт `invalid_grant`.

Внимание: Google OAuth Playground **собственными Playground credentials** отзывает refresh token через 24 часа. Вариант выше с **Use your own OAuth credentials** это ограничение устраняет. Ранее выпущенный в Testing refresh token необходимо заменить новым. Production убирает лишь семидневный предел Testing, но Google может отзывать токен при смене пароля Gmail, неактивности и отзыве разрешения.

Официальные источники: [OAuth Playground](https://developers.google.com/oauthplayground/), [OAuth 2.0 refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [Web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

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
