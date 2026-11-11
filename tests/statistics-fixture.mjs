// Independent reference implementation for UI fixtures; real aggregation runs in PostgreSQL.
export function statisticsFixture(registrations, activities) {
  const groups = { people: new Map(), choices: new Map(), hosting: new Map(), pickup: new Map() };
  const add = (name, key, fields, n = 1, extra = {}) => {
    const group = groups[name];
    if (!group.has(key)) group.set(key, { ...fields, count: 0, ...extra });
    group.get(key).count += n;
    return group.get(key);
  };
  const normalize = (value) => Array.isArray(value) ? value[0] : value;
  for (const r of registrations.filter((r) => r.record_status === "active")) {
    const fields = { district_id: r.district_id, meal_identity: r.meal_identity ?? null, child_type: r.child_type ?? null };
    const p = add("people", JSON.stringify(fields), fields, 1, { no_identity: 0 });
    const published = activities.filter((a) => a.is_published);
    if (!r.meal_identity && published.some((a) => a.category === "meal"
      && r.registration_choices.some((c) => c.activity_id === a.id && c.attending))) p.no_identity++;
    const hosting = normalize(r.registration_hosting), pickup = normalize(r.registration_pickup);
    for (const [name, answer] of [["hosting", hosting], ["pickup", pickup]]) {
      const values = { status: answer?.status ?? null, ...(name === "hosting" ? { guest_type: answer?.guest_type ?? null } : {}) };
      const x = add(name, JSON.stringify(values), values, 1, { registrations: 0, people: 0 });
      x.registrations++;
      x.people += (name === "hosting" ? answer?.guest_count : answer?.count) ?? 0;
    }
    for (const c of r.registration_choices) {
      const a = published.find((a) => a.id === c.activity_id);
      if (!a) continue;
      const skips = (r.meal_identity ?? "general") !== "general";
      const audience = a.audience ?? "all";
      const eligible = audience === "all" || audience === "hosting" && (skips || ["hosting", "family_registered"].includes(hosting?.status))
        || audience === "pickup" && (skips || pickup?.status === "yes")
        || audience.startsWith("activity:") && published.some((a) => a.id === Number(audience.slice(9))
          && r.registration_choices.some((c) => c.activity_id === a.id && c.attending));
      const values = { ...fields, activity_id: c.activity_id, attending: c.attending, eligible };
      add("choices", JSON.stringify(values), values);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([key, value]) => [key, [...value.values()]]));
}
