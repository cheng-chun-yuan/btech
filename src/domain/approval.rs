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

    pub fn digest(&self) -> [u8; 32] {
        self.message.digest()
    }

    pub fn canonical_text(&self) -> String {
        self.message.canonical_text()
    }
}
