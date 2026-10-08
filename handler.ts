// deno-lint-ignore-file no-explicit-any
// OSU Advanced co-op backend. Runs as a Supabase Edge Function, so every credential stays server-side.
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", TTL = 3 * 3600e3;
const EXT = /^(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)$/;
const KINDS = new Set(["hello", "room", "full", "ready", "start", "n", "end", "leave"]);
const HOST_ONLY = new Set(["room", "start", "full"]);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-host-token,authorization,apikey,x-client-info",
  "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
};
const J = (o: any, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });
const NC = () => new Response(null, { status: 204, headers: CORS });
const rnd = (n: number, a = ALPHA) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => a[b % a.length]).join("");

export function makeHandler(sb: any, bucket = "osu-temp-music") {
  const store = () => sb.storage.from(bucket);
  async function sweep() { // delete rooms (and songs) older than 3 hours
    const old = new Date(Date.now() - TTL).toISOString();
    const { data } = await sb.from("osu_coop_rooms").select("code,path").lt("created_at", old);
    if (data && data.length) {
      await store().remove(data.map((r: any) => r.path));
      for (const r of data) await sb.from("osu_coop_rooms").delete().eq("code", r.code);
    }
  }
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return NC();
    try {
      const u = new URL(req.url), m = req.method;
      const p = u.pathname.replace(/^\/(functions\/v1\/)?coop/, "") || "/";
      if (p === "/time") return J({ t: Date.now() });

      if (p === "/rooms" && m === "POST") {
        const b: any = await req.json().catch(() => null);
        const name = String(b?.name || "song.mp3"), ext = (name.split(".").pop() || "").toLowerCase();
        if (!EXT.test(ext)) return J({ error: "Pick an audio file (mp3, ogg, wav, m4a, aac or flac)." }, 400);
        const type = /^(audio\/|video\/webm)/.test(String(b?.type)) ? String(b.type) : "audio/mpeg";
        try { await sweep(); } catch (_) { /* cleanup is best-effort */ }
        let code = "", token = "", path = "", ok = false;
        for (let i = 0; i < 6 && !ok; i++) {
          code = rnd(6); token = rnd(32, "0123456789abcdef"); path = `${code}/${rnd(8, "abcdefghjkmnpqrstuvwxyz23456789")}.${ext}`;
          ok = !(await sb.from("osu_coop_rooms").insert({ code, path, type, token })).error;
        }
        if (!ok) return J({ error: "Could not create a room. Try again." }, 500);
        const up = await store().createSignedUploadUrl(path);
        if (up.error) { await sb.from("osu_coop_rooms").delete().eq("code", code); return J({ error: "Storage is not ready: " + up.error.message }, 502); }
        return J({ code, token, uploadUrl: up.data.signedUrl });
      }

      const x = p.match(/^\/rooms\/([A-Z0-9]{6})(\/[a-z]+)?$/);
      if (!x) return J({ error: "Not found." }, 404);
      const code = x[1], sub = x[2] || "";
      const { data: room } = await sb.from("osu_coop_rooms").select("*").eq("code", code).maybeSingle();
      if (!room || Date.now() - new Date(room.created_at).getTime() > TTL) return J({ error: "No room with that code." }, 404);

      if (sub === "" && m === "GET") return J({ ok: true });
      if (sub === "" && m === "DELETE") {
        if (req.headers.get("x-host-token") !== room.token) return J({ error: "Host only." }, 403);
        await store().remove([room.path]);
        await sb.from("osu_coop_rooms").delete().eq("code", code); // messages are removed by cascade
        return NC();
      }
      if (sub === "/song" && m === "GET") {
        const s = await store().createSignedUrl(room.path, 3600);
        return s.error ? J({ error: "Could not prepare the song." }, 502) : J({ url: s.data.signedUrl });
      }
      if (sub === "/msg" && m === "POST") {
        const b: any = await req.json().catch(() => null), id = String(b?.id || "").slice(0, 40), msg = b?.msg;
        if (!id || !msg || !KINDS.has(msg.k) || JSON.stringify(msg).length > 250000) return J({ error: "Bad message." }, 400);
        if (HOST_ONLY.has(msg.k) && req.headers.get("x-host-token") !== room.token) return J({ error: "Host only." }, 403);
        const r = await sb.from("osu_coop_msgs").insert({ code, from_id: id, msg });
        return r.error ? J({ error: "Could not send." }, 500) : NC();
      }
      if (sub === "/poll" && m === "GET") {
        const id = (u.searchParams.get("id") || "").slice(0, 40), af = u.searchParams.get("after");
        if (af === null) { // first call: just learn where the log currently ends
          const { data } = await sb.from("osu_coop_msgs").select("id").eq("code", code).order("id", { ascending: false }).limit(1);
          return J({ last: data && data[0] ? data[0].id : 0, msgs: [] });
        }
        const after = Number(af) || 0;
        const { data } = await sb.from("osu_coop_msgs").select("id,from_id,msg").eq("code", code).gt("id", after).neq("from_id", id).order("id", { ascending: true }).limit(100);
        const rows = data || [];
        return J({ last: rows.length ? rows[rows.length - 1].id : after, msgs: rows.map((r: any) => ({ i: r.id, f: r.from_id, m: r.msg })) });
      }
      return J({ error: "Not found." }, 404);
    } catch (_e) {
      return J({ error: "Server error." }, 500);
    }
  };
}
