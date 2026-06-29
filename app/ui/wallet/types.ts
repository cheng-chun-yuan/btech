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
  /** Real group x-only public key (live vault only). */
  groupKey?: string;
  tiers: Tier[];
  messages: ChatMessage[];
};

export type ApprovalStatus = "pending" | "ready" | "broadcast" | "rejected";
export type ApprovalKind = "send" | "role";

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
  signed: number;
  youSigned: boolean;
  status: ApprovalStatus;
  /** Set when this approval is bound to the live DKGKit vault. */
  live?: boolean;
  /** Full destination address (not the truncated `dest`); signed into the digest. */
  recipientAddress?: string;
  /** Amount in satoshis; signed into the authorization digest. */
  amountSats?: number;
  /** Real cryptographic result, populated after a live signing round. */
  proof?: SigningProof;
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
