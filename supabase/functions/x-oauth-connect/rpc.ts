import { BrandContextError } from "../_shared/brand/brand_context.ts";

export async function rpc(
  url: string,
  key: string,
  name: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new BrandContextError("OAUTH_CONNECTION_DB_WRITE_FAILED");
  if (response.status === 204 || response.status === 205) return null;

  const responseBody = await response.text();
  if (responseBody.trim() === "") return null;
  return JSON.parse(responseBody) as unknown;
}
