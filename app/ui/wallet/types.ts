// Data model for the BTech Wallet UI. Ported from the BTech Wallet.dc.html
// design and extended with the live state returned by the real DKGKit backend.

export type KeyStatus = "online" | "reattesting" | "proposed";

export type SignerKey = {
  id: string;
  initials: string;
  name: string;
  device: string;
  status: KeyStatus;
  /** Explicit status label (overrides the default derived from `status`). */
  statusText?: string;
};

export type Tier = {
  id: string;
  name: string;
  short: string;
  minNeed: number;
  keys: SignerKey[];
};

/** A signer slot within a policy tier. `participantId` aligns with the Rust
 * signer set; `rank` mirrors the owning tier's rank for convenient flattening. */
export type PolicySigner = { participantId: number; npub: string; label: string; rank: number };

/** A grouped-threshold tier: `required`-of-`signers.length` at this `rank`. */
export type PolicyTier = {
  id: string;
  name: string;
  rank: number;
  required: number;
  signers: PolicySigner[];
};

/** The full editable vault policy (one or more tiers). */
export type PolicyConfig = { tiers: PolicyTier[] };

/** One precomputed human-readable line of a policy change. */
export type PolicyDiffItem = {
  kind: "add-signer" | "remove-signer" | "threshold" | "add-tier" | "remove-tier";
  text: string;
};

export type ChatMessage = {
  id: string;
  who: string;
  handle: string;
  initials: string;
  color: string;
  time: string;
  text: string;
  signed: boolean;
  zaps: string;
  /** Nostr pubkey (npub) of the author. Present once plumbed from the server;
   * used to open a DM with the sender. */
  authorNpub?: string;
};

export type ChatType = "channel" | "direct";

export type Chat = {
  id: string;
  type: ChatType;
  name: string;
  desc?: string;
  handle?: string;
  initials?: string;
  color?: string;
  members: number;
  balanceBtc: string;
  balanceUsd: string;
  /** When true, this vault is backed by the real DKGKit crate. */
  live?: boolean;
  /**
   * Vault provisioning state. `undefined` = chat only (no shared vault, e.g. a
   * plain DM); `"pending"` = vault created, DKG/address being provisioned;
   * `"active"` = receive address available.
   */
  vaultStatus?: "pending" | "active";
  /** Real Taproot receive address (set once the vault is provisioned). */
  receiveAddress?: string;
  /** For a `direct` chat: the other participant's npub (the member that is not
   * the current viewer). Used to derive the NIP-44 conversation key. */
  counterpartyNpub?: string;
  /** npubs of this chat's members (used to author-gate inbound relay messages). */
  memberNpubs?: string[];
  /** Monotonic version of the active policy; bumped on each applied reshare. */
  policyVersion?: number;
  /** Real group x-only public key (live vault only). */
  groupKey?: string;
  tiers: Tier[];
  messages: ChatMessage[];
};

export type ApprovalStatus = "pending" | "ready" | "broadcast" | "rejected";
export type ApprovalKind = "send" | "role";

/** One signer the proposer picked for an approval. Its participantId aligns
 * with the Rust signer_set and the `signers` table; npub gates who may sign. */
export type SelectedSigner = { participantId: number; npub: string; label: string };

export type Approval = {
  id: string;
  kind: ApprovalKind;
  title: string;
  // send fields
  dest?: string;
  destLabel?: string;
  btc?: string;
  usd?: string;
  // role fields
  changeLabel?: string;
  detail?: string;
  tier?: string;
  requestedBy?: string;
  // shared
  vault: string;
  time: string;
  policy: string;
  threshold: number;
  total: number;
  /** The exact signers the proposer assembled. Length is the threshold; all
   * must sign. Absent on legacy/no-roster approvals (existing flow applies). */
  signerSet?: SelectedSigner[];
  signed: number;
  youSigned: boolean;
  status: ApprovalStatus;
  /** Set when this approval is bound to the live DKGKit vault. */
  live?: boolean;
  /** Full destination address (not the truncated `dest`); signed into the digest.
   *  For a silent payment this is the BIP-352 `tsp1…` meta-address; the real
   *  one-time taproot output is derived from the spent inputs at broadcast. */
  recipientAddress?: string;
  /** True when the recipient is a BIP-352 silent-payment (`tsp1…`) address. */
  silent?: boolean;
  /** Amount in satoshis; signed into the authorization digest. */
  amountSats?: number;
  /** Real cryptographic result, populated after a live signing round. */
  proof?: SigningProof;
  /** On-chain txid, populated once the approval is broadcast. */
  txid?: string;
  /** Policy-change approvals (kind:"role"): the full new policy to reshare into. */
  proposedPolicy?: PolicyConfig;
  /** Precomputed human-readable diff vs. the policy at propose time. */
  policyDiff?: PolicyDiffItem[];
  /** The vault policyVersion this proposal was authored against (lost-update guard). */
  basePolicyVersion?: number;
};

export type SigningProof = {
  digest: string;
  signature: string;
  groupKey: string;
  signers: number[];
  verified: boolean;
};

// ---- Backend shapes (subset, mirrors app/api/_lib/btech.ts) ----

export type DemoReport = {
  vault_id: string;
  network: string;
  group_xonly_public_key: string;
  receive_path: string;
  receive_address: string;
  signers: number[];
  authorization_digest: string;
  aggregate_signature: string;
  verified: boolean;
  remaining_relay_events: number;
};

export type InvitedParticipant = {
  participant_id: number;
  label: string;
  role: string;
  status: "Invited" | "Joined";
};

export type VaultPolicyGroup = {
  group_id: string;
  chat_name: string;
  rank: number;
  required: number;
  total: number;
  participant_ids: number[];
  joined_ids: number[];
};

export type SessionProofReport = {
  session_id: string;
  invites: InvitedParticipant[];
  vault_policy_groups: VaultPolicyGroup[];
  all_invites_joined: boolean;
  tss_boundary: string;
  tss: SignatureProofWire;
  htss: SignatureProofWire;
  invalid_htss_signer_set_rejected: boolean;
  high_rank_cannot_substitute_low_group: boolean;
  receive_address: string;
};

export type SignatureProofWire = {
  scheme: string;
  threshold: string;
  group_xonly_public_key: string;
  signer_set: number[];
  digest: string;
  aggregate_signature: string;
  verified: boolean;
};

export type WalletState = {
  demo: DemoReport;
  session: SessionProofReport;
};
