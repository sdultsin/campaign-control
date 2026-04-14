with ranked as (
  select
    id,
    row_number() over (
      partition by date
      order by captured_at desc, created_at desc nulls last, id desc
    ) as rn
  from public.cc_daily_snapshots
)
delete from public.cc_daily_snapshots d
using ranked r
where d.id = r.id
  and r.rn > 1;

alter table public.cc_daily_snapshots
  add constraint cc_daily_snapshots_date_key unique (date);
