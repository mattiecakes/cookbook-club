// Cookbook Club, hosted version.
// The app (index.html) was written for claude.ai, where it asks the page for
// claude.use("db" | "user" | "sample"). This file provides the same three
// things on top of Supabase, so the app code runs unchanged:
//   db     -> the `docs` table, one row per document, kept live with Realtime
//   user   -> the signed-in person's membership in a household
//   sample -> the `read-photo` Edge Function, which asks Claude to read photos
(() => {
  const SB_URL = "https://vdcvbtpikgcjfsuhxuyw.supabase.co";
  const SB_KEY = "sb_publishable_1jBMbLTfrHax70HZv0E-Lw_Z039fpS7"; // publishable: safe in the browser
  const sb = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const lastSeg = p => p.slice(p.lastIndexOf("/") + 1);
  const parentOf = p => p.slice(0, p.lastIndexOf("/"));
  const err = (message, code) => Object.assign(new Error(message), { code });

  // ---------- sign-in gate ----------
  let gate;
  function gateHTML(inner) {
    if (!gate) {
      gate = document.createElement("div");
      gate.id = "ccgate";
      gate.style.cssText = "position:fixed;inset:0;z-index:9999;background:var(--paper,#fff);color:var(--ink,#111);display:flex;align-items:center;justify-content:center;padding:24px;font-family:var(--sans,system-ui)";
      document.body.appendChild(gate);
    }
    gate.innerHTML = `<div style="max-width:360px;width:100%">
      <div style="font-family:Anton,Impact,sans-serif;font-size:44px;line-height:.95;text-transform:uppercase;margin-bottom:18px">Cookbook<br>Club</div>${inner}</div>`;
    return gate;
  }
  const closeGate = () => { gate?.remove(); gate = null; };

  function askEmail(note = "") {
    return new Promise(() => {
      const g = gateHTML(`<p style="margin:0 0 14px">Sign in with the email address you were invited with. We'll email you a link.</p>
        <form id="ccform"><input id="ccemail" type="email" required autocomplete="email" placeholder="you@example.com"
          style="width:100%;font:inherit;font-size:17px;padding:12px;border:2px solid var(--ink,#111);border-radius:0;background:transparent;color:inherit">
        <button style="margin-top:12px;width:100%;font:inherit;font-weight:700;font-size:16px;padding:12px;border:0;background:var(--hot,#ff876d);color:var(--on-hot,#111);cursor:pointer">Email me a sign-in link</button></form>
        <p id="ccmsg" style="min-height:1.4em;margin-top:12px;color:var(--ink2,#555)">${esc(note)}</p>`);
      g.querySelector("#ccform").onsubmit = async e => {
        e.preventDefault();
        const email = g.querySelector("#ccemail").value.trim().toLowerCase();
        const msg = g.querySelector("#ccmsg"); msg.textContent = "Sending…";
        const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
        msg.textContent = error ? `Couldn't send the link: ${error.message}` : `Check ${email} for a link from Cookbook Club. You can close this tab.`;
      };
    });
  }

  async function signOut() { await sb.auth.signOut(); try { localStorage.removeItem("cc-hid"); } catch {} location.reload(); }

  let ctx; // { session, email, memberships, households, hid, me }
  const ready = (async () => {
    let { data: { session } } = await sb.auth.getSession();
    if (!session) { await askEmail(); return null; } // waits forever; the emailed link reloads the page signed in
    const { data: mems, error } = await sb.rpc("claim_invites");
    if (error) { gateHTML(`<p>Couldn't load your household: ${esc(error.message)}</p><p><a href="#" id="ccout">Sign out</a></p>`); gate.querySelector("#ccout").onclick = e => { e.preventDefault(); signOut(); }; return new Promise(() => {}); }
    if (!mems?.length) {
      gateHTML(`<p><strong>${esc(session.user.email)}</strong> isn't on the guest list yet.</p><p>Ask Josh to add this address, or sign in with a different one.</p>
        <button id="ccout" style="font:inherit;padding:10px 14px;border:2px solid currentColor;background:none;color:inherit;cursor:pointer">Use a different email</button>`);
      gate.querySelector("#ccout").onclick = signOut;
      return new Promise(() => {});
    }
    const { data: hh } = await sb.from("households").select("id,name");
    let hid = null; try { hid = localStorage.getItem("cc-hid"); } catch {}
    if (!mems.some(m => m.household_id === hid)) hid = (mems.find(m => m.role === "owner") || mems[0]).household_id;
    const me = mems.find(m => m.household_id === hid);
    ctx = { session, email: session.user.email, memberships: mems, households: hh || [], hid, me };
    sb.auth.onAuthStateChange((ev, s) => { if (ev === "SIGNED_OUT") location.reload(); if (s) ctx.session = s; });
    closeGate();
    return ctx;
  })();

  // ---------- db: Firestore-shaped API over the docs table ----------
  function makeDb() {
    const { hid } = ctx;
    const cache = new Map();            // path -> data
    const docSubs = new Map();          // path -> Set(cb)
    const colSubs = new Map();          // collection path -> Set(cb)
    const loaded = new Set();           // collection paths fully fetched

    const docSnap = p => ({ id: lastSeg(p), exists: cache.has(p), data: () => clone(cache.get(p)) });
    const colSnap = c => {
      const docs = [];
      for (const p of cache.keys()) if (parentOf(p) === c) docs.push(docSnap(p));
      return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } };
    };
    function notify(p) {
      docSubs.get(p)?.forEach(cb => { try { cb(docSnap(p)); } catch (e) { console.error(e); } });
      const c = parentOf(p);
      if (loaded.has(c)) colSubs.get(c)?.forEach(cb => { try { cb(colSnap(c)); } catch (e) { console.error(e); } });
    }

    // live updates from everyone in the household
    sb.channel("docs-" + hid)
      .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: `household_id=eq.${hid}` }, ch => {
        if (ch.eventType === "DELETE") { const p = ch.old?.path; if (p && cache.has(p)) { cache.delete(p); notify(p); } return; }
        const row = ch.new; if (!row?.path) return;
        if (JSON.stringify(cache.get(row.path)) === JSON.stringify(row.data)) return;
        cache.set(row.path, row.data); notify(row.path);
      })
      .subscribe();

    async function fetchCollection(c) {
      const depth = c.split("/").length + 1, out = [];
      for (let from = 0; ; from += 500) {
        const { data, error } = await sb.from("docs").select("path,data").eq("household_id", hid).like("path", c + "/%").order("path").range(from, from + 499);
        if (error) throw err(error.message, "unavailable");
        out.push(...data); if (data.length < 500) break;
      }
      for (const r of out) if (r.path.split("/").length === depth) cache.set(r.path, r.data);
      loaded.add(c);
    }
    async function fetchDoc(p) {
      const { data, error } = await sb.from("docs").select("data").eq("household_id", hid).eq("path", p).maybeSingle();
      if (error) throw err(error.message, "unavailable");
      if (data) cache.set(p, data.data); else cache.delete(p);
    }
    const randomId = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (const n of r) s += a[n % 36]; return s; };

    function doc(p) {
      return {
        id: lastSeg(p), path: p,
        async get() { if (!cache.has(p) && !loaded.has(parentOf(p))) await fetchDoc(p); return docSnap(p); },
        async set(data) {
          const prev = cache.has(p) ? cache.get(p) : undefined;
          cache.set(p, clone(data)); notify(p);
          const { error } = await sb.from("docs").upsert({ household_id: hid, path: p, data, updated_at: new Date().toISOString() });
          if (error) { if (prev === undefined) cache.delete(p); else cache.set(p, prev); notify(p); throw err(error.message, /row-level security/i.test(error.message) ? "permission_denied" : "unavailable"); }
        },
        async delete() {
          const prev = cache.get(p); cache.delete(p); notify(p);
          const { error } = await sb.from("docs").delete().eq("household_id", hid).eq("path", p);
          if (error) { if (prev !== undefined) { cache.set(p, prev); notify(p); } throw err(error.message, "unavailable"); }
        },
        onSnapshot(cb, onErr) {
          if (!docSubs.has(p)) docSubs.set(p, new Set());
          docSubs.get(p).add(cb);
          (cache.has(p) || loaded.has(parentOf(p)) ? Promise.resolve() : fetchDoc(p)).then(() => cb(docSnap(p)), e => onErr?.(e));
          return () => docSubs.get(p)?.delete(cb);
        },
      };
    }
    function collection(c) {
      return {
        id: lastSeg(c), path: c,
        doc: id => doc(c + "/" + (id || randomId())),
        onSnapshot(cb, onErr) {
          if (!colSubs.has(c)) colSubs.set(c, new Set());
          colSubs.get(c).add(cb);
          (loaded.has(c) ? Promise.resolve() : fetchCollection(c)).then(() => cb(colSnap(c)), e => onErr?.(e));
          return () => colSubs.get(c)?.delete(cb);
        },
      };
    }
    return { doc, collection };
  }

  // ---------- user ----------
  function makeUser() {
    const { me, hid } = ctx;
    return {
      id: async () => me.member_key,
      isOwner: async () => me.role === "owner",
      can: async () => true,
      async profiles(keys) {
        const { data } = await sb.from("memberships").select("member_key,display_name").eq("household_id", hid).in("member_key", keys);
        return Object.fromEntries((data || []).map(m => [m.member_key, { name: m.display_name }]));
      },
    };
  }

  // ---------- sample: photo reading through the read-photo function ----------
  async function toJpeg(file) {
    const MAX = 1568; // Claude's sweet spot for image size
    let src;
    try { src = await createImageBitmap(file); }
    catch {
      src = await new Promise((ok, bad) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => bad(err("Can't open that photo format. Try a JPEG or PNG.", "bad_image")); img.src = URL.createObjectURL(file); });
    }
    const w = src.width, h = src.height, k = Math.min(1, MAX / Math.max(w, h));
    const cv = document.createElement("canvas"); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    cv.getContext("2d").drawImage(src, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL("image/jpeg", 0.86);
    return { media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
  }
  function makeSample() {
    return {
      limits: async () => ({ images: { maxCount: 4, mediaTypes: ["image/*"] } }),
      async json(prompt, { images = [], signal } = {}) {
        const imgs = [];
        for (const f of images.slice(0, 4)) imgs.push(typeof f === "string" && f.startsWith("data:") ? { media_type: f.slice(5, f.indexOf(";")), data: f.slice(f.indexOf(",") + 1) } : await toJpeg(f));
        const { data: { session } } = await sb.auth.getSession();
        const r = await fetch(`${SB_URL}/functions/v1/read-photo`, {
          method: "POST", signal,
          headers: { Authorization: `Bearer ${session?.access_token || ""}`, apikey: SB_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt, images: imgs }),
        });
        const out = await r.json().catch(() => ({}));
        if (!r.ok || !("json" in out)) throw err(out.error || `Photo reader error (${r.status})`, out.code || "upstream");
        return out.json;
      },
    };
  }

  // ---------- what claude.use() hands the app ----------
  let dbObj;
  window.claude = {
    async use(cap) {
      const c = await ready;
      if (!c) return new Promise(() => {});
      if (cap === "db") return (dbObj ||= makeDb());
      if (cap === "user") return makeUser();
      if (cap === "sample") return makeSample();
      throw err("Not available here", "not_granted");
    },
  };

  // ---------- Settings: account, household, moving data in ----------
  async function importBackup(text, say) {
    let b; try { b = JSON.parse(text); } catch { say("That doesn't look like the copied text. Copy it again from the old version."); return; }
    if (b?.v !== 1 || !b.books) { say("That doesn't look like the copied text."); return; }
    const { hid, me } = ctx, rows = [];
    const add = (path, data) => data && rows.push({ household_id: hid, path, data });
    for (const [id, d] of Object.entries(b.books)) add("books/" + id, d);
    for (const [id, d] of Object.entries(b.covers || {})) add("covers/" + id, d);
    for (const [wk, d] of Object.entries(b.plan || {})) add("plan/" + wk, d);
    if (b.quick) add("meta/plan", { quick: b.quick, updatedAt: Date.now() });
    if (b.notes && Object.keys(b.notes).length) add(`data/users/${me.member_key}/notes`, { r: b.notes });
    if (b.recent?.length) add(`data/users/${me.member_key}/recent`, { v: b.recent });
    for (const [id, d] of Object.entries(b.photos || {})) add("photos/" + id, d);
    let done = 0;
    while (done < rows.length) {
      let size = 0, batch = [];
      while (done + batch.length < rows.length && batch.length < 50) { const r = rows[done + batch.length]; size += JSON.stringify(r.data).length; if (batch.length && size > 900000) break; batch.push(r); }
      const { error } = await sb.from("docs").upsert(batch);
      if (error) { say(`Stopped after ${done} of ${rows.length}: ${error.message}`); return; }
      done += batch.length; say(`Copied ${done} of ${rows.length}…`);
    }
    say(`Done: ${Object.keys(b.books).length} books and everything with them. Reloading…`);
    setTimeout(() => location.reload(), 1200);
  }

  window.ccPort = {
    settingsHTML() {
      if (!ctx) return "";
      const { email, memberships, households, hid, me } = ctx;
      const name = id => households.find(h => h.id === id)?.name || "Household";
      const picker = memberships.length > 1 ? `<div class="seg" style="max-width:none">${memberships.map(m => `<button type="button" data-cchh="${m.household_id}" aria-pressed="${m.household_id === hid}">${esc(name(m.household_id))}</button>`).join("")}</div>` : "";
      const importer = me.role === "owner" ? `<section><h3>Bring in from the old version</h3>
          <p class="note">In the claude.ai version, open Settings, tap Gather everything, then Copy. Paste it here. Anything with the same name is replaced; nothing else is touched.</p>
          <textarea id="ccimport" rows="4" style="width:100%;font:12px var(--mono)" placeholder="Paste here"></textarea>
          <div class="actions"><button class="btn" id="ccimportbtn">Bring it in</button></div><p class="note" id="ccimportst"></p></section>` : "";
      return `<section><h3>Account</h3>
          <p class="note">Signed in as <strong>${esc(email)}</strong>${memberships.length > 1 ? "" : ` · ${esc(name(hid))}`}</p>
          ${picker}
          <div class="actions"><button class="btn ghost" id="ccsignout">Sign out</button></div></section>${importer}`;
    },
    wire(root) {
      root.querySelector("#ccsignout")?.addEventListener("click", signOut);
      root.querySelectorAll("[data-cchh]").forEach(b => b.addEventListener("click", () => { try { localStorage.setItem("cc-hid", b.dataset.cchh); } catch {} location.reload(); }));
      const btn = root.querySelector("#ccimportbtn");
      if (btn) btn.addEventListener("click", () => { const st = root.querySelector("#ccimportst"); btn.disabled = true; importBackup(root.querySelector("#ccimport").value, t => (st.textContent = t)).finally(() => (btn.disabled = false)); });
    },
  };
})();
