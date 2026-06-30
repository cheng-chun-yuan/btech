import { describe, it, expect } from "vitest";
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from "nostr-tools";
import { LocalKeySigner, personaSecret } from "./nostr-signer";

describe("LocalKeySigner", () => {
  it("round-trips a NIP-44 message between two parties", async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const npubA = nip19.npubEncode(getPublicKey(skA));
    const npubB = nip19.npubEncode(getPublicKey(skB));
    const alice = new LocalKeySigner(skA);
    const bob = new LocalKeySigner(skB);

    const ct = await alice.encrypt(npubB, "hello bob");
    expect(ct).not.toContain("hello bob"); // ciphertext, not plaintext
    expect(await bob.decrypt(npubA, ct)).toBe("hello bob"); // symmetric conversation key
  });

  it("rejects a non-npub counterparty", async () => {
    const alice = new LocalKeySigner(generateSecretKey());
    await expect(alice.encrypt("not-an-npub", "x")).rejects.toThrow();
  });
});

describe("personaSecret", () => {
  it("is deterministic and 32 bytes (mirrors the server derivation)", async () => {
    const a = await personaSecret(1);
    const b = await personaSecret(1);
    expect(a.length).toBe(32);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(await personaSecret(2)).toString("hex")).not.toBe(
      Buffer.from(a).toString("hex"),
    );
  });
});

describe("LocalKeySigner.signEvent", () => {
  it("produces a verifiable event whose pubkey matches the key", async () => {
    const sk = generateSecretKey();
    const signer = new LocalKeySigner(sk);
    const ev = await signer.signEvent({
      kind: 23333,
      created_at: 1700000000,
      tags: [["t", "chat1"], ["chat", "dm"]],
      content: "hello",
    });
    expect(verifyEvent(ev)).toBe(true);
    expect(ev.pubkey).toBe(getPublicKey(sk));
    expect(ev.kind).toBe(23333);
  });
});
