begin;

-- Saves a drag-and-drop order for identities in one call. The list must name every identity
-- exactly once, so a stale page (an identity added or removed elsewhere) is refused instead of
-- leaving gaps. Sort order alone never marks registrations for re-import.
create function public.staff_reorder_identities(p_actor uuid, p_identity_codes text[])
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before jsonb;
  v_after jsonb;
begin
  perform public.staff_assert_actor(p_actor, true);
  -- Row locks would not stop an identity inserted after the count check; this table lock does.
  lock table public.registration_identities in share row exclusive mode;
  if p_identity_codes is null
    or cardinality(p_identity_codes) <> (select count(*) from public.registration_identities)
    or cardinality(p_identity_codes) <> (select count(distinct given.identity_code) from unnest(p_identity_codes) as given(identity_code))
    or exists (
      select 1 from unnest(p_identity_codes) as given(identity_code)
      where not exists (select 1 from public.registration_identities identity where identity.code = given.identity_code)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_IDENTITY_ORDER';
  end if;

  select jsonb_agg(code order by sort_order, code) into v_before from public.registration_identities;
  update public.registration_identities identity
  set sort_order = ordered.position::integer
  from unnest(p_identity_codes) with ordinality as ordered(identity_code, position)
  where identity.code = ordered.identity_code and identity.sort_order is distinct from ordered.position::integer;
  select jsonb_agg(code order by sort_order, code) into v_after from public.registration_identities;

  if v_before is distinct from v_after then
    insert into public.audit_events (actor_type, actor_user_id, action, target_type, before_data, after_data)
    values ('admin', p_actor, 'reference.reordered', 'identity',
      jsonb_build_object('order', v_before), jsonb_build_object('order', v_after));
  end if;
end;
$$;

revoke execute on function public.staff_reorder_identities(uuid, text[]) from public, anon, authenticated;
grant execute on function public.staff_reorder_identities(uuid, text[]) to service_role;

commit;
