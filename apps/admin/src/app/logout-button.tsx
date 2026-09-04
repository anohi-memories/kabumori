"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createAdminBrowserClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogout() {
    setIsSubmitting(true);
    try {
      const supabase = createAdminBrowserClient();
      await supabase.auth.signOut();
      router.replace("/login");
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <button className="secondary-button" type="button" onClick={handleLogout} disabled={isSubmitting}>
      {isSubmitting ? "ログアウト中…" : "ログアウト"}
    </button>
  );
}
