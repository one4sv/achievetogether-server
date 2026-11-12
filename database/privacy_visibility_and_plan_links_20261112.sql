-- Per-account and per-plan unguessable share tokens. No public select privileges.
alter table public.settings
    add column if not exists profile_share_token uuid not null default gen_random_uuid();
alter table public.one_off_plans
    add column if not exists share_token uuid not null default gen_random_uuid();
alter table public.one_off_plans drop constraint if exists one_off_plans_visibility_check;
alter table public.one_off_plans add constraint one_off_plans_visibility_check
    check (visibility in ('inherit','nobody','contacts','all','link'));
alter table public.one_off_plans alter column visibility set default 'inherit';
-- Plans created before account-level privacy had no explicit per-plan UI.
update public.one_off_plans set visibility = 'inherit' where visibility = 'nobody';
alter table public.posts drop constraint if exists posts_visibility_allowed;
alter table public.posts add constraint posts_visibility_allowed
    check (visibility in ('inherit','nobody','contacts','all','link'));
alter table public.settings alter column private set default
    '{"number":"contacts","mail":"contacts","profile":"all","habits":"all","posts":"all","plans":"nobody","activity_invites":"all","plan_invites":"contacts"}'::jsonb;
update public.settings set private = jsonb_build_object('profile','all','plans','nobody','plan_invites','contacts')
    || coalesce(private,'{}'::jsonb);
