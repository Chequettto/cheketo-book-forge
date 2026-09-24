/** Integração com o gateway de pagamento Asaas. Server-only. */

export const PLANS = {
  monthly: { id: "monthly", label: "Plano Mensal", price: 99, recurring: true },
  lifetime: { id: "lifetime", label: "Plano Vitalício", price: 299, recurring: false },
} as const;

export type PlanId = keyof typeof PLANS;

function apiBase() {
  return process.env["ASAAS_BASE_URL"]?.replace(/\/$/, "") ?? "https://api.asaas.com/v3";
}

function apiKey() {
  const key = process.env["ASAAS_API_KEY"];
  if (!key) throw new Error("ASAAS_API_KEY não configurada.");
  return key;
}

async function asaasFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // O Asaas exige User-Agent em todas as requisições (erro user_agent_not_informed).
      "User-Agent": "Chequetto/1.0 (+https://cheketo-book-forge.lovable.app)",
      access_token: apiKey(),
      ...(init?.headers ?? {}),
    },

  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Asaas ${res.status}: ${text.slice(0, 400)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export async function findOrCreateCustomer(input: {
  name: string;
  email: string;
  cpfCnpj: string;
}): Promise<string> {
  const existing = await asaasFetch<{ data?: { id: string }[] }>(
    `/customers?email=${encodeURIComponent(input.email)}`,
  );
  if (existing.data?.[0]?.id) return existing.data[0].id;

  const created = await asaasFetch<{ id: string }>("/customers", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      cpfCnpj: input.cpfCnpj.replace(/\D/g, ""),
    }),
  });
  return created.id;
}

function dueDate(daysAhead = 3) {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

export async function createLifetimeCharge(input: {
  customerId: string;
  description: string;
  externalReference: string;
}) {
  const payment = await asaasFetch<{ id: string; invoiceUrl: string }>("/payments", {
    method: "POST",
    body: JSON.stringify({
      customer: input.customerId,
      billingType: "UNDEFINED",
      value: PLANS.lifetime.price,
      dueDate: dueDate(),
      description: input.description,
      externalReference: input.externalReference,
    }),
  });
  return { paymentId: payment.id, subscriptionId: null as string | null, url: payment.invoiceUrl };
}

export async function createMonthlySubscription(input: {
  customerId: string;
  description: string;
  externalReference: string;
}) {
  const subscription = await asaasFetch<{ id: string }>("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      customer: input.customerId,
      billingType: "UNDEFINED",
      value: PLANS.monthly.price,
      nextDueDate: dueDate(0),
      cycle: "MONTHLY",
      description: input.description,
      externalReference: input.externalReference,
    }),
  });

  const payments = await asaasFetch<{ data?: { id: string; invoiceUrl: string }[] }>(
    `/subscriptions/${subscription.id}/payments`,
  );
  const first = payments.data?.[0];
  return {
    paymentId: first?.id ?? null,
    subscriptionId: subscription.id,
    url: first?.invoiceUrl ?? "",
  };
}
