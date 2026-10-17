import type { RuntimeConfig } from "./config.ts";
// Dummy-only construction values. This is not a trusted TLS CA or deploy configuration.
export const fakeConfig: RuntimeConfig = {
  projectRef: "a".repeat(20),
  projectUrl: `https://${"a".repeat(20)}.supabase.co/`,
  publishableKey: "sb_publishable_offline_dummy_1234567890",
  hostname: `db.${"a".repeat(20)}.supabase.co`,
  port: 5432,
  database: "postgres",
  owner: "offline_owner",
  password: "offline_dummy_password_1234567890",
  caPem:
    "-----BEGIN CERTIFICATE-----\nT0ZGTElORV9EVU1NWQ==\n-----END CERTIFICATE-----\n",
  appId: "123456",
  appSecret: "offline_dummy_app_secret_123456",
  callback: "https://postona.example/callback",
  attestationKey: "offline_dummy_attestation_" + "k".repeat(40),
};
export function check(v: unknown) {
  if (!v) throw new Error("assertion failed");
}
