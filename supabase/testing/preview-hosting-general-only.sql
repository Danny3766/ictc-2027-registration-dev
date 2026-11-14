-- Read-only. Lists the active student and custom-identity registrations whose 開家接待／接機接待
-- answers are not 否, for the project lead to review (Q2 of "2026-11-14 正式站發布時保留既有登記資料"
-- in docs/需求討論與決策紀錄.md). The migrations keep these answers. Run it after 202611090002: the
-- main schema has neither is_child nor registration_identities. The result has names: show it to the
-- project lead only, and do not paste it into the repo, a PR or a chat.
with affected as (
  select r.id, r.serial_no, r.full_name, r.district_id, r.meal_identity,
    public.registration_hosting_get(r.id) as hosting, public.registration_pickup_get(r.id) as pickup
  from public.registrations r
  where r.record_status = 'active' and not r.is_child and r.meal_identity is not null
    and r.meal_identity not in ('general', 'child', 'preschool')
)
select a.serial_no, a.full_name, d.name as district, coalesce(i.name, a.meal_identity) as identity,
  coalesce(a.hosting->>'status', '未回答') as hosting_status,
  coalesce(a.pickup->>'status', '未回答') as pickup_status,
  -- 是 answers are the ones the project lead needs to look at.
  coalesce(a.hosting->>'status', '') in ('hosting', 'family_registered')
    or coalesce(a.pickup->>'status', '') = 'yes' as had_yes
from affected a
join public.districts d on d.id = a.district_id
left join public.registration_identities i on i.code = a.meal_identity
where a.hosting is distinct from public.registration_hosting_value('{"status": "not_hosting"}')
  or a.pickup is distinct from public.registration_pickup_value('{"status": "no", "count": 0}')
order by had_yes desc, a.serial_no;
