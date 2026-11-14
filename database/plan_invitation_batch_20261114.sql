-- Send multiple plan invitations as one transaction when linking a group.
create or replace function public.send_plan_invitations_batch(
    p_actor uuid, p_plan bigint, p_targets uuid[])
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
    v_target uuid;
    v_result jsonb;
    v_results jsonb := '[]'::jsonb;
begin
    if p_targets is null or cardinality(p_targets) > 200 then
        raise exception 'Invalid recipients' using errcode = '22023';
    end if;
    for v_target in select distinct target from unnest(p_targets) as target order by target loop
        v_result := public.send_plan_invitation(p_actor, p_plan, v_target);
        v_results := v_results || jsonb_build_array(v_result);
    end loop;
    return jsonb_build_object('results', v_results);
end;
$$;
revoke all on function public.send_plan_invitations_batch(uuid,bigint,uuid[]) from public, anon, authenticated;
grant execute on function public.send_plan_invitations_batch(uuid,bigint,uuid[]) to service_role;
