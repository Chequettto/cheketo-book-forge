-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  full_name text,
  plan text NOT NULL DEFAULT 'free',
  plan_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- EBOOKS
CREATE TABLE public.ebooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  title text NOT NULL,
  subtitle text,
  author text NOT NULL,
  niche text NOT NULL,
  cover_prompt text,
  chapters_count int NOT NULL DEFAULT 5,
  pages_count int NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'pending',
  progress int NOT NULL DEFAULT 0,
  progress_label text,
  cover_url text,
  error text,
  paid boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ebooks TO authenticated;
GRANT ALL ON public.ebooks TO service_role;
ALTER TABLE public.ebooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own ebooks" ON public.ebooks FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE INDEX ebooks_user_idx ON public.ebooks(user_id, created_at DESC);

-- CHAPTERS
CREATE TABLE public.chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ebook_id uuid NOT NULL REFERENCES public.ebooks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  position int NOT NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  audit_report text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ebook_id, position)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chapters TO authenticated;
GRANT ALL ON public.chapters TO service_role;
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own chapters" ON public.chapters FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- PAYMENTS
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  ebook_id uuid REFERENCES public.ebooks(id) ON DELETE SET NULL,
  plan text NOT NULL,
  amount numeric(10,2) NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  asaas_customer_id text,
  asaas_payment_id text,
  asaas_subscription_id text,
  checkout_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own payments select" ON public.payments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE INDEX payments_asaas_payment_idx ON public.payments(asaas_payment_id);
CREATE INDEX payments_asaas_sub_idx ON public.payments(asaas_subscription_id);

-- API KEY ROTATION LOG
CREATE TABLE public.api_key_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_index int NOT NULL,
  ebook_id uuid,
  stage text,
  status text NOT NULL,
  message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.api_key_events TO authenticated;
GRANT ALL ON public.api_key_events TO service_role;
ALTER TABLE public.api_key_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "no direct reads" ON public.api_key_events FOR SELECT TO authenticated USING (false);
