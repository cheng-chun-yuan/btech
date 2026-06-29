use std::collections::BTreeMap;

use crate::domain::approval::ApprovalRequest;

#[derive(Debug, Default)]
pub struct InMemoryRepository {
    approvals: BTreeMap<String, ApprovalRequest>,
}

impl InMemoryRepository {
    pub fn save_approval(&mut self, approval: ApprovalRequest) {
        self.approvals.insert(approval.id.clone(), approval);
    }

    pub fn approval(&self, approval_id: &str) -> Option<&ApprovalRequest> {
        self.approvals.get(approval_id)
    }

    pub fn approval_count(&self) -> usize {
        self.approvals.len()
    }
}
