"use client";

import { useFormStatus } from "react-dom";
import { selectAdminBrand } from "@/lib/actions/select-brand";

type BrandOption = { id: string; label: string };

function PendingLabel() {
  const { pending } = useFormStatus();
  return pending ? <span className="brand-selector-pending">切替中…</span> : null;
}

// Only ever submits a brand id to selectAdminBrand; which brands are listed, and whether a submitted id
// is honored, are both decided server-side. The options passed in are already filtered to brands this
// admin is authorized for.
export function BrandSelector({
  activeBrandId,
  options,
}: {
  activeBrandId: string;
  options: BrandOption[];
}) {
  if (options.length <= 1) {
    return (
      <span className="brand-selector brand-selector-single" aria-label="対象ブランド">
        {options[0]?.label ?? ""}
      </span>
    );
  }

  return (
    <form className="brand-selector" action={selectAdminBrand}>
      <label htmlFor="brand-selector-select">対象ブランド</label>
      <select
        // Remount when the server-resolved active brand changes, so this uncontrolled select never keeps
        // showing a value the server did not actually honor (e.g. after a rejected selection).
        key={activeBrandId}
        id="brand-selector-select"
        name="brand_id"
        defaultValue={activeBrandId}
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      <noscript>
        <button type="submit">切替</button>
      </noscript>
      <PendingLabel />
    </form>
  );
}
