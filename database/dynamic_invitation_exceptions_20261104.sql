-- Dynamic invitation privacy overrides. Existing allow/deny values remain supported.
-- Newly selected exceptions use "invert": deny when the general rule allows,
-- allow by invitation message when the general rule denies.
do $$
declare
    definition text;
    original_rule text;
    dynamic_rule text;
begin
    select pg_get_functiondef(p.oid) into definition
    from pg_proc p
    where p.proname = 'group_invite_mode' and p.pronamespace = 'public'::regnamespace
    limit 1;

    original_rule := '    return coalesce(v_mode, case when v_contact then ''message'' else ''none'' end);';
    dynamic_rule := '    v_mode := coalesce(v_mode, case when v_contact then ''message'' else ''none'' end);
    if v_exception = ''invert'' then
        return case when v_mode = ''none'' then ''message'' else ''none'' end;
    end if;
    return v_mode;';

    if definition is null or position(original_rule in definition) = 0 then
        raise exception 'Unexpected group_invite_mode definition; migration not applied';
    end if;

    execute replace(definition, original_rule, dynamic_rule);

    select pg_get_functiondef(p.oid) into definition
    from pg_proc p
    where p.proname = 'send_habit_invitation' and p.pronamespace = 'public'::regnamespace
    limit 1;

    original_rule := '    if v_exception = ''deny'' or (coalesce(v_exception,'''') <> ''allow'' and (
        v_privacy->>''activity_invites'' = ''nobody'' or (v_privacy->>''activity_invites'' = ''contacts'' and not v_contact)
    )) then raise exception ''Recipient privacy denied'' using errcode = ''42501''; end if;';
    dynamic_rule := '    if v_exception = ''invert'' then
        if not (v_privacy->>''activity_invites'' = ''nobody'' or
            (v_privacy->>''activity_invites'' = ''contacts'' and not v_contact)) then
            raise exception ''Recipient privacy denied'' using errcode = ''42501'';
        end if;
    elsif v_exception = ''deny'' or (coalesce(v_exception,'''') <> ''allow'' and (
        v_privacy->>''activity_invites'' = ''nobody'' or (v_privacy->>''activity_invites'' = ''contacts'' and not v_contact)
    )) then
        raise exception ''Recipient privacy denied'' using errcode = ''42501'';
    end if;';

    if definition is null or position(original_rule in definition) = 0 then
        raise exception 'Unexpected send_habit_invitation definition; migration not applied';
    end if;

    execute replace(definition, original_rule, dynamic_rule);
end;
$$;
