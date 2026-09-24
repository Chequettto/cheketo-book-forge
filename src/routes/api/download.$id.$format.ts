import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildEpub, buildPdf } from "@/lib/ebook-build.server";

export const Route = createFileRoute("/api/download/$id/$format")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token) return new Response("Unauthorized", { status: 401 });

        const auth = createClient(
          process.env["SUPABASE_URL"]!,
          process.env["SUPABASE_PUBLISHABLE_KEY"]!,
          { auth: { persistSession: false } },
        );
        const { data: userData } = await auth.auth.getUser(token);
        const user = userData?.user;
        if (!user) return new Response("Unauthorized", { status: 401 });

        const { data: ebook } = await supabaseAdmin
          .from("ebooks")
          .select("*")
          .eq("id", params.id)
          .eq("user_id", user.id)
          .maybeSingle();
        if (!ebook) return new Response("Not found", { status: 404 });

        const { data: profile } = await supabaseAdmin
          .from("profiles")
          .select("plan, plan_expires_at")
          .eq("id", user.id)
          .maybeSingle();
        const planActive =
          profile?.plan === "lifetime" ||
          (profile?.plan === "monthly" &&
            !!profile.plan_expires_at &&
            new Date(profile.plan_expires_at) > new Date());

        // Cortesia: o primeiro e-book da conta é liberado sem pagamento.
        const { data: firstEbook } = await supabaseAdmin
          .from("ebooks")
          .select("id")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true })
          .limit(1);
        const isFirstEbook = firstEbook?.[0]?.id === ebook.id;

        if (!planActive && !ebook.paid && !isFirstEbook) {
          return new Response("Payment required", { status: 402 });
        }


        const { data: chapters } = await supabaseAdmin
          .from("chapters")
          .select("position, title, content")
          .eq("ebook_id", ebook.id)
          .order("position");

        let coverBytes: Uint8Array | null = null;
        let coverMime: string | null = null;
        if (ebook.cover_url) {
          const { data: file } = await supabaseAdmin.storage.from("covers").download(ebook.cover_url);
          if (file) {
            coverBytes = new Uint8Array(await file.arrayBuffer());
            coverMime = file.type || "image/png";
          }
        }

        const input = {
          title: ebook.title,
          subtitle: ebook.subtitle,
          author: ebook.author,
          chapters: chapters ?? [],
          coverBytes,
          coverMime,
        };

        const slug =
          ebook.title
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "ebook";

        if (params.format === "epub") {
          const bytes = buildEpub(input);
          return new Response(bytes as unknown as BodyInit, {
            headers: {
              "Content-Type": "application/epub+zip",
              "Content-Disposition": `attachment; filename="${slug}.epub"`,
            },
          });
        }

        const bytes = await buildPdf(input);
        return new Response(bytes as unknown as BodyInit, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${slug}.pdf"`,
          },
        });
      },
    },
  },
});
