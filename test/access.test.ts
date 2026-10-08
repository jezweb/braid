// The Access JWT check with a real RS256 key pair; only the certs endpoint is stubbed.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { accessActor } from "../src/api";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-123";
const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

let keys: CryptoKeyPair;
let jwk: JsonWebKey;
const sign = async (payload: object, header: object = { alg: "RS256", kid: "k1" }, key = keys.privateKey) => {
  const h = b64u(new TextEncoder().encode(JSON.stringify(header)));
  const p = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(sig)}`;
};
const good = () => ({ aud: [AUD], email: "jez@example.invalid", exp: Math.floor(Date.now() / 1000) + 600, iss: TEAM });
const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD } as never;

describe("Cloudflare Access JWT verification", () => {
  beforeAll(async () => {
    keys = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe(`${TEAM}/cdn-cgi/access/certs`);
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1" }] }));
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it("accepts a token Access signed for this app, whatever its base64 padding", async () => {
    for (const email of ["a@b.c", "ab@b.c", "abc@b.c"]) {
      expect(await accessActor(env, await sign({ ...good(), email }))).toBe(email);
    }
  });

  it("refuses the wrong audience, issuer, an expired token, a bad signature, another key, junk", async () => {
    expect(await accessActor(env, await sign({ ...good(), aud: ["other"] }))).toBeUndefined();
    expect(await accessActor(env, await sign({ ...good(), iss: "https://evil.cloudflareaccess.com" }))).toBeUndefined();
    expect(await accessActor(env, await sign({ ...good(), exp: 1 }))).toBeUndefined();
    const t = await sign(good());
    expect(await accessActor(env, t.slice(0, -4) + "AAAA")).toBeUndefined();
    const other = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    expect(await accessActor(env, await sign(good(), undefined, other.privateKey))).toBeUndefined();
    expect(await accessActor(env, await sign(good(), { alg: "none", kid: "k1" }))).toBeUndefined();
    expect(await accessActor(env, "not.a.jwt")).toBeUndefined();
    expect(await accessActor(env, undefined)).toBeUndefined();
  });

  it("lets only the named service token act, and only as the demo identity", async () => {
    const demoEnv = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, DEMO_SERVICE_ID: "demo-id.access", DEMO_ACTOR: "demo-person@braid.invalid" } as never;
    const service = (common_name: string) => { const { email: _, ...rest } = good() as { email?: string }; return { ...rest, common_name }; };
    expect(await accessActor(demoEnv, await sign(service("demo-id.access")))).toBe("demo-person@braid.invalid (demo)");
    expect(await accessActor(demoEnv, await sign(service("other-id.access")))).toBeUndefined();
    expect(await accessActor(env, await sign(service("demo-id.access")))).toBeUndefined(); // no DEMO_SERVICE_ID set
    expect(await accessActor(demoEnv, await sign({ ...service("demo-id.access"), aud: ["other"] }))).toBeUndefined();
  });

  it("trusts nothing when Access is not configured", async () => {
    expect(await accessActor({} as never, await sign(good()))).toBeUndefined();
  });
});
