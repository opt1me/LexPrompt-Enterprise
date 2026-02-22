import { createClient, SupabaseClient } from "@supabase/supabase-js";

export type AuthUser = {
  uid: string;
  email: string;
  role: "admin" | "user";
};

let client: SupabaseClient | null = null;

const getUrl = () => (import.meta as any).env?.VITE_SUPABASE_URL || (import.meta as any).env?.NEXT_PUBLIC_SUPABASE_URL;
const getAnonKey = () => (import.meta as any).env?.VITE_SUPABASE_ANON_KEY || (import.meta as any).env?.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const isSupabaseAuthEnabled = (): boolean => {
  return Boolean(getUrl() && getAnonKey());
};

export const isDemoAuthEnabled = (): boolean => {
  const v = String((import.meta as any).env?.VITE_ENABLE_DEMO_AUTH ?? "false").toLowerCase();
  return v === "true";
};

export const getSupabaseClient = (): SupabaseClient | null => {
  if (!isSupabaseAuthEnabled()) return null;
  if (!client) {
    client = createClient(getUrl(), getAnonKey(), {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return client;
};

const toAuthUser = (email: string): AuthUser => ({
  uid: email.toLowerCase(),
  email: email.toLowerCase(),
  role: "admin",
});

export const getCurrentAuthUser = async (): Promise<AuthUser | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  const email = data.user?.email;
  return email ? toAuthUser(email) : null;
};

export const onAuthStateChanged = (callback: (user: AuthUser | null) => void): (() => void) => {
  const supabase = getSupabaseClient();
  if (!supabase) return () => {};
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    const email = session?.user?.email || null;
    callback(email ? toAuthUser(email) : null);
  });
  return () => {
    data.subscription.unsubscribe();
  };
};

export const sendMagicLink = async (email: string): Promise<void> => {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase auth is not configured");
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOtp({
    email: email.toLowerCase(),
    options: { emailRedirectTo: redirectTo },
  });
  if (error) throw error;
};

export const signOutAuth = async (): Promise<void> => {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
};

export const getAccessToken = async (): Promise<string | null> => {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.access_token || null;
};
