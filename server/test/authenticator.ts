import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

const UP = 0x01, UV = 0x04, AT = 0x40;

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) (out.set(p, i), (i += p.length));
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));
const b64 = (b: Uint8Array) => isoBase64URL.fromBuffer(b as Uint8Array<ArrayBuffer>);
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// WebCrypto signs ECDSA as raw r||s; WebAuthn carries an ASN.1 DER SEQUENCE of two INTEGERs.
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (x: Uint8Array) => {
    let i = 0;
    while (i < x.length - 1 && x[i] === 0) i++;
    x = x.slice(i);
    if (x[0] & 0x80) x = concat(new Uint8Array([0]), x);
    return concat(new Uint8Array([0x02, x.length]), x);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** In-memory ES256 platform authenticator with "none" attestation, for driving the passkey routes in tests. */
export class SoftAuthenticator {
  private counter = 0;
  private constructor(private keys: CryptoKeyPair, readonly id: Uint8Array) {}

  static async create(): Promise<SoftAuthenticator> {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    return new SoftAuthenticator(keys, crypto.getRandomValues(new Uint8Array(16)));
  }

  private clientData(type: string, challenge: string, origin: string) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  async register(options: PublicKeyCredentialCreationOptionsJSON, origin: string): Promise<RegistrationResponseJSON> {
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", this.keys.publicKey)) as ArrayBuffer);
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, raw.slice(1, 33)], [-3, raw.slice(33)]]));
    const authData = concat(
      await sha256(new TextEncoder().encode(options.rp.id)),
      new Uint8Array([UP | UV | AT]),
      u32(this.counter),
      new Uint8Array(16), // aaguid
      new Uint8Array([0, this.id.length]),
      this.id,
      cose,
    );
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(this.clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  async login(options: PublicKeyCredentialRequestOptionsJSON, origin: string): Promise<AuthenticationResponseJSON> {
    this.counter++;
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const authData = concat(await sha256(new TextEncoder().encode(options.rpId!)), new Uint8Array([UP | UV]), u32(this.counter));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, concat(authData, await sha256(clientDataJSON)));
    return {
      id: b64(this.id),
      rawId: b64(this.id),
      type: "public-key",
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authData),
        signature: b64(rawToDer(new Uint8Array(sig))),
        userHandle: b64(new TextEncoder().encode("owner")),
      },
      clientExtensionResults: {},
    };
  }
}
