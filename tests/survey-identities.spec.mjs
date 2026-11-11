import { test, expect } from "@playwright/test";

const reference = () => ({
  settings: { event_name: "接待測試", is_registration_open: true, is_lookup_open: true,
    is_hosting_open: true, is_pickup_open: true, hosting_identity_codes: ["general", "child"], pickup_identity_codes: ["general", "student"] },
  identities: [["general","一般"],["student","學生"],["child","兒童（國小）"],["preschool","兒童（學齡前）"]]
    .map(([code,name]) => ({ code,name,is_active:true,public_selectable:true })),
  districts: [{id:1,name:"測試區"}], activities:[{id:1,title:"聚會",category:"meeting",is_published:true}], program:[],
});
const record = (extra = {}) => ({ full_name:"填寫者",district_id:1,can_change:true,meal_identity:"general",
  choices:[{activity_id:1,attending:true}],hosting:{status:"hosting",guest_type:"any",guest_count:2},pickup:{status:"yes",count:3}, ...extra });
async function publicPage(page, data=reference(), saved=record(), writes=[]) {
  await page.route("**/functions/v1/registration", route => {
    if (route.request().method()==="GET") return route.fulfill({json:data});
    const body=route.request().postDataJSON();
    if (body.action==="query") return route.fulfill({json:saved});
    writes.push(body); return route.fulfill({json:{success:true}});
  });
  await page.goto("/");
  await expect(page.locator('#registration-form [name="meal_identity"]')).toBeVisible();
}
async function lookup(page) {
  await page.getByRole("tab",{name:"查詢或修改登記"}).click();
  await page.locator('#query-form [name="full_name"]').fill("填寫者");
  await page.locator('#query-form [name="district_id"]').selectOption("1");
  await page.getByRole("button",{name:"查詢",exact:true}).click();
  await expect(page.locator("#start-edit")).toBeVisible();
}

test("public surveys use separate identity lists including children and hidden required fields do not block",async ({page})=>{
  await publicPage(page);
  const identity=page.locator('#registration-form [name="meal_identity"]');
  await identity.selectOption("student");
  await expect(page.locator("#hosting-fields")).toBeHidden();
  await expect(page.locator('#registration-form [name="pickup_status"]').first()).toBeVisible();
  await identity.selectOption("child");
  await expect(page.locator('#registration-form [name="hosting_status"]').first()).toBeVisible();
  await expect(page.locator('#registration-form [name="pickup_status"]').first()).toBeHidden();
  await page.locator('#registration-form [name="hosting_status"][value="not_hosting"]').check();
  await page.locator('#registration-form [name="full_name"]').fill("兒童");
  await page.locator('#registration-form [name="district_id"]').selectOption("1");
  await page.locator('#registration-form [name="parent_name"]').fill("家長");
  await page.locator('#registration-form [name="activity_1"][value="false"]').check();
  expect(await page.locator("#registration-form").evaluate(form=>form.checkValidity())).toBe(true);
});

test("lookup keeps non-target answers visible and read-only",async ({page})=>{
  await publicPage(page,reference(),record({meal_identity:"preschool",child_type:"preschool",parent_name:"家長"}));
  await lookup(page);
  await expect(page.locator("#edit-hosting")).toContainText("2 位");
  await expect(page.locator("#edit-pickup")).toContainText("3 位");
  await expect(page.locator("#edit-pickup")).toContainText("目前此身分未開放修改");
  await page.locator("#start-edit").click();
  await expect(page.locator('#edit-pickup [name="pickup_status"]')).toHaveCount(0);
});

test("leaving and returning clears only the affected answer and cancel restores stored answers",async ({page})=>{
  const writes=[];
  page.on("dialog", dialog => dialog.accept());
  await publicPage(page,reference(),record(),writes);
  await lookup(page); await page.locator("#start-edit").click();
  const identity=page.locator('#edit-form [name="meal_identity"]');
  await identity.selectOption("student"); await identity.selectOption("general");
  await expect(page.locator('#edit-hosting [name="hosting_status"]:checked')).toHaveCount(0);
  await expect(page.locator('#edit-pickup [name="pickup_status"][value="yes"]')).toBeChecked();
  await expect(page.locator("#save-edit")).toBeDisabled();
  await page.locator("#cancel-edit").click();
  await expect(page.locator("#edit-hosting")).toContainText("2 位");
  expect(writes).toHaveLength(0);
  await page.locator("#start-edit").click();
  await identity.selectOption("student"); await identity.selectOption("general");
  await page.locator('#edit-hosting [name="hosting_status"][value="hosting"]').check();
  await page.locator('#edit-hosting [name="guest_count"]').selectOption("4");
  await page.locator('#edit-hosting [name="guest_type"]').selectOption("any");
  await page.locator("#save-edit").click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].hosting.guest_count).toBe(4);
  expect(writes[0].pickup.count).toBe(3);
});

test("an identity round trip while closed retains history and persists the need to answer later",async ({page})=>{
  const data=reference(),writes=[];
  data.settings.is_hosting_open=false; data.settings.is_pickup_open=false;
  await publicPage(page,data,record(),writes);
  // The server answers with what it saved: the reset hosting answer kept as invalid history.
  await page.route("**/functions/v1/registration",route=>{
    if(route.request().method()==="GET"||route.request().postDataJSON().action!=="update")return route.fallback();
    writes.push(route.request().postDataJSON());
    return route.fulfill({json:{success:true,surveys:{hosting:{...record().hosting,answer_valid:false},pickup:record().pickup}}});
  });
  await lookup(page); await page.locator("#start-edit").click();
  const identity=page.locator('#edit-form [name="meal_identity"]');
  await identity.selectOption("student"); await identity.selectOption("general");
  await expect(page.locator('#edit-hosting [name="hosting_status"]')).toHaveCount(0);
  await page.locator("#save-edit").click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].hosting).toEqual({reset:true});
  expect(writes[0]).not.toHaveProperty("pickup");
  await expect(page.locator("#edit-hosting")).toContainText("2 位");
  await expect(page.locator("#edit-hosting")).toContainText("須重新回答");
});

test("a generated legacy no is unanswered when the identity is now eligible",async ({page})=>{
  let asked=false;
  page.on("dialog",dialog=>{asked=true; dialog.accept();});
  await publicPage(page,reference(),record({hosting:{status:"not_hosting",answer_valid:false}}));
  await lookup(page);
  await expect(page.locator("#edit-hosting")).toContainText("須重新回答");
  await page.locator("#start-edit").click();
  await expect(page.locator('#edit-hosting [name="hosting_status"]:checked')).toHaveCount(0);
  await expect(page.locator("#save-edit")).toBeDisabled();
  // Leaving the invalidated answer unanswered is not an unsaved change.
  await page.locator("#cancel-edit").click();
  await expect(page.locator("#start-edit")).toBeVisible();
  expect(asked).toBe(false);
});

test("legacy invalid answers stay hidden for an identity that cannot answer",async ({page})=>{
  const data=reference();
  data.settings.pickup_identity_codes=["general"];
  await publicPage(page,data,record({meal_identity:"student",hosting:{status:"not_hosting",answer_valid:false},pickup:{status:"no",count:0,answer_valid:false}}));
  await lookup(page);
  await expect(page.locator("#edit-hosting-section")).toBeHidden();
});

test("passing through 請選擇 keeps the answers on the lookup and new registration forms",async ({page})=>{
  page.on("dialog",dialog=>dialog.accept());
  await publicPage(page);
  const create=page.locator('#registration-form [name="meal_identity"]');
  await create.selectOption("general");
  await page.locator('#registration-form [name="hosting_status"][value="not_hosting"]').check();
  await create.selectOption(""); await create.selectOption("general");
  await expect(page.locator('#registration-form [name="hosting_status"][value="not_hosting"]')).toBeChecked();
  await lookup(page); await page.locator("#start-edit").click();
  const identity=page.locator('#edit-form [name="meal_identity"]');
  await identity.selectOption(""); await identity.selectOption("general");
  await expect(page.locator('#edit-hosting [name="hosting_status"][value="hosting"]')).toBeChecked();
  await expect(page.locator('#edit-pickup [name="pickup_status"][value="yes"]')).toBeChecked();
});

test("staff settings use independent checkboxes, retain closed selections and allow staff answers for a child",async ({page})=>{
  const data=reference(),writes=[],creates=[];
  data.identities.push({code:"retired",name:"志工",is_active:false,public_selectable:false});
  data.identities.push({code:"private",name:"同工",is_active:true,public_selectable:false});
  data.identities.push({code:"hidden",name:"隱藏身分",is_active:false,public_selectable:false});
  data.settings.hosting_identity_codes.push("retired");
  data.settings.pickup_identity_codes.push("private");
  await page.route("**/auth/v1/token?grant_type=password",route=>route.fulfill({json:{access_token:"token",refresh_token:"refresh",expires_in:3600}}));
  await page.route("**/functions/v1/staff",route=>{
    const body=route.request().postDataJSON();
    const profile={auth_user_id:"123e4567-e89b-42d3-a456-426614174000",display_name:"管理員",role:"admin",must_change_password:false};
    if(body.action==="me") return route.fulfill({json:{profile,...data}});
    if(body.action==="list_reference")return route.fulfill({json:data});
    if(body.action==="list_registrations")return route.fulfill({json:{registrations:[],count:0}});
    if(body.action==="save_reference") {writes.push(body); Object.assign(data.settings,body.data); return route.fulfill({json:{saved:data.settings}});}
    if(body.action==="create_registration") {creates.push(body); return route.fulfill({status:201,json:{serial_no:7}});}
    return route.fulfill({json:{staff:[]}});
  });
  await page.goto("/admin/");
  await page.locator('#login-form [name="username"]').fill("tester");
  await page.locator('#login-form [name="password"]').fill("test-password");
  await page.getByRole("button",{name:"登入",exact:true}).click();
  await page.getByRole("link",{name:"開家與接機接待",exact:true}).click();
  const form=page.locator("#hosting-settings-form");
  await expect(form.getByLabel("志工（已停用）")).toBeChecked();
  await expect(form.getByLabel("同工（僅後台可選）")).toBeChecked();
  await expect(form.getByText("隱藏身分")).toHaveCount(0);
  await form.locator('[name="is_hosting_open"]').uncheck();
  await expect(page.locator("#hosting-identities")).toBeHidden();
  await form.locator('[name="is_hosting_open"]').check();
  await expect(form.getByLabel("志工（已停用）")).toBeChecked();
  for(const box of await form.locator('[name="hosting_identity_codes"]').all()) await box.uncheck();
  await form.getByRole("button",{name:"儲存接待設定"}).click();
  await expect(page.locator("#message")).toContainText("請至少選擇一個");
  expect(writes).toHaveLength(0);
  await page.locator('#hosting-identities [value="student"]').check();
  await form.getByRole("button",{name:"儲存接待設定"}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0].data.hosting_identity_codes).toEqual(["student"]);
  expect(writes[0].data.pickup_identity_codes).toEqual(["general","student","private"]);
  await page.getByRole("link",{name:"協助登記",exact:true}).click();
  const create=page.locator("#new-registration-form");
  await create.locator('[name="meal_identity"]').selectOption("child");
  await create.locator('[name="full_name"]').fill("兒童代填");
  await create.locator('[name="district_id"]').selectOption("1");
  await create.locator('[name="parent_name"]').fill("家長");
  await create.locator('[name="activity_1"][value="false"]').check();
  await create.locator('[name="hosting_status"][value="hosting"]').check();
  await create.locator('[name="guest_type"]').selectOption("any");
  await create.locator('[name="guest_count"]').selectOption("3");
  await create.locator('[name="pickup_status"][value="yes"]').check();
  await create.locator('[name="pickup_count"]').selectOption("2");
  await create.getByRole("button",{name:"建立協助登記"}).click();
  await expect.poll(()=>creates.length).toBe(1);
  expect(creates[0]).toMatchObject({meal_identity:"child",hosting:{status:"hosting",guest_count:3},pickup:{status:"yes",count:2}});
});

test("saved survey validity from the server overrides the page's old assumptions",async ({page})=>{
  await publicPage(page);
  await page.route("**/functions/v1/registration",route=>{
    if(route.request().method()==="GET")return route.fallback();
    const body=route.request().postDataJSON();
    if(body.action!=="update")return route.fallback();
    return route.fulfill({json:{success:true,surveys:{hosting:{status:"hosting",guest_type:"any",guest_count:2,answer_valid:false},pickup:{status:"yes",count:3,answer_valid:false}}}});
  });
  await lookup(page); await page.locator("#start-edit").click();
  await page.locator('#edit-form [name="activity_1"][value="false"]').check();
  await page.locator("#save-edit").click();
  await expect(page.locator("#edit-pickup")).toContainText("須重新回答");
  await page.locator("#start-edit").click();
  await expect(page.locator('#edit-pickup [name="pickup_status"]:checked')).toHaveCount(0);
});

test("a settings change removing eligibility keeps valid history without sending an identity reset",async ({page})=>{
  const data=reference(),writes=[];
  await publicPage(page,data,record());
  await page.route("**/functions/v1/registration",route=>{
    if(route.request().method()==="GET")return route.fallback();
    const body=route.request().postDataJSON();
    if(body.action!=="update")return route.fallback();
    writes.push(body);
    if(writes.length===1)return route.fulfill({status:409,json:{code:"PICKUP_NOT_ALLOWED",error:"目前未開放",
      survey_settings:{...data.settings,pickup_identity_codes:["student"]}}});
    return route.fulfill({json:{success:true}});
  });
  await lookup(page); await page.locator("#start-edit").click();
  await page.locator('#edit-form [name="activity_1"][value="false"]').check();
  await page.locator('#edit-pickup [name="pickup_count"]').selectOption("4");
  await page.locator("#save-edit").click();
  await expect(page.locator("#edit-pickup")).toContainText("目前此身分未開放修改");
  await expect(page.locator("#edit-pickup")).toContainText("3 位");
  await page.locator("#save-edit").click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[1]).not.toHaveProperty("pickup");
  await expect(page.locator("#edit-pickup")).not.toContainText("須重新回答");
});

test("a settings change during an edit reveals the newly required independent survey",async ({page})=>{
  const data=reference();
  data.settings.pickup_identity_codes=["general"];
  await publicPage(page,data,record({meal_identity:"student",hosting:null,pickup:null}));
  const writes=[];
  await page.route("**/functions/v1/registration",route=>{
    if(route.request().method()==="GET")return route.fallback();
    const body=route.request().postDataJSON();
    if(body.action!=="update")return route.fallback();
    writes.push(body);
    if(writes.length===1)return route.fulfill({status:409,json:{code:"PICKUP_REQUIRED",error:"請回答接機",
      survey_settings:{...data.settings,pickup_identity_codes:["general","student"]}}});
    return route.fulfill({json:{success:true}});
  });
  await lookup(page); await page.locator("#start-edit").click();
  await page.locator('#edit-form [name="activity_1"][value="false"]').check();
  await page.locator("#save-edit").click();
  await expect(page.locator('#edit-pickup [name="pickup_status"]').first()).toBeVisible();
  await expect(page.locator('#edit-hosting [name="hosting_status"]')).toHaveCount(0);
  await page.locator('#edit-pickup [name="pickup_status"][value="no"]').check();
  await page.locator("#save-edit").click();
  await expect.poll(()=>writes.length).toBe(2);
  expect(writes[1].pickup).toEqual({status:"no",count:0});
});
