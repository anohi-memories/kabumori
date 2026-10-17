import { RuntimeRefusal } from "../verified_actor.ts";
export type RuntimeConfig = Readonly<{
  projectUrl: string;
  projectRef: string;
  publishableKey: string;
  hostname: string;
  port: number;
  database: string;
  owner: string;
  password: string;
  caPem: string;
  appId: string;
  appSecret: string;
  callback: string;
  attestationKey: string;
}>;
export function validateConfig(input: RuntimeConfig): RuntimeConfig {
  try {
    const c = { ...input };
    const u = new URL(c.projectUrl);
    const r = new URL(c.callback);
    if (
      !/^[a-z0-9]{20}$/.test(c.projectRef) ||
      u.href !== `https://${c.projectRef}.supabase.co/` ||
      !/^sb_publishable_[A-Za-z0-9_-]{16,200}$/.test(c.publishableKey) ||
      c.hostname !== `db.${c.projectRef}.supabase.co` || c.port !== 5432 ||
      c.database !== "postgres" ||
      !/^[a-z][a-z0-9_]{2,62}$/.test(c.owner) ||
      [
        "postgres",
        "supabase_admin",
        "service_role",
        "authenticated",
        "anon",
        "authenticator",
      ].includes(c.owner) ||
      typeof c.password !== "string" || c.password.length < 16 ||
      c.password.length > 1024 ||
      typeof c.caPem !== "string" || c.caPem.length > 32768 ||
      !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\r\n]+\n-----END CERTIFICATE-----\s*$/
        .test(c.caPem) ||
      r.protocol !== "https:" || r.href !== c.callback || r.username ||
      r.password || r.search || r.hash ||
      ["localhost", "127.0.0.1", "[::1]"].includes(r.hostname) ||
      !/^[0-9]{1,32}$/.test(c.appId) || typeof c.appSecret !== "string" ||
      c.appSecret.length < 16 || c.appSecret.length > 4096 ||
      typeof c.attestationKey !== "string" || c.attestationKey.length < 32 ||
      c.attestationKey.length > 4096
    ) throw new Error();
    return Object.freeze(c);
  } catch {
    throw new RuntimeRefusal("CONFIG_UNAVAILABLE");
  }
}
/** Explicit operator-owned reader only; never called on import or by the hard-disabled Edge entry. */
export function readConfig(
  read: (name: string) => string | undefined,
): RuntimeConfig {
  try {
    const value = (n: string) => {
      const v = read("POSTONA_THREADS_" + n);
      if (!v) throw new Error();
      return v;
    };
    return validateConfig({
      projectUrl: value("PROJECT_URL"),
      projectRef: value("PROJECT_REF"),
      publishableKey: value("PUBLISHABLE_KEY"),
      hostname: value("DB_HOST"),
      port: Number(value("DB_PORT")),
      database: value("DB_NAME"),
      owner: value("DB_OWNER"),
      password: value("DB_PASSWORD"),
      caPem: value("DB_CA_PEM"),
      appId: value("APP_ID"),
      appSecret: value("APP_SECRET"),
      callback: value("CALLBACK"),
      attestationKey: value("ATTESTATION_KEY"),
    });
  } catch {
    throw new RuntimeRefusal("CONFIG_UNAVAILABLE");
  }
}
