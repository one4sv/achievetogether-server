-- Convert existing weights to stable milestone percentages without changing the current
-- achieved progress. For legacy-only goals place completed stages first in the calculation
-- (not in the UI); mixed goals retain the existing positional fallback calculation.
with source as (
    select id,goal_id,weight,position,completed_at,completion_percent,
        bool_or(completion_percent is not null) over(partition by goal_id) as has_percent
    from public.at_goal_stages
), percentages as (
    select id, completion_percent,
        round(100 * sum(weight) over(partition by goal_id order by
            case when has_percent then 0 when completed_at is not null then 0 else 1 end,
            position,id rows between unbounded preceding and current row)
            / nullif(sum(weight) over(partition by goal_id),0),2) as percent
    from source
)
update public.at_goal_stages s
set completion_percent=p.percent
from percentages p
where s.id=p.id and s.completion_percent is null and p.percent is not null;
