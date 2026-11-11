begin;

-- Names and family links in one indexed query instead of a lookup followed by a names query.
create or replace function public.staff_registration_children(p_parents jsonb)
returns table (district_id integer, parent_name_key text, serial_no bigint, full_name text)
language sql stable security invoker set search_path = '' as $$
  select child.district_id, child.parent_name_key, child.serial_no, child.full_name
  from jsonb_to_recordset(p_parents) parent(district_id integer, name_key text)
  join public.registrations child on child.district_id = parent.district_id and child.parent_name_key = parent.name_key
  where child.record_status = 'active' and child.is_child
  order by child.serial_no;
$$;
revoke all on function public.staff_registration_children(jsonb) from public, anon, authenticated;
grant execute on function public.staff_registration_children(jsonb) to service_role;

create or replace function public.staff_registration_detail(p_actor uuid, p_registration_id uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  select to_jsonb(detail) into result from (
    select r.id,r.serial_no,r.full_name,r.district_id,r.record_status,r.import_status,r.created_at,r.updated_at,
      r.meal_identity,r.is_child,r.child_type,r.parent_name,
      coalesce((select jsonb_agg(jsonb_build_object('activity_id',c.activity_id,'attending',c.attending))
        from public.registration_choices c where c.registration_id=r.id),'[]') as registration_choices,
      (select jsonb_build_object('status',h.status,'guest_type',h.guest_type,'guest_count',h.guest_count)
        from public.registration_hosting h where h.registration_id=r.id) as registration_hosting,
      (select jsonb_build_object('status',p.status,'count',p.count)
        from public.registration_pickup p where p.registration_id=r.id) as registration_pickup,
      coalesce((select jsonb_agg(jsonb_build_object('serial_no',c.serial_no,'full_name',c.full_name) order by c.serial_no)
        from public.staff_registration_children(jsonb_build_array(jsonb_build_object('district_id',r.district_id,'name_key',r.name_key))) c
        where r.record_status='active' and not r.is_child),'[]') as children
    from public.registrations r where r.id=p_registration_id
  ) detail;
  return result;
end;
$$;
revoke all on function public.staff_registration_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.staff_registration_detail(uuid,uuid) to service_role;

-- Return the canonical saved record in the same RPC/transaction; no extra HTTP read after saving.
create or replace function public.staff_update_registration_result(p_actor uuid,p_registration_id uuid,p_full_name text,
  p_district_id integer,p_choices jsonb,p_hosting jsonb default null,p_meal_identity text default null,
  p_pickup jsonb default null,p_child_type text default null,p_parent_name text default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if not public.staff_update_registration_with_pickup(p_actor,p_registration_id,p_full_name,p_district_id,
    p_choices,p_hosting,p_meal_identity,p_pickup,p_child_type,p_parent_name) then return null; end if;
  return public.staff_registration_detail(p_actor,p_registration_id);
end;
$$;
revoke all on function public.staff_update_registration_result(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text)
  from public,anon,authenticated;
grant execute on function public.staff_update_registration_result(uuid,uuid,text,integer,jsonb,jsonb,text,jsonb,text,text)
  to service_role;

-- Anonymous, bounded aggregates: no names, registration IDs or per-person answers leave the DB.
create or replace function public.staff_registration_statistics(p_actor uuid)
returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare v_result jsonb;
begin
  perform public.staff_assert_actor(p_actor, false);
  with people as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type,
      h.status as hosting_status, h.guest_type, h.guest_count,
      p.status as pickup_status, p.count as pickup_count
    from public.registrations r
    left join public.registration_hosting h on h.registration_id = r.id
    left join public.registration_pickup p on p.registration_id = r.id
    where r.record_status = 'active'
  ), responses as materialized (
    select r.id, r.district_id, r.meal_identity, r.child_type, c.activity_id, c.attending,
      case coalesce(a.audience, 'all')
        when 'all' then true
        when 'hosting' then coalesce(r.meal_identity, 'general') <> 'general'
          or coalesce(r.hosting_status in ('hosting','family_registered'), false)
        when 'pickup' then coalesce(r.meal_identity, 'general') <> 'general'
          or coalesce(r.pickup_status = 'yes', false)
        else coalesce(required.attending, false) end as eligible
    from people r
    join public.registration_choices c on c.registration_id = r.id
    join public.activities a on a.id = c.activity_id and a.is_published
    left join public.activities prerequisite on 'activity:' || prerequisite.id::text = a.audience and prerequisite.is_published
    left join public.registration_choices required on required.registration_id = r.id and required.activity_id = prerequisite.id
  ), meal_attendees as (
    select distinct c.id from responses c join public.activities a on a.id = c.activity_id
    where c.attending and a.category = 'meal'
  ), person_counts as (
    select district_id, meal_identity, child_type, count(*) as count,
      count(*) filter (where meal_identity is null and m.id is not null) as no_identity
    from people left join meal_attendees m on m.id = people.id
    group by district_id, meal_identity, child_type
  ), choice_counts as (
    select district_id, meal_identity, child_type, activity_id, attending, eligible, count(*) as count
    from responses group by district_id, meal_identity, child_type, activity_id, attending, eligible
  ), hosting_counts as (
    select hosting_status as status, guest_type, count(*) as registrations,
      coalesce(sum(guest_count),0) as people
    from people group by hosting_status, guest_type
  ), pickup_counts as (
    select pickup_status as status, count(*) as registrations, coalesce(sum(pickup_count),0) as people
    from people group by pickup_status
  )
  select jsonb_build_object(
    'people', coalesce((select jsonb_agg(to_jsonb(x)) from person_counts x),'[]'),
    'choices', coalesce((select jsonb_agg(to_jsonb(x)) from choice_counts x),'[]'),
    'hosting', coalesce((select jsonb_agg(to_jsonb(x)) from hosting_counts x),'[]'),
    'pickup', coalesce((select jsonb_agg(to_jsonb(x)) from pickup_counts x),'[]')
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.staff_registration_statistics(uuid) from public, anon, authenticated;
grant execute on function public.staff_registration_statistics(uuid) to service_role;
commit;
