use dkgkit_sdk::bitcoin::BitcoinAuthorizationMessage;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub message: BitcoinAuthorizationMessage,
}

impl ApprovalRequest {
    pub fn payment(
        id: impl Into<String>,
        network: impl Into<String>,
        recipient: impl Into<String>,
        amount_sats: u64,
        memo: impl Into<String>,
    ) -> Self {
        let id = id.into();
        Self {
            message: BitcoinAuthorizationMessage {
                network: network.into(),
                action: "approve-payment".to_string(),
                recipient: Some(recipient.into()),
                amount_sats: Some(amount_sats),
                memo: Some(memo.into()),
                nonce: id.clone(),
            },
            id,
        }
    }

    /// Authorization for a policy change. The new policy's fingerprint is bound
    /// into the digest (via the memo field) so the ratifiers' aggregate signature
    /// attests to the exact new policy being reshared into.
    pub fn policy_change(
        id: impl Into<String>,
        network: impl Into<String>,
        new_policy_fingerprint: impl Into<String>,
    ) -> Self {
        let id = id.into();
        Self {
            message: BitcoinAuthorizationMessage {
                network: network.into(),
                action: "approve-policy-change".to_string(),
                recipient: None,
                amount_sats: None,
                memo: Some(new_policy_fingerprint.into()),
                nonce: id.clone(),
            },
            id,
        }
    }

    pub fn digest(&self) -> [u8; 32] {
        self.message.digest()
    }

    pub fn canonical_text(&self) -> String {
        self.message.canonical_text()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_change_digest_binds_the_new_policy() {
        let a = ApprovalRequest::policy_change("appr-1", "regtest", "fingerprint-A");
        let b = ApprovalRequest::policy_change("appr-1", "regtest", "fingerprint-B");
        assert_ne!(a.digest(), b.digest(), "different new policies must differ");
        assert_eq!(a.message.action, "approve-policy-change");
    }
}
