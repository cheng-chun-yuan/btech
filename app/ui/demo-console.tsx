"use client";

import { useMemo, useState } from "react";

type DemoReport = {
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

type InviteStatus = "Invited" | "Joined";

type InvitedParticipant = {
  participant_id: number;
  label: string;
  role: string;
  status: InviteStatus;
};

type VaultPolicyGroup = {
  group_id: string;
  chat_name: string;
  rank: number;
  required: number;
  total: number;
  participant_ids: number[];
  joined_ids: number[];
};

type SignatureProof = {
  scheme: string;
  threshold: string;
  group_xonly_public_key: string;
  signer_set: number[];
  digest: string;
  aggregate_signature: string;
  verified: boolean;
};

type SessionProofReport = {
  session_id: string;
  invites: InvitedParticipant[];
  vault_policy_groups: VaultPolicyGroup[];
  all_invites_joined: boolean;
  tss_boundary: string;
  tss: SignatureProof;
  htss: SignatureProof;
  invalid_htss_signer_set_rejected: boolean;
  high_rank_cannot_substitute_low_group: boolean;
  receive_address: string;
};

type DemoState =
  | { status: "idle"; report?: undefined; error?: undefined }
  | { status: "running"; report?: DemoReport; error?: undefined }
  | { status: "ready"; report: DemoReport; error?: undefined }
  | { status: "error"; report?: DemoReport; error: string };

type ProofState =
  | { status: "idle"; report?: undefined; error?: undefined }
  | { status: "running"; report?: SessionProofReport; error?: undefined }
  | { status: "ready"; report: SessionProofReport; error?: undefined }
  | { status: "error"; report?: SessionProofReport; error: string };

type ViewKey = "overview" | "approvals" | "chats" | "plan";

const chatSummaries = [
  {
    id: "treasury",
    name: "#treasury-ops",
    members: 7,
    balance: "100.13 BTC",
    preview: "Ana Rivera: Vendor payment proof is queued.",
    quorum: "1/2 + 2/3 + 3/5",
  },
  {
    id: "cold",
    name: "#cold-reserve",
    members: 5,
    balance: "420.00 BTC",
    preview: "Maya Ksiazek: Keep the reserve threshold strict.",
    quorum: "3/5",
  },
  {
    id: "petty",
    name: "#ops-petty-cash",
    members: 4,
    balance: "3.20 BTC",
    preview: "Jin Lee: Signed. Have a good trip.",
    quorum: "2/3",
  },
];

const defaultInvites: InvitedParticipant[] = [
  { participant_id: 1, label: "Alice", role: "Founder", status: "Invited" },
  { participant_id: 2, label: "Bob", role: "Security", status: "Invited" },
  { participant_id: 3, label: "Carol", role: "Finance", status: "Invited" },
  { participant_id: 4, label: "Dina", role: "Manager", status: "Invited" },
  { participant_id: 5, label: "Evan", role: "Manager", status: "Invited" },
  { participant_id: 6, label: "Faye", role: "Operator", status: "Invited" },
  { participant_id: 7, label: "Gus", role: "Operator", status: "Invited" },
  { participant_id: 8, label: "Hana", role: "Operator", status: "Invited" },
  { participant_id: 9, label: "Iris", role: "Operator", status: "Invited" },
  { participant_id: 10, label: "Jules", role: "Operator", status: "Invited" },
];

const defaultPolicyGroups: VaultPolicyGroup[] = [
  {
    group_id: "c-level",
    chat_name: "C-level approvals",
    rank: 0,
    required: 1,
    total: 2,
    participant_ids: [1, 2],
    joined_ids: [],
  },
  {
    group_id: "managers",
    chat_name: "Manager review",
    rank: 1,
    required: 2,
    total: 3,
    participant_ids: [3, 4, 5],
    joined_ids: [],
  },
  {
    group_id: "operators",
    chat_name: "Operator execution",
    rank: 2,
    required: 3,
    total: 5,
    participant_ids: [6, 7, 8, 9, 10],
    joined_ids: [],
  },
];

export default function DemoConsole() {
  const [state, setState] = useState<DemoState>({ status: "idle" });
  const [proofState, setProofState] = useState<ProofState>({ status: "idle" });
  const [sessionId, setSessionId] = useState("treasury-session-001");
  const [view, setView] = useState<ViewKey>("chats");
  const [activeChatId, setActiveChatId] = useState(chatSummaries[0].id);
  const [draft, setDraft] = useState("");
  const [sentMessages, setSentMessages] = useState<string[]>([]);
  const [showPolicy, setShowPolicy] = useState(true);

  async function runDemo() {
    setState((current) => ({ status: "running", report: current.report }));
    try {
      const response = await fetch("/api/demo", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Demo failed");
      setState({ status: "ready", report: payload });
    } catch (error) {
      setState((current) => ({
        status: "error",
        report: current.report,
        error: error instanceof Error ? error.message : "Demo failed",
      }));
    }
  }

  async function runSessionProof() {
    setProofState((current) => ({ status: "running", report: current.report }));
    try {
      const response = await fetch("/api/session-proof", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Session proof failed");
      setProofState({ status: "ready", report: payload });
    } catch (error) {
      setProofState((current) => ({
        status: "error",
        report: current.report,
        error: error instanceof Error ? error.message : "Session proof failed",
      }));
    }
  }

  const reportRows = useMemo(() => {
    if (!state.report) return [];
    return [
      ["Vault", state.report.vault_id],
      ["Receive path", state.report.receive_path],
      ["Receive address", state.report.receive_address],
      ["Approval digest", state.report.authorization_digest],
      ["Aggregate signature", state.report.aggregate_signature],
    ];
  }, [state.report]);

  const groups = proofState.report?.vault_policy_groups ?? defaultPolicyGroups;
  const invites = proofState.report?.invites ?? defaultInvites;
  const proofReady = Boolean(proofState.report?.htss.verified);
  const dkgReady = Boolean(state.report?.verified);
  const approvalCount = proofReady ? 1 : 2;
  const activeChat = chatSummaries.find((chat) => chat.id === activeChatId) ?? chatSummaries[0];
  const chatSub = `${activeChat.members} members · secured by a ${activeChat.quorum} vault`;

  function openChat(chatId: string) {
    setActiveChatId(chatId);
    setView("chats");
    setShowPolicy(true);
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text) return;
    setSentMessages((current) => [...current, text]);
    setDraft("");
  }

  function openApproval() {
    setView("approvals");
    setShowPolicy(true);
  }

  return (
    <main className="wallet-shell">
      <aside className="wallet-sidebar" aria-label="Wallet navigation">
        <div className="brand-block">
          <div className="brand-mark">B</div>
          <div>
            <h1>BTech</h1>
            <p>TREASURY VAULT</p>
          </div>
        </div>

        <nav className="main-nav" aria-label="Primary">
          <button className={view === "overview" ? "is-active" : ""} onClick={() => setView("overview")} type="button">
            Overview
          </button>
          <button className={view === "approvals" ? "is-active" : ""} onClick={openApproval} type="button">
            Approvals <span>{approvalCount}</span>
          </button>
          <button className={view === "chats" ? "is-active" : ""} onClick={() => setView("chats")} type="button">
            Chats
          </button>
          <button className={view === "plan" ? "is-active" : ""} onClick={() => setView("plan")} type="button">
            Plan
          </button>
        </nav>

        <div className="side-section">
          <p>CHANNELS</p>
          {chatSummaries.map((chat) => (
            <button
              className={chat.id === activeChatId && view === "chats" ? "side-link is-active" : "side-link"}
              key={chat.id}
              onClick={() => openChat(chat.id)}
              type="button"
            >
              {chat.name}
            </button>
          ))}
        </div>

        <div className="side-section">
          <p>DIRECT</p>
          <button className={activeChatId === "direct-ana" ? "direct-link is-active" : "direct-link"} onClick={() => openChat("direct-ana")} type="button">
            <span>AR</span>
            Ana Rivera
          </button>
          <button className={activeChatId === "direct-maya" ? "direct-link muted is-active" : "direct-link muted"} onClick={() => openChat("direct-maya")} type="button">
            <span>MK</span>
            Maya Ksiazek
          </button>
        </div>

        <div className="custody-card">
          <span>SELF-CUSTODY</span>
          <p>No keys held by BTech. Your quorum, your coins.</p>
        </div>
      </aside>

      <section className="wallet-main">
        <header className="wallet-topbar">
          <div>
            <h2>{viewTitle(view, activeChat.name)}</h2>
            <p>{view === "chats" ? chatSub : viewSubtitle(view)}</p>
          </div>
          <div className="topbar-actions">
            <span className="price-pill">
              <i /> BTC $64,210
            </span>
            <button
              aria-busy={state.status === "running"}
              className="primary-button"
              disabled={state.status === "running"}
              onClick={runDemo}
              type="button"
            >
              {state.status === "running" ? "Running flow" : "New transfer"}
            </button>
          </div>
        </header>

        <div className="chat-workspace">
          {(state.status === "error" || proofState.status === "error") && (
            <div className="error-stack">
              {state.status === "error" ? <p>{state.error}</p> : null}
              {proofState.status === "error" ? <p>{proofState.error}</p> : null}
            </div>
          )}

          <section className="chat-detail" aria-label="Treasury operations chat">
            {view !== "chats" ? (
              <UtilityView
                approvalCount={approvalCount}
                dkgReady={dkgReady}
                onCreateSession={runSessionProof}
                onNewTransfer={runDemo}
                proofReady={proofReady}
                view={view}
              />
            ) : (
              <>
            <div className="chat-head">
              <div>
                <h3>{activeChat.name}</h3>
                <p>Connected · {chatSub}</p>
              </div>
              <button className="vault-policy-toggle" onClick={() => setShowPolicy((current) => !current)} type="button">
                {activeChat.quorum} Vault policy
              </button>
            </div>

            <div className="messages">
              <Message
                color="orange"
                initials="AR"
                meta="npub1qz...ops · 09:24"
                name="Ana Rivera"
                text="Vendor payment to Blockstream is queued, 2.4 BTC. Please sign when you have a moment."
              />
              <Message
                color="blue"
                initials="MK"
                meta="npub1c8...ceo · 09:31"
                name="Maya Ksiazek"
                signed
                text="Reviewed the destination. It is inside the approved vendor policy."
              />
              {sentMessages.map((message, index) => (
                <Message
                  color="orange"
                  initials="DK"
                  key={`${message}-${index}`}
                  meta="local signer · now"
                  name="Dana Klein"
                  signed={dkgReady}
                  text={message}
                />
              ))}

              {showPolicy ? <section className="vault-policy-card">
                <div className="policy-card-head">
                  <div>
                    <h4>Vault policy</h4>
                    <p>TSS is separate. HTSS enforces rank-specific group quorums.</p>
                  </div>
                  <span>{proofReady ? "PROOF READY" : "LOCAL PROOF"}</span>
                </div>

                <div className="session-form">
                  <label>
                    <span>Session ID</span>
                    <input
                      disabled={proofState.status === "running"}
                      onChange={(event) => setSessionId(event.target.value)}
                      value={sessionId}
                    />
                  </label>
                  <button
                    aria-busy={proofState.status === "running"}
                    className="secondary-button"
                    disabled={proofState.status === "running"}
                    onClick={runSessionProof}
                    type="button"
                  >
                    {proofState.status === "running" ? "Creating proof" : "Create session"}
                  </button>
                </div>

                <div className="policy-chat-grid" aria-label="Vault policy group chats">
                  {groups.map((group) => (
                    <PolicyGroupCard group={group} invites={invites} key={group.group_id} />
                  ))}
                </div>
              </section> : null}

              <section className="proof-drawer">
                <div>
                  <strong>Cryptographic proof</strong>
                  <span>{proofReady ? "strict" : "pending"}</span>
                </div>
                {proofState.report ? (
                  <div className="proof-stack">
                    <BoundaryNote text={proofState.report.tss_boundary} />
                    <ProofCard proof={proofState.report.tss} />
                    <ProofCard proof={proofState.report.htss} />
                    <div className="rejection-card">
                      <span>Policy rejection</span>
                      <strong>High rank cannot replace low group quorum</strong>
                      <p>
                        Invalid HTSS signer set rejected:{" "}
                        {proofState.report.invalid_htss_signer_set_rejected ? "true" : "false"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p>Create a session to prove base TSS signing, grouped HTSS signing, and strict rank rejection.</p>
                )}
              </section>
            </div>

            <div className="chat-composer">
              <button onClick={runDemo} type="button">B</button>
              <input
                aria-label="Message treasury ops"
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendDraft();
                }}
                placeholder={`Message ${activeChat.name}`}
                value={draft}
              />
              <button className="send-button" onClick={runDemo} type="button">
                Sign
              </button>
            </div>
            <p className="relay-note">Signed with your local DKGKit proof. No hosted key material.</p>
            </>
            )}
          </section>

          <aside className="vault-rail" aria-label="Vault proof output">
            <div className="rail-title">APPROVAL</div>
            <button className="approval-card zip-card rail-action" onClick={openApproval} type="button">
              <div>
                <strong>Vendor payment proof</strong>
                <span>{proofReady ? "QUORUM REACHED" : "NEEDS SIGNATURES"}</span>
              </div>
              <p>Policy: 1/2 C-level + 2/3 managers + 3/5 operators</p>
              <div className="pip-row" aria-hidden="true">
                {Array.from({ length: 6 }).map((_, index) => (
                  <i className={proofReady || index < 2 ? "filled" : ""} key={index} />
                ))}
              </div>
            </button>
            <div className="amount-card">
              <span>TOTAL BALANCE</span>
              <strong>100.13 BTC</strong>
              <p>{state.report?.receive_address ?? "Run New transfer to derive a Taproot receive address."}</p>
            </div>

            <div className="status-list">
              <StatusRow label="Session proof" value={proofReady ? "Verified" : "Waiting"} />
              <StatusRow label="DKG run" value={dkgReady ? "Verified" : "Idle"} />
              <StatusRow label="Relay events" value={state.report ? String(state.report.remaining_relay_events) : "0"} />
            </div>

            {reportRows.length > 0 ? (
              <dl className="output-list">
                {reportRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="empty-state">
                <strong>No DKG output yet</strong>
                <p>Use New transfer to derive the receive address and verify an approval signature.</p>
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function viewTitle(view: ViewKey, chatName: string) {
  if (view === "overview") return "Overview";
  if (view === "approvals") return "Approvals";
  if (view === "plan") return "Plan";
  return chatName;
}

function viewSubtitle(view: ViewKey) {
  if (view === "overview") return "Treasury at a glance";
  if (view === "approvals") return "Transactions awaiting a signing quorum";
  if (view === "plan") return "BTech subscription and signing limits";
  return "";
}

function UtilityView({
  approvalCount,
  dkgReady,
  onCreateSession,
  onNewTransfer,
  proofReady,
  view,
}: {
  approvalCount: number;
  dkgReady: boolean;
  onCreateSession: () => void;
  onNewTransfer: () => void;
  proofReady: boolean;
  view: ViewKey;
}) {
  if (view === "approvals") {
    return (
      <div className="utility-view">
        <div className="utility-head">
          <h3>Approvals</h3>
          <p>{approvalCount} transaction{approvalCount === 1 ? "" : "s"} awaiting local action.</p>
        </div>
        <button className="approval-card utility-action" onClick={onCreateSession} type="button">
          <div>
            <strong>Vendor payment proof</strong>
            <span>{proofReady ? "QUORUM REACHED" : "NEEDS SIGNATURES"}</span>
          </div>
          <p>Creates the session, invites every group, proves TSS separately, then signs HTSS with rank-specific quorum.</p>
          <div className="pip-row" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, index) => (
              <i className={proofReady || index < 2 ? "filled" : ""} key={index} />
            ))}
          </div>
        </button>
        <button className="secondary-button fit-button" onClick={onNewTransfer} type="button">
          Broadcast signed transfer
        </button>
      </div>
    );
  }

  if (view === "plan") {
    return (
      <div className="utility-view plan-grid">
        {["Starter", "Business", "Enterprise"].map((plan) => (
          <article className={plan === "Business" ? "plan-card is-current" : "plan-card"} key={plan}>
            <span>{plan === "Business" ? "CURRENT" : "AVAILABLE"}</span>
            <h3>{plan}</h3>
            <p>
              {plan === "Starter"
                ? "One chat with a simple vault."
                : plan === "Business"
                  ? "Unlimited chats with hierarchical vault policy."
                  : "Dedicated infra and managed key ceremonies."}
            </p>
            <button className={plan === "Business" ? "primary-button" : "secondary-button"} type="button">
              {plan === "Business" ? "Current plan" : "Select plan"}
            </button>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="utility-view overview-grid">
      <article className="amount-card">
        <span>TOTAL ACROSS VAULTS</span>
        <strong>523.33 BTC</strong>
        <p>Three group vaults are available from the sidebar. Each opens the same policy-aware chat surface.</p>
      </article>
      <article className="amount-card">
        <span>PROOF STATUS</span>
        <strong>{proofReady ? "verified" : "waiting"}</strong>
        <p>{dkgReady ? "DKGKit has derived a receive address and verified a signing digest." : "Run New transfer to derive the first address."}</p>
      </article>
      <button className="primary-button fit-button" onClick={onNewTransfer} type="button">
        New transfer
      </button>
    </div>
  );
}

function Message({
  color,
  initials,
  meta,
  name,
  signed,
  text,
}: {
  color: "orange" | "blue";
  initials: string;
  meta: string;
  name: string;
  signed?: boolean;
  text: string;
}) {
  return (
    <article className="message-row">
      <span className={`avatar ${color}`}>{initials}</span>
      <div>
        <div className="message-meta">
          <strong>{name}</strong>
          <em>{meta}</em>
        </div>
        {signed ? <b>SIGNED EVENT</b> : null}
        <p>{text}</p>
      </div>
    </article>
  );
}

function PolicyGroupCard({
  group,
  invites,
}: {
  group: VaultPolicyGroup;
  invites: InvitedParticipant[];
}) {
  return (
    <article className="policy-chat">
      <div className="policy-chat-head">
        <div>
          <strong>{group.chat_name}</strong>
          <p>
            Rank {group.rank} · {group.required} of {group.total}
          </p>
        </div>
        <span>
          {group.joined_ids.length}/{group.total}
        </span>
      </div>
      <div className="member-strip">
        {group.participant_ids.map((id) => {
          const invite = invites.find((item) => item.participant_id === id);
          const joined = group.joined_ids.includes(id);
          return (
            <div className={joined ? "member-chip joined" : "member-chip"} key={id}>
              <span>{id}</span>
              <p>{invite?.label ?? `P${id}`}</p>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function BoundaryNote({ text }: { text: string }) {
  return (
    <div className="boundary-note">
      <span>TSS and HTSS boundary</span>
      <p>{text}</p>
    </div>
  );
}

function ProofCard({ proof }: { proof: SignatureProof }) {
  return (
    <article className="proof-card">
      <div>
        <span>{proof.scheme}</span>
        <strong>{proof.verified ? "Signature verified" : "Not verified"}</strong>
      </div>
      <dl>
        <div>
          <dt>Threshold</dt>
          <dd>{proof.threshold}</dd>
        </div>
        <div>
          <dt>Signers</dt>
          <dd>[{proof.signer_set.join(", ")}]</dd>
        </div>
        <div>
          <dt>Group key</dt>
          <dd>{proof.group_xonly_public_key}</dd>
        </div>
        <div>
          <dt>Digest</dt>
          <dd>{proof.digest}</dd>
        </div>
      </dl>
    </article>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="status-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
