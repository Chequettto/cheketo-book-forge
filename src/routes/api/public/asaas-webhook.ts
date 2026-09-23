import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const CONFIRMED = new Set([
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_RECEIVED_IN_CASH",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
]);

export const Route = createFileRoute("/api/public/asaas-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["ASAAS_WEBHOOK_TOKEN"];
        const received = request.headers.get("asaas-access-token");
        if (!expected || received !== expected) {
          return new Response("Invalid token", { status: 401 });
        }

        const body = (await request.json()) as {
          event?: string;
          payment?: {
            id?: string;
            subscription?: string;
            externalReference?: string;
            status?: string;
          };
        };

        const event = body.event ?? "";
        const payment = body.payment;
        if (!payment) return new Response("ok");

        // Localiza a cobrança: referência externa, id do pagamento ou assinatura.
        let query = supabaseAdmin.from("payments").select("id, user_id, ebook_id, plan").limit(1);
        if (payment.externalReference) query = query.eq("id", payment.externalReference);
        else if (payment.id) query = query.eq("asaas_payment_id", payment.id);
        else if (payment.subscription) query = query.eq("asaas_subscription_id", payment.subscription);

        const { data: rows } = await query;
        const row = rows?.[0];
        if (!row) return new Response("ok");

        const confirmed = CONFIRMED.has(event);
        await supabaseAdmin
          .from("payments")
          .update({
            status: confirmed ? "CONFIRMED" : (payment.status ?? event),
            asaas_payment_id: payment.id ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);

        if (confirmed) {
          const expires = new Date();
          expires.setMonth(expires.getMonth() + 1);
          await supabaseAdmin
            .from("profiles")
            .update({
              plan: row.plan,
              plan_expires_at: row.plan === "monthly" ? expires.toISOString() : null,
            })
            .eq("id", row.user_id);

          if (row.ebook_id) {
            await supabaseAdmin.from("ebooks").update({ paid: true }).eq("id", row.ebook_id);
          }
        }

        return new Response("ok");
      },
    },
  },
});
