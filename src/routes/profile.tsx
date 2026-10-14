import { PageSkeleton } from "@/components/poultrix/PageSkeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Camera, LoaderCircle, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { farm } from "@/lib/demo-data";
import { Card, PageHeader } from "@/components/poultrix/ui";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useProfile } from "@/hooks/use-profile";

export const Route = createFileRoute("/profile")({
  head: () => ({
    meta: [
      { title: "Profile — POULTRIX" },
      { name: "description", content: "Your POULTRIX account and farm access." },
      { property: "og:title", content: "Profile — POULTRIX" },
      { property: "og:description", content: "Your POULTRIX account and farm access." },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const nav = useNavigate();
  const { user, profile, avatarUrl, loading, reload } = useProfile();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setName(profile?.full_name ?? ""), [profile?.full_name]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !name.trim()) return;
    setSaving(true);
    const { error } = await supabase.from("profiles").upsert(
      { user_id: user.id, full_name: name.trim(), avatar_path: profile?.avatar_path ?? null },
      { onConflict: "user_id" },
    );
    if (error) toast.error(error.message);
    else {
      await supabase.auth.updateUser({ data: { full_name: name.trim() } });
      await reload();
      toast.success("Name updated");
    }
    setSaving(false);
  }

  async function uploadPhoto(file: File | undefined) {
    if (!user || !file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Photo must be smaller than 5 MB.");
      return;
    }
    setSaving(true);
    const extension = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `${user.id}/avatar-${Date.now()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from("profile-pictures").upload(path, file, { contentType: file.type });
    if (uploadError) {
      toast.error(uploadError.message);
      setSaving(false);
      return;
    }
    const { error } = await supabase.from("profiles").upsert(
      { user_id: user.id, full_name: name.trim() || profile?.full_name || "", avatar_path: path },
      { onConflict: "user_id" },
    );
    if (error) toast.error(error.message);
    else {
      if (profile?.avatar_path) await supabase.storage.from("profile-pictures").remove([profile.avatar_path]);
      await reload();
      toast.success("Profile photo updated");
    }
    setSaving(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    nav({ to: "/login", replace: true });
  }

  if (loading) return <PageSkeleton path="/profile" />;
  if (!user) return (
    <>
      <PageHeader title="Profile" />
      <Card className="max-w-xl text-center">
        <UserRound className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-3 text-xl font-bold">Sign in to view your profile</h2>
        <Button asChild className="mt-5"><Link to="/login">Sign in or create account</Link></Button>
      </Card>
    </>
  );

  return (
    <>
      <PageHeader title="Profile" />
      <Card className="max-w-xl">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Avatar className="h-20 w-20 border-2 border-background shadow">
              {avatarUrl && <AvatarImage src={avatarUrl} alt={profile?.full_name || "Profile photo"} className="object-cover" />}
              <AvatarFallback><UserRound className="h-8 w-8" /></AvatarFallback>
            </Avatar>
            <Button type="button" size="icon" aria-label="Change profile photo" title="Change profile photo" className="absolute -bottom-1 -right-1 rounded-full" onClick={() => fileRef.current?.click()} disabled={saving}>
              <Camera />
            </Button>
            <input ref={fileRef} className="hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => void uploadPhoto(e.target.files?.[0])} />
          </div>
          <div>
            <div className="font-display text-xl font-bold">{profile?.full_name || "Your profile"}</div>
            <div className="text-sm text-muted-foreground">Farm owner · {farm.name}</div>
            <div className="mt-1 text-xs text-muted-foreground">{user.email}</div>
          </div>
        </div>
        <form className="mt-7 space-y-3 border-t pt-6" onSubmit={saveName}>
          <Label htmlFor="profile-name">Name</Label>
          <Input id="profile-name" required value={name} onChange={(e) => setName(e.target.value)} className="h-11" />
          <Button disabled={saving || !name.trim()}>{saving ? "Saving…" : "Save name"}</Button>
        </form>
        <Button type="button" variant="outline" className="mt-6" onClick={signOut}>Sign out</Button>
      </Card>
    </>
  );
}
