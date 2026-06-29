use dkgkit_sdk::{
    GroupThresholdRequirement, GroupedThresholdConfig, ParticipantId, RankedParticipant, Result,
};

pub fn grouped_config_123_of_235() -> Result<GroupedThresholdConfig> {
    GroupedThresholdConfig::new(
        vec![
            RankedParticipant::new(1, 0, Some("c-level-a".to_string()))?,
            RankedParticipant::new(2, 0, Some("c-level-b".to_string()))?,
            RankedParticipant::new(3, 1, Some("manager-a".to_string()))?,
            RankedParticipant::new(4, 1, Some("manager-b".to_string()))?,
            RankedParticipant::new(5, 1, Some("manager-c".to_string()))?,
            RankedParticipant::new(6, 2, Some("operator-a".to_string()))?,
            RankedParticipant::new(7, 2, Some("operator-b".to_string()))?,
            RankedParticipant::new(8, 2, Some("operator-c".to_string()))?,
            RankedParticipant::new(9, 2, Some("operator-d".to_string()))?,
            RankedParticipant::new(10, 2, Some("operator-e".to_string()))?,
        ],
        vec![
            GroupThresholdRequirement::new(0, 1, 2)?,
            GroupThresholdRequirement::new(1, 2, 3)?,
            GroupThresholdRequirement::new(2, 3, 5)?,
        ],
    )
}

pub fn participant_id(value: u16) -> Result<ParticipantId> {
    ParticipantId::new(value)
}

pub fn demo_valid_signer_set() -> Result<Vec<ParticipantId>> {
    Ok(vec![
        participant_id(1)?,
        participant_id(3)?,
        participant_id(4)?,
        participant_id(6)?,
        participant_id(7)?,
        participant_id(8)?,
    ])
}

pub fn demo_invalid_signer_set() -> Result<Vec<ParticipantId>> {
    Ok(vec![
        participant_id(1)?,
        participant_id(3)?,
        participant_id(6)?,
        participant_id(7)?,
        participant_id(8)?,
    ])
}
