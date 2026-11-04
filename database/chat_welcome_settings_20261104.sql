-- Personal chat welcome text. No synthetic messages or notification rows are created.
alter table public.settings
    add column if not exists chat_welcome jsonb not null
    default '{"enabled": false, "text": ""}'::jsonb;
