// Rock Hard Marketing Calendar — save/load API.
// Stores each calendar entry as its own blob in this Netlify site (Netlify Blobs).
import { getStore } from "@netlify/blobs";

const ID = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export default async (req) => {
  const store = getStore({ name: "rh-calendar", consistency: "strong" });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const currentRev = async () => (await store.get("meta/rev")) || "0";
  const bump = async () => {
    const rev = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await store.set("meta/rev", rev);
    return rev;
  };

  try {
    if (path === "/api/rev" && req.method === "GET") {
      return json({ rev: await currentRev() });
    }

    if (path === "/api/items" && req.method === "GET") {
      const { blobs } = await store.list({ prefix: "items/" });
      const items = {};
      await Promise.all(
        blobs.map(async (b) => {
          const v = await store.get(b.key, { type: "json" });
          if (v) items[b.key.slice("items/".length)] = v;
        })
      );
      return json({ items, rev: await currentRev(), seeded: !!(await store.get("meta/seeded")) });
    }

    const m = path.match(/^\/api\/items\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (!ID.test(id)) return json({ error: "bad id" }, 400);
      if (req.method === "PUT") {
        const text = await req.text();
        if (text.length > 300000) return json({ error: "entry too large" }, 413);
        let v;
        try { v = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
        if (!v || typeof v !== "object" || Array.isArray(v)) return json({ error: "bad entry" }, 400);
        await store.setJSON("items/" + id, v);
        return json({ ok: true, rev: await bump() });
      }
      if (req.method === "DELETE") {
        const cur = await store.get("items/" + id, { type: "json" });
        if (cur) await store.setJSON("trash/" + id + "@" + Date.now(), cur);
        await store.delete("items/" + id);
        return json({ ok: true, rev: await bump() });
      }
    }

    if (path === "/api/import" && req.method === "POST") {
      const text = await req.text();
      if (text.length > 8_000_000) return json({ error: "file too large" }, 413);
      let body;
      try { body = JSON.parse(text); } catch { return json({ error: "bad json" }, 400); }
      const items = body && body.items && typeof body.items === "object" && !Array.isArray(body.items) ? body.items : {};
      const patches = body && body.patches && typeof body.patches === "object" && !Array.isArray(body.patches) ? body.patches : {};
      const deletes = body && Array.isArray(body.deletes) ? body.deletes : [];
      const batch = body && typeof body.batch === "string" && ID.test(body.batch) ? body.batch : null;
      if (!Object.keys(items).length && !Object.keys(patches).length && !deletes.length) return json({ error: "nothing to import" }, 400);
      if (body.onlyIfEmpty && (await store.get("meta/seeded"))) {
        return json({ ok: true, skipped: true, rev: await currentRev() });
      }
      // A batch from Claude is applied once only, so later edits on the site are never overwritten by it again.
      if (batch && (await store.get("batches/" + batch))) {
        return json({ ok: true, skipped: true, rev: await currentRev() });
      }
      let count = 0;
      for (const [id, v] of Object.entries(items)) {
        if (!ID.test(id) || !v || typeof v !== "object" || Array.isArray(v)) continue;
        const { id: _drop, ...data } = v;
        await store.setJSON("items/" + id, data);
        count++;
      }
      for (const [id, fields] of Object.entries(patches)) {
        if (!ID.test(id) || !fields || typeof fields !== "object" || Array.isArray(fields)) continue;
        const cur = await store.get("items/" + id, { type: "json" });
        if (!cur) continue;
        const next = { ...cur };
        for (const [k, val] of Object.entries(fields)) { if (val === null) delete next[k]; else next[k] = val; }
        next.updatedAt = Date.now();
        await store.setJSON("items/" + id, next);
        count++;
      }
      for (const id of deletes) {
        if (typeof id !== "string" || !ID.test(id)) continue;
        const cur = await store.get("items/" + id, { type: "json" });
        if (!cur) continue;
        await store.setJSON("trash/" + id + "@" + Date.now(), cur);
        await store.delete("items/" + id);
        count++;
      }
      if (batch) await store.set("batches/" + batch, new Date().toISOString());
      await store.set("meta/seeded", "1");
      return json({ ok: true, count, rev: await bump() });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

export const config = { path: ["/api/items", "/api/items/*", "/api/rev", "/api/import"] };
