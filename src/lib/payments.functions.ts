import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const CheckoutInput = z.object({
  ebookId: z.string().uuid(),
  plan: z.enum(["monthly", "lifetime"]),
  name: z.string().min(2),
  email: z.string().email(),
  cpfCnpj: z.string().min(11),
});

/** Cria a cobrança no Asaas e devolve o link de checkout. */
export const createCheckout = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => CheckoutInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: ebook } = await supabase
      .from("ebooks")
      .select("id, title")
      .eq("id", data.ebookId)
      .single();
    if (!ebook) throw new Error("E-book não encontrado.");

    const { PLANS, findOrCreateCustomer, createLifetimeCharge, createMonthlySubscription } =
      await import("./asaas.server");

    const plan = PLANS[data.plan];
    const customerId = await findOrCreateCustomer({
      name: data.name,
      email: data.email,
      cpfCnpj: data.cpfCnpj,
    });

    const { data: row, error } = await supabase
      .from("payments")
      .insert({
        user_id: userId,
        ebook_id: ebook.id,
        plan: plan.id,
        amount: plan.price,
        status: "PENDING",
        asaas_customer_id: customerId,
      })
      .select("id")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Falha ao registrar a cobrança.");

    const description = `Chequetto — ${plan.label} — E-book "${ebook.title}"`;
    const charge =
      data.plan === "lifetime"
        ? await createLifetimeCharge({ customerId, description, externalReference: row.id })
        : await createMonthlySubscription({ customerId, description, externalReference: row.id });

    await supabase
      .from("payments")
      .update({
        asaas_payment_id: charge.paymentId,
        asaas_subscription_id: charge.subscriptionId,
        checkout_url: charge.url,
      })
      .eq("id", row.id);

    return { paymentId: row.id, checkoutUrl: charge.url };
  });

/** Situação de acesso do usuário e do e-book. */
export const getAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ ebookId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const [{ data: profile }, { data: ebook }, { data: payments }] = await Promise.all([
      supabase.from("profiles").select("plan, plan_expires_at").eq("id", userId).maybeSingle(),
      supabase.from("ebooks").select("paid").eq("id", data.ebookId).maybeSingle(),
      supabase
        .from("payments")
        .select("status, plan, checkout_url, created_at")
        .eq("ebook_id", data.ebookId)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

    const planActive =
      profile?.plan === "lifetime" ||
      (profile?.plan === "monthly" &&
        !!profile.plan_expires_at &&
        new Date(profile.plan_expires_at) > new Date());

    return {
      plan: profile?.plan ?? "free",
      planExpiresAt: profile?.plan_expires_at ?? null,
      unlocked: planActive || ebook?.paid === true,
      lastPayment: payments?.[0] ?? null,
    };
  });
