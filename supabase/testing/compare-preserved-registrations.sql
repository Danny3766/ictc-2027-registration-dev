-- Read-only. Run in the SQL Editor of 正式站 after closing registration and before the first migration,
-- then again after all migrations; the two results must match line by line (Q4 of "2026-11-14
-- 正式站發布時保留既有登記資料" in docs/需求討論與決策紀錄.md). It reads only columns the main schema
-- already has and prints counts and md5 hashes, never names. Keep the result locally; docs/驗收紀錄.md
-- records only whether the two runs match, not the counts.
-- Run both times in the same SQL Editor: timestamps are hashed as text in the session time zone.
-- Audit rows can differ only if someone saved in between; registration stays closed throughout.
-- main has no answer_valid, so after the migrations also run this; both counts must be 0, since 正式站
-- never had a system-generated 否:
--   select (select count(*) from public.registration_hosting where not answer_valid) as hosting_invalid,
--     (select count(*) from public.registration_pickup where not answer_valid) as pickup_invalid;
with
counts(k, n) as (
  select 'record_status=' || record_status, count(*) from public.registrations group by 1
  union all select 'import_status=' || import_status, count(*) from public.registrations group by 1
  union all select 'meal_identity=' || coalesce(meal_identity, '(空白)'), count(*) from public.registrations group by 1
)
select 1 as ord, 'registrations' as item, count(*)::text as value from public.registrations
union all select 2, 'registration counts', string_agg(k || ':' || n, ', ' order by k) from counts
union all select 3, 'student ids md5', md5(coalesce(string_agg(id::text, ',' order by id), ''))
  from public.registrations where meal_identity = 'student'
union all select 4, 'registrations md5', md5(coalesce(string_agg(row(id, serial_no, create_request_id, full_name,
    district_id, record_status, import_status, created_at, updated_at, imported_at, imported_by, name_key,
    meal_identity)::text, E'\n' order by id), ''))
  from public.registrations
union all select 5, 'registration_choices ' || count(*), md5(coalesce(string_agg(row(registration_id, activity_id,
    attending, updated_at)::text, E'\n' order by registration_id, activity_id), ''))
  from public.registration_choices
union all select 6, 'registration_hosting ' || count(*), md5(coalesce(string_agg(row(registration_id, status,
    guest_type, guest_count, family_count, note, pickup_count, updated_at)::text, E'\n' order by registration_id), ''))
  from public.registration_hosting
union all select 7, 'registration_pickup ' || count(*), md5(coalesce(string_agg(row(registration_id, status, count,
    updated_at)::text, E'\n' order by registration_id), ''))
  from public.registration_pickup
union all select 8, 'audit_events', count(*)::text from public.audit_events
order by ord;
