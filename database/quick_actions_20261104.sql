alter table public.settings
    add column if not exists quick_actions jsonb not null
    default '[]'::jsonb;

alter table public.settings
    add constraint settings_quick_actions_array_check
    check (jsonb_typeof(quick_actions) = 'array' and jsonb_array_length(quick_actions) <= 3);
