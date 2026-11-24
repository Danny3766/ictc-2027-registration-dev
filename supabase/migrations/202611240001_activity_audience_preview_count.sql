-- 2026-11-24: count the active sign-ups that a proposed activity audience would leave outside, so the
-- back office no longer downloads every registration to ask before restricting an activity. Same
-- eligibility rule as staff_registration_statistics; change both together. Apply before the staff Edge Function.
begin;

create function public.staff_activity_audience_outside_count(
  p_actor uuid, p_activity_id bigint, p_audience text
)
returns bigint
language plpgsql security invoker set search_path = ''
as $$
declare v_count bigint; v_hosting_codes text[]; v_pickup_codes text[];
begin
  perform public.staff_assert_actor(p_actor, true);
  if p_activity_id is null or p_activity_id < 1 or p_audience is null
    or not (p_audience in ('all','hosting','pickup') or p_audience ~ '^activity:[1-9][0-9]*$') then
    raise exception using errcode = '22023', message = 'INVALID_AUDIENCE_PREVIEW';
  end if;
  select hosting_identity_codes,pickup_identity_codes into v_hosting_codes,v_pickup_codes
    from public.site_settings where id;
  select count(*) into v_count
  from public.registration_choices choice
  join public.registrations registration on registration.id = choice.registration_id
  left join public.registration_hosting hosting on hosting.registration_id = registration.id and hosting.answer_valid
  left join public.registration_pickup pickup on pickup.registration_id = registration.id and pickup.answer_valid
  left join public.activities prerequisite on 'activity:' || prerequisite.id::text = p_audience and prerequisite.is_published
  left join public.registration_choices required on required.registration_id = registration.id and required.activity_id = prerequisite.id
  where choice.activity_id = p_activity_id and choice.attending and registration.record_status = 'active'
    and not (case p_audience
      when 'all' then true
      when 'hosting' then not (coalesce(registration.meal_identity,'general') = any(v_hosting_codes))
        or coalesce(hosting.status in ('hosting','family_registered'),false)
      when 'pickup' then not (coalesce(registration.meal_identity,'general') = any(v_pickup_codes))
        or coalesce(pickup.status = 'yes',false)
      else coalesce(required.attending,false)
    end);
  return v_count;
end;
$$;
revoke all on function public.staff_activity_audience_outside_count(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.staff_activity_audience_outside_count(uuid,bigint,text) to service_role;

commit;
