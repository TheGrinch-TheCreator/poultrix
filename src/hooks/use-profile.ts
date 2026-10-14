import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type UserProfile = {
  full_name: string;
  avatar_path: string | null;
};

export function useProfile() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: userData } = await supabase.auth.getUser();
    const currentUser = userData.user;
    setUser(currentUser);

    if (!currentUser) {
      setProfile(null);
      setAvatarUrl(null);
      setLoading(false);
      return;
    }

    const fallbackName = String(currentUser.user_metadata?.["full_name"] ?? "").trim();
    const { data: saved } = await supabase
      .from("profiles")
      .select("full_name, avatar_path")
      .eq("user_id", currentUser.id)
      .maybeSingle();

    let nextProfile = saved;
    if (!nextProfile) {
      const { data: created } = await supabase
        .from("profiles")
        .upsert({ user_id: currentUser.id, full_name: fallbackName }, { onConflict: "user_id" })
        .select("full_name, avatar_path")
        .single();
      nextProfile = created;
    }

    setProfile(nextProfile ?? { full_name: fallbackName, avatar_path: null });
    if (nextProfile?.avatar_path) {
      const { data } = await supabase.storage
        .from("profile-pictures")
        .createSignedUrl(nextProfile.avatar_path, 60 * 60);
      setAvatarUrl(data?.signedUrl ?? null);
    } else {
      setAvatarUrl(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") void load();
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  return { user, profile, avatarUrl, loading, reload: load };
}