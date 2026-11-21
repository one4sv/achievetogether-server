-- Language follows the device/browser that owns each Push subscription.
-- Existing records default to RU until the browser syncs its actual language.
alter table public.at_push_subscriptions
    add column if not exists language text not null default 'ru'
    constraint at_push_subscriptions_language_check check (language in ('ru','en'));
