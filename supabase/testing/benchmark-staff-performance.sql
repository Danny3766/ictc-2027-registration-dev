-- Run only on an isolated local database with the current migrations. All rows roll back.
\timing on
begin;
do $$ begin
  if not coalesce((select is_test_environment from public.site_settings where id),false) then
    raise exception 'TEST_PROJECT_NOT_CONFIRMED';
  end if;
end $$;
update public.activities set is_published=false;
insert into public.activities(category,title,is_published,sort_order,audience,fee_amount)
select 'meal','Performance activity '||n,true,9000+n,'all',100 from generate_series(1,12) n;
insert into public.registrations(create_request_id,full_name,district_id,meal_identity)
select gen_random_uuid(),'Performance load '||n,(select id from public.districts order by sort_order limit 1),
  case when n%2=0 then 'student' else 'general' end from generate_series(1,10000) n;
insert into public.registration_choices(registration_id,activity_id,attending)
select r.id,a.id,r.serial_no%3<>0 from public.registrations r cross join public.activities a
where r.full_name like 'Performance load %' and a.is_published;
analyze public.registrations;
analyze public.registration_choices;
select count(*) as synthetic_registrations from public.registrations where full_name like 'Performance load %';
explain (analyze,buffers)
select public.staff_registration_statistics((select auth_user_id from public.staff_profiles where is_active and not must_change_password limit 1));
select octet_length(public.staff_registration_statistics((select auth_user_id from public.staff_profiles where is_active and not must_change_password limit 1))::text)
  as aggregate_payload_bytes;
-- Full-export payload baseline, excluding reference tables, using the same nested answer fields.
select octet_length(jsonb_agg(to_jsonb(detail))::text) as export_payload_bytes from (
  select r.id,r.serial_no,r.full_name,r.district_id,r.record_status,r.import_status,r.updated_at,r.meal_identity,r.child_type,
    (select jsonb_agg(jsonb_build_object('activity_id',c.activity_id,'attending',c.attending))
      from public.registration_choices c where c.registration_id=r.id) as registration_choices
  from public.registrations r where r.record_status='active'
) detail;
rollback;
