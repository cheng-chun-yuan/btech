use btech::WalletApp;

fn main() -> anyhow::Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--session-proof-json") {
        let session_id = args
            .windows(2)
            .find_map(|window| (window[0] == "--session-id").then(|| window[1].clone()))
            .unwrap_or_else(|| "btech-session-proof".to_string());
        let report = WalletApp::run_session_proof(session_id)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    let mut app = WalletApp::demo()?;
    let report = app.run_demo()?;

    if args.iter().any(|arg| arg == "--json") {
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }

    println!("BTech DKGKit wallet demo");
    println!("vault id: {}", report.vault_id);
    println!("network: {}", report.network);
    println!("group x-only public key: {}", report.group_xonly_public_key);
    println!("receive path: {}", report.receive_path);
    println!("receive address: {}", report.receive_address);
    println!("signers: {:?}", report.signers);
    println!("authorization digest: {}", report.authorization_digest);
    println!("aggregate signature: {}", report.aggregate_signature);
    println!("aggregate signature verified: {}", report.verified);
    println!(
        "remaining local relay events: {}",
        report.remaining_relay_events
    );

    Ok(())
}
